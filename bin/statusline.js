#!/usr/bin/env node
'use strict';
// Claude Code statusLine command for cockpit.
//
// 1. Saves the stdin JSON to ~/.claude-codex-cockpit/claude-statusline/<session_id>.json
//    with an atomic rename. The cockpit server watches that folder. There is
//    no network call here: Claude Code cancels a statusline that is still
//    running when the next update fires, a closed localhost port can take a
//    second or two to refuse on Windows, and the numbers should still be on
//    disk for the panel when it starts later.
// 2. Prints the status line: the output of `statusLine.chain` from
//    ~/.claude-codex-cockpit/config.json when set (your previous statusline, fed the
//    same stdin), otherwise a compact built-in line.
//
// Always exits 0 and never writes errors to stdout.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../lib/config');
const usage = require('../lib/usage');
const { findGitBash } = require('../lib/shell');

const STDIN_TIMEOUT_MS = 2000;
const CHAIN_TIMEOUT_MS = 10000;

async function main() {
  const input = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(input.toString('utf8'));
  } catch {
    // Not JSON. Still run the chained command with whatever arrived.
  }
  if (!payload || typeof payload !== 'object') payload = null;

  let cfg = {};
  let note = '';
  try {
    cfg = config.loadConfig();
  } catch {
    note = 'cockpit: invalid config.json';
  }
  const chain = typeof cfg.statusLine?.chain === 'string' && cfg.statusLine.chain.trim() ? cfg.statusLine.chain : null;

  // Start the chained command first so it runs while the snapshot is written.
  const chained = chain ? runChain(chain, cfg.statusLine.chainShell, input) : null;

  if (payload) {
    try {
      writeSnapshot(payload);
    } catch (err) {
      process.stderr.write(`cockpit: could not save statusline snapshot: ${err.message}\n`);
    }
  }

  if (chained) {
    const result = await chained;
    if (result.ok || result.stdout.length) {
      process.stdout.write(result.stdout);
      return;
    }
    note = note || 'cockpit: chained statusline failed';
  }
  process.stdout.write(builtinLine(payload, note));
}

function readStdin() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve(Buffer.alloc(0));
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

function writeSnapshot(payload) {
  const dir = config.paths().claudeStatusline;
  fs.mkdirSync(dir, { recursive: true });
  const id = String(payload.session_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  const file = path.join(dir, `${id}.json`);
  const now = Date.now();

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First update of this session.
  }
  // rateLimitsAt is when this session last got numbers from a new API response.
  // Mode changes and refreshInterval re-send the old numbers; keep the old time.
  const unchanged =
    prev?.rateLimitsAt &&
    JSON.stringify(prev.payload?.rate_limits) === JSON.stringify(payload.rate_limits) &&
    prev.payload?.cost?.total_api_duration_ms === payload.cost?.total_api_duration_ms;

  const snapshot = { v: 1, writtenAt: now, rateLimitsAt: unchanged ? prev.rateLimitsAt : now, payload };
  writeAtomic(file, JSON.stringify(snapshot));
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // On Windows a virus scanner or indexer can hold the target for a moment.
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

function runChain(command, shellPref, input) {
  return new Promise((resolve) => {
    const out = [];
    const { file, args } = shellFor(command, shellPref);
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    } catch {
      return resolve({ ok: false, stdout: Buffer.alloc(0) });
    }
    const timer = setTimeout(() => child.kill(), CHAIN_TIMEOUT_MS);
    const done = (ok) => {
      clearTimeout(timer);
      resolve({ ok, stdout: Buffer.concat(out) });
    };
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
    child.stdin.on('error', () => {}); // the command may exit without reading stdin
    child.stdin.end(input);
  });
}

// Run the chained command the way Claude Code runs statusLine commands:
// Git Bash on Windows when it is installed, otherwise PowerShell; sh elsewhere.
function shellFor(command, pref) {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };
  const bash = pref === 'powershell' ? null : findGitBash();
  if (bash) return { file: bash, args: ['-c', command] };
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
}

// Opus 5.5 · ctx 34% · 5h 23% 2h04m · 7d 41% 3d4h
// Only warn and hot get color; everything else stays quiet.
function builtinLine(payload, note, nowMs = Date.now()) {
  const color = !process.env.NO_COLOR;
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s) => paint('2', s);
  const LEVEL_COLOR = { warn: '33', hot: '31' };

  const parts = [];
  const model = payload?.model?.display_name;
  if (model) parts.push(String(model));
  const ctx = payload?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) parts.push(dim(`ctx ${Math.round(ctx)}%`));
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = payload?.rate_limits?.[key];
    const d =
      w &&
      usage.describeWindow(
        { usedPercent: usage.toNumber(w.used_percentage), resetsAt: usage.toNumber(w.resets_at), windowSeconds: usage.CLAUDE_WINDOWS[key] },
        nowMs,
      );
    if (!d || d.level === 'reset') continue;
    const pct = usage.formatPercent(d.usedPercent);
    const shown = LEVEL_COLOR[d.level] ? paint(LEVEL_COLOR[d.level], pct) : pct;
    parts.push(`${dim(label)} ${shown} ${dim(usage.formatDuration(d.remainingSec, true))}`);
  }
  if (note) parts.push(paint('33', note));
  return parts.length ? `${parts.join(dim(' · '))}\n` : '';
}

if (require.main === module) {
  main().catch((err) => process.stderr.write(`cockpit: ${err.stack || err}\n`));
}

module.exports = { builtinLine, findGitBash, shellFor };
