'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findGitBash } = require('../bin/statusline');

const BIN = path.join(__dirname, '..', 'bin', 'statusline.js');
const nowS = () => Math.floor(Date.now() / 1000);

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(input, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], { env: { ...process.env, CLAUDE_CODEX_COCKPIT_HOME: home, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

// The +30s keeps the countdown on a whole minute while the script starts up.
const payload = (over = {}) => ({
  session_id: 'sess-1',
  transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\sess-1.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: { used_percentage: 34 },
  cost: { total_api_duration_ms: 1000 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: nowS() + 2 * 3600 + 4 * 60 + 30 },
    seven_day: { used_percentage: 41.2, resets_at: nowS() + 3 * 86400 + 4 * 3600 + 30 },
  },
  ...over,
});

const readSnapshot = (home, id = 'sess-1') =>
  JSON.parse(fs.readFileSync(path.join(home, 'claude-statusline', `${id}.json`), 'utf8'));

test('saves the snapshot and prints the built-in line', async (t) => {
  const home = tempHome(t);
  const r = await run(JSON.stringify(payload()), home);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Opus 5.5 · ctx 34% · 5h 23% 2h04m · 7d 41% 3d4h\n');
  const snap = readSnapshot(home);
  assert.equal(snap.payload.rate_limits.five_hour.used_percentage, 23.5);
  assert.equal(snap.payload.transcript_path, payload().transcript_path);
  assert.deepEqual(fs.readdirSync(path.join(home, 'claude-statusline')), ['sess-1.json']);
});

test('before the first API response there are no rate limits, and nothing breaks', async (t) => {
  const home = tempHome(t);
  const r = await run(JSON.stringify(payload({ rate_limits: undefined, context_window: { used_percentage: null } })), home);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Opus 5.5\n');
});

test('rateLimitsAt survives refreshes that re-send the same numbers', async (t) => {
  const home = tempHome(t);
  const p = payload();
  await run(JSON.stringify(p), home);
  const first = readSnapshot(home);
  await new Promise((r) => setTimeout(r, 20));
  await run(JSON.stringify(p), home);
  const refreshed = readSnapshot(home);
  assert.equal(refreshed.rateLimitsAt, first.rateLimitsAt);
  assert.ok(refreshed.writtenAt > first.writtenAt);
  await run(JSON.stringify({ ...p, cost: { total_api_duration_ms: 2500 } }), home);
  assert.ok(readSnapshot(home).rateLimitsAt > first.rateLimitsAt);
});

test('garbage on stdin exits 0 with no output and no snapshot', async (t) => {
  const home = tempHome(t);
  const r = await run('not json', home);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(fs.existsSync(path.join(home, 'claude-statusline')), false);
});

test('an unusable session id cannot escape the snapshot folder', async (t) => {
  const home = tempHome(t);
  await run(JSON.stringify(payload({ session_id: '..\\..\\evil' })), home);
  assert.deepEqual(fs.readdirSync(path.join(home, 'claude-statusline')), ['.._.._evil.json']);
});

test('a broken config.json is reported in the line instead of silently dropping the chain', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
  const r = await run(JSON.stringify(payload()), home);
  assert.match(r.out, /cockpit: invalid config\.json\n$/);
});

test('chains the previous statusline through Git Bash with the same stdin', { skip: process.platform === 'win32' && !findGitBash() && 'Git Bash not found' }, async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), '\uFEFF' + JSON.stringify({ statusLine: { chain: 'cat' } }));
  const input = JSON.stringify(payload());
  const r = await run(input, home);
  assert.equal(r.out, input);
  assert.ok(readSnapshot(home)); // the snapshot is still written
});

test('chains through PowerShell when asked', { skip: process.platform !== 'win32' }, async (t) => {
  const home = tempHome(t);
  const cfg = { statusLine: { chain: "Write-Output ('chained ' + ($input | ConvertFrom-Json).model.display_name)", chainShell: 'powershell' } };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const r = await run(JSON.stringify(payload()), home);
  assert.equal(r.out.trim(), 'chained Opus 5.5');
});

test('a chained command that fails falls back to the built-in line with a note', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ statusLine: { chain: 'exit 3' } }));
  const r = await run(JSON.stringify(payload()), home);
  assert.match(r.out, /^Opus 5\.5 · .* · cockpit: chained statusline failed\n$/);
});
