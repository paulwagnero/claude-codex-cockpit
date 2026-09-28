'use strict';
// Claude Code rate limits, read from the per-session snapshots that
// bin/statusline.js writes into ~/.claude-codex-cockpit/claude-statusline/.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { CLAUDE_WINDOWS, toNumber } = require('../lib/usage');

// Observations whose resets_at differ by less than this belong to the same window.
const SAME_WINDOW_TOLERANCE_SEC = 120;
// Readings kept per window for the recent-pace projection (lib/usage.js looks back 30 min).
const HISTORY_MS = 45 * 60 * 1000;

// Every session's statusline carries the numbers from that session's last API
// response, and an idle session keeps re-sending old ones. So for each window
// the latest window wins (largest resets_at), and inside one window usage only
// grows, so the highest used_percentage is the freshest.
function aggregate(snapshots) {
  const result = { five_hour: null, seven_day: null, updatedAt: null };
  for (const [name, windowSeconds] of Object.entries(CLAUDE_WINDOWS)) {
    let best = null;
    for (const snap of snapshots) {
      const w = snap?.payload?.rate_limits?.[name];
      if (!w) continue;
      const usedPercent = toNumber(w.used_percentage);
      const resetsAt = toNumber(w.resets_at);
      if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAt)) continue;
      const cand = {
        usedPercent,
        resetsAt,
        windowSeconds,
        observedAt: snap.rateLimitsAt || snap.writtenAt || null,
        sessionId: snap.payload.session_id || null,
      };
      if (!best || cand.resetsAt > best.resetsAt + SAME_WINDOW_TOLERANCE_SEC) {
        best = cand;
      } else if (
        cand.resetsAt >= best.resetsAt - SAME_WINDOW_TOLERANCE_SEC &&
        (cand.usedPercent > best.usedPercent || (cand.usedPercent === best.usedPercent && cand.observedAt > best.observedAt))
      ) {
        best = cand;
      }
    }
    result[name] = best;
    if (best?.observedAt > result.updatedAt) result.updatedAt = best.observedAt;
  }
  return result;
}

// oauthAccount in ~/.claude.json: claude_pro -> "pro", claude_max with
// default_claude_max_20x -> "max 20x".
function planLabel(organizationType, rateLimitTier) {
  if (!organizationType) return null;
  const base = String(organizationType).replace(/^claude_/, '').replace(/_/g, ' ');
  const multiplier = /(\d+x)$/.exec(String(rateLimitTier || ''))?.[1];
  return multiplier ? `${base} ${multiplier}` : base;
}

class ClaudeUsageSource extends EventEmitter {
  constructor({ dir, accountFile = null, rescanMs = 15000, pruneAfterMs = 8 * 24 * 3600 * 1000 }) {
    super();
    this.dir = dir;
    this.accountFile = accountFile;
    this.account = { checkedAt: 0, mtimeMs: null, plan: null };
    this.rescanMs = rescanMs;
    this.pruneAfterMs = pruneAfterMs; // nothing older than a week can still matter
    this.files = new Map(); // file name -> { mtimeMs, size, snapshot }
    this.lastKnown = {};
    this.history = {}; // window name -> { resetsAt, points: [[atMs, used], ...] }
    this.usage = aggregate([]);
    this.key = JSON.stringify(this.usage);
    this.watcher = null;
  }

  // fs.watch gives near-instant updates; the periodic rescan covers missed
  // events and re-arms the watcher if the folder was deleted.
  start() {
    this.rescan();
    // The periodic pass re-reads every file: two writes with the same size can
    // share an mtime (Windows timestamps are coarse), which the quick check misses.
    this.interval = setInterval(() => this.rescan(Date.now(), { force: true }), this.rescanMs);
  }

  stop() {
    clearInterval(this.interval);
    clearTimeout(this.debounce);
    this.unwatch();
  }

  watch() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.watcher = fs.watch(this.dir, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.rescan(), 40);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch {
      this.watcher = null;
    }
  }

  unwatch() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  // Claude only reports the current reading, so the history for the recent pace
  // is collected here, one point per new API response, per window.
  remember(name, w, now) {
    let h = this.history[name];
    if (!h || Math.abs(h.resetsAt - w.resetsAt) > SAME_WINDOW_TOLERANCE_SEC) h = this.history[name] = { resetsAt: w.resetsAt, points: [] };
    const last = h.points[h.points.length - 1];
    if (w.observedAt && (!last || w.observedAt > last[0])) h.points.push([w.observedAt, w.usedPercent]);
    // Drop old points, but keep the newest one from before the cut: it is where
    // the lookback starts from.
    const cut = now - HISTORY_MS;
    while (h.points.length > 1 && h.points[1][0] <= cut) h.points.shift();
    return h.points.slice();
  }

  // Claude Code rewrites ~/.claude.json often and it can be large, so look at
  // most once a minute and parse only when it changed.
  readPlan(now) {
    if (!this.accountFile || now - this.account.checkedAt < 60_000) return this.account.plan;
    this.account.checkedAt = now;
    try {
      const st = fs.statSync(this.accountFile);
      if (st.mtimeMs !== this.account.mtimeMs) {
        const acct = JSON.parse(fs.readFileSync(this.accountFile, 'utf8')).oauthAccount || {};
        this.account.plan = planLabel(acct.organizationType, acct.organizationRateLimitTier || acct.userRateLimitTier);
        this.account.mtimeMs = st.mtimeMs;
      }
    } catch {
      // Missing, or caught mid-write: keep the last value and retry next minute.
    }
    return this.account.plan;
  }

  rescan(now = Date.now(), { force = false } = {}) {
    if (!this.watcher) this.watch();
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // Recreated by watch() on the next pass.
    }
    const seen = new Set();
    for (const name of names) {
      const full = path.join(this.dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const age = now - st.mtimeMs;
      if (name.endsWith('.tmp')) {
        if (age > 60_000) tryUnlink(full); // left behind by a cancelled statusline run
        continue;
      }
      if (!name.endsWith('.json')) continue;
      if (age > this.pruneAfterMs) {
        tryUnlink(full);
        continue;
      }
      seen.add(name);
      const cached = this.files.get(name);
      if (!force && cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      try {
        this.files.set(name, { mtimeMs: st.mtimeMs, size: st.size, snapshot: JSON.parse(fs.readFileSync(full, 'utf8')) });
      } catch {
        // Unreadable right now; retried on the next pass.
      }
    }
    for (const name of [...this.files.keys()]) if (!seen.has(name)) this.files.delete(name);

    const usage = aggregate([...this.files.values()].map((f) => f.snapshot));
    for (const name of Object.keys(CLAUDE_WINDOWS)) {
      const known = this.lastKnown[name];
      if (usage[name]) this.lastKnown[name] = usage[name];
      // Claude Code drops a window from the statusline once it resets. Keep the
      // expired one so the UI can say "reset" rather than "no data".
      else if (known && known.resetsAt * 1000 <= now) usage[name] = known;
      if (usage[name]) usage[name] = { ...usage[name], recent: this.remember(name, usage[name], now) };
    }
    usage.plan = this.readPlan(now);
    const key = JSON.stringify(usage);
    if (key !== this.key) {
      this.key = key;
      this.usage = usage;
      this.emit('change', usage);
    }
  }
}

function tryUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

module.exports = { aggregate, planLabel, ClaudeUsageSource, SAME_WINDOW_TOLERANCE_SEC };
