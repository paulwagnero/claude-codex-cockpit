'use strict';
// Codex usage, read from the rollout logs Codex writes for every session:
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (CODEX_HOME defaults to ~/.codex).
// Each API turn appends an event_msg/token_count line carrying a rate_limits object.
//
// Codex keeps several limit buckets in the same stream. Seen on a Plus plan:
//   limit_id "codex"                 primary 300 min, secondary 10080 min: the real limit
//   limit_id "premium"               primary and secondary null: nothing to show
//   limit_id "base_model_inference"  ("gpt-reserve") primary 10080 min, no secondary
// So "take the newest line" is wrong: that line is often the empty premium one,
// and a reserve line would put a weekly number into the 5-hour bar.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { toNumber } = require('../lib/usage');

const MAIN_LIMIT = 'codex';
const FILES_TO_SCAN = 5; // most recently modified rollouts; resumed sessions write into old day folders
const HISTORY_MS = 45 * 60 * 1000; // readings kept for the recent-pace projection
const FIRST_CHUNK = 256 * 1024;
const MAX_SCAN = 16 * 1024 * 1024; // rollouts reach tens of MB
const DAY_SEC = 24 * 3600;

// One JSONL line -> { at, limitId, limitName, planType, reachedType, windows }, or
// null when it is not a token_count event or none of its windows carry numbers.
function parseEntry(line) {
  if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null; // a line Codex is still writing
  }
  if (obj?.type !== 'event_msg' || obj.payload?.type !== 'token_count') return null;
  const rl = obj.payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const at = Date.parse(obj.timestamp);
  const windows = [rl.primary, rl.secondary].map((w) => parseWindow(w, at)).filter(Boolean);
  if (!windows.length) return null;
  return {
    at: Number.isFinite(at) ? at : null,
    limitId: rl.limit_id ?? null,
    limitName: rl.limit_name ?? null,
    planType: rl.plan_type ?? null,
    reachedType: rl.rate_limit_reached_type ?? null,
    windows,
  };
}

function parseWindow(w, atMs) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = toNumber(w.used_percent);
  let resetsAt = toNumber(w.resets_at);
  // Older Codex builds wrote resets_in_seconds, relative to the event.
  const inSec = toNumber(w.resets_in_seconds);
  if (!Number.isFinite(resetsAt) && Number.isFinite(inSec) && Number.isFinite(atMs)) {
    resetsAt = Math.round(atMs / 1000 + inSec);
  }
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAt)) return null;
  const minutes = toNumber(w.window_minutes);
  return { usedPercent, resetsAt, windowSeconds: minutes > 0 ? minutes * 60 : null };
}

// Place windows by length, not by primary/secondary: the reserve bucket's
// primary is a weekly window.
function toSlots(windows) {
  const slots = { fiveHour: null, weekly: null };
  windows.forEach((w, i) => {
    const slot = w.windowSeconds ? (w.windowSeconds <= DAY_SEC ? 'fiveHour' : 'weekly') : i === 0 ? 'fiveHour' : 'weekly';
    if (!slots[slot]) slots[slot] = w;
  });
  return slots;
}

// Newest usable entry per limit id in one rollout, reading backwards from the
// end in growing chunks until the main limit turns up. The main limit's older
// readings in the same chunk ride along as `series` (newest first).
function scanFile(file) {
  const found = new Map();
  const series = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (let chunk = FIRST_CHUNK; ; chunk *= 4) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // starts mid-line
      series.length = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseEntry(lines[i]);
        if (!entry) continue;
        if (!found.has(entry.limitId)) found.set(entry.limitId, entry);
        if (entry.limitId === MAIN_LIMIT) series.push(entry);
      }
      if (found.has(MAIN_LIMIT) || start === 0 || chunk >= MAX_SCAN) break;
    }
  } catch {
    // Unreadable right now; the next pass retries.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const main = found.get(MAIN_LIMIT);
  if (main) main.series = series;
  return found;
}

// [[atMs, used], ...] oldest first for one slot of the main limit, same window
// as its newest reading, from the last HISTORY_MS.
function recentPoints(entry, slot) {
  const current = toSlots(entry.windows)[slot];
  if (!current || !Array.isArray(entry.series)) return undefined;
  const cut = entry.at - HISTORY_MS;
  const points = [];
  for (const e of entry.series) {
    const w = toSlots(e.windows)[slot];
    if (!w || Math.abs(w.resetsAt - current.resetsAt) > 120 || !Number.isFinite(e.at)) continue;
    points.push([e.at, w.usedPercent]);
    if (e.at <= cut) break; // the newest point before the cut is where the lookback starts
  }
  return points.reverse();
}

function listRollouts(sessionsDir) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  };
  walk(sessionsDir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Newest entry per limit id across files. Show the main Codex limit; fall back
// to another bucket only if the main one never appears.
function pickUsage(foundMaps) {
  const newest = new Map();
  for (const found of foundMaps) {
    for (const [id, entry] of found) {
      const cur = newest.get(id);
      if (!cur || entry.at > cur.at) newest.set(id, entry);
    }
  }
  if (!newest.size) return null;
  const main = newest.get(MAIN_LIMIT) || [...newest.values()].sort((a, b) => b.at - a.at)[0];
  const slots = toSlots(main.windows);
  for (const slot of ['fiveHour', 'weekly']) {
    const recent = recentPoints(main, slot);
    if (slots[slot] && recent) slots[slot] = { ...slots[slot], recent };
  }
  return {
    ...slots,
    updatedAt: main.at,
    limitId: main.limitId,
    limitName: main.limitName,
    planType: main.planType,
    reachedType: main.reachedType,
    otherLimits: [...newest.values()]
      .filter((e) => e !== main)
      .map((e) => ({ limitId: e.limitId, limitName: e.limitName, updatedAt: e.at, ...toSlots(e.windows) })),
  };
}

class CodexUsageSource extends EventEmitter {
  constructor({ home, rescanMs = 30000 }) {
    super();
    this.sessionsDir = path.join(home, 'sessions');
    this.rescanMs = rescanMs;
    this.files = new Map(); // path -> { mtimeMs, size, found }
    this.recentFiles = []; // newest rollouts, shared with the session list
    this.usage = null;
    this.key = 'null';
    this.watcher = null;
  }

  start() {
    this.rescan();
    this.interval = setInterval(() => this.rescan(), this.rescanMs);
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.debounce);
    this.unwatch();
  }

  // Recursive fs.watch is native on Windows. Codex appends constantly while it
  // works, so changes are coalesced.
  watch() {
    try {
      this.watcher = fs.watch(this.sessionsDir, { recursive: true }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.rescan(), 300);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch {
      this.watcher = null; // no sessions folder yet; the periodic rescan tries again
    }
  }

  unwatch() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  rescan() {
    if (!this.watcher) this.watch();
    this.recentFiles = listRollouts(this.sessionsDir).slice(0, 12);
    const recent = this.recentFiles.slice(0, FILES_TO_SCAN);
    for (const f of recent) {
      const cached = this.files.get(f.file);
      if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) continue;
      this.files.set(f.file, { mtimeMs: f.mtimeMs, size: f.size, found: scanFile(f.file) });
    }
    const keep = new Set(recent.map((f) => f.file));
    for (const file of [...this.files.keys()]) if (!keep.has(file)) this.files.delete(file);

    const usage = pickUsage([...this.files.values()].map((f) => f.found));
    const key = JSON.stringify(usage);
    if (key !== this.key) {
      this.key = key;
      this.usage = usage;
      this.emit('change', usage);
    }
  }
}

module.exports = { CodexUsageSource, parseEntry, scanFile, pickUsage, listRollouts, MAIN_LIMIT };
