'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate, planLabel, ClaudeUsageSource } = require('../server/claude-usage');

const H = 3600;
const snap = (sessionId, rateLimits, at) => ({
  v: 1,
  writtenAt: at,
  rateLimitsAt: at,
  payload: { session_id: sessionId, rate_limits: rateLimits },
});

test('a newer window beats an idle session still reporting the previous one', () => {
  const agg = aggregate([
    snap('idle', { five_hour: { used_percentage: 90, resets_at: 10 * H } }, 2000),
    snap('busy', { five_hour: { used_percentage: 5, resets_at: 15 * H } }, 1000),
  ]);
  assert.equal(agg.five_hour.usedPercent, 5);
  assert.equal(agg.five_hour.sessionId, 'busy');
});

test('inside one window the highest usage wins, whichever file is newer', () => {
  const agg = aggregate([
    snap('a', { seven_day: { used_percentage: 41.2, resets_at: 100 * H } }, 1000),
    snap('b', { seven_day: { used_percentage: 38, resets_at: 100 * H + 30 } }, 5000),
  ]);
  assert.equal(agg.seven_day.usedPercent, 41.2);
  assert.equal(agg.seven_day.windowSeconds, 7 * 24 * H);
  assert.equal(agg.updatedAt, 1000);
});

test('sessions without rate_limits, or with junk, are ignored', () => {
  const agg = aggregate([
    snap('fresh', undefined, 1),
    snap('junk', { five_hour: { used_percentage: 'lots', resets_at: null } }, 2),
    null,
  ]);
  assert.deepEqual(agg, { five_hour: null, seven_day: null, updatedAt: null });
});

test('plan labels come from the cached account profile', () => {
  assert.equal(planLabel('claude_pro', 'default_claude_ai'), 'pro');
  assert.equal(planLabel('claude_max', 'default_claude_max_20x'), 'max 20x');
  assert.equal(planLabel('claude_max', 'default_claude_max_5x'), 'max 5x');
  assert.equal(planLabel(undefined, undefined), null);
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the source reads snapshot files and emits only on change', (t) => {
  const dir = tempDir(t);
  const src = new ClaudeUsageSource({ dir });
  t.after(() => src.stop());
  let changes = 0;
  src.on('change', () => changes++);

  const future = Math.floor(Date.now() / 1000) + 2 * H;
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify(snap('s1', { five_hour: { used_percentage: 12, resets_at: future } }, Date.now())));
  fs.writeFileSync(path.join(dir, 'ignored.json.123.tmp'), 'partial');
  src.rescan();
  src.rescan();
  assert.equal(changes, 1);
  assert.equal(src.usage.five_hour.usedPercent, 12);
  assert.equal(src.usage.seven_day, null);
});

test('a window that Claude Code dropped after its reset stays visible as expired', (t) => {
  const dir = tempDir(t);
  const src = new ClaudeUsageSource({ dir });
  t.after(() => src.stop());
  const file = path.join(dir, 's1.json');
  const resetsAt = Math.floor(Date.now() / 1000) + 60;
  fs.writeFileSync(file, JSON.stringify(snap('s1', { five_hour: { used_percentage: 80, resets_at: resetsAt } }, Date.now())));
  src.rescan();
  // After the reset the statusline arrives without five_hour.
  fs.writeFileSync(file, JSON.stringify(snap('s1', { seven_day: { used_percentage: 20, resets_at: resetsAt + 99 * H } }, Date.now())));
  src.rescan((resetsAt + 5) * 1000);
  assert.equal(src.usage.five_hour.resetsAt, resetsAt);
});

test('the source reports the plan from ~/.claude.json and survives a missing file', (t) => {
  const dir = tempDir(t);
  const accountFile = path.join(dir, '.claude.json');
  const src = new ClaudeUsageSource({ dir: path.join(dir, 'snaps'), accountFile });
  t.after(() => src.stop());
  src.rescan();
  assert.equal(src.usage.plan, null);
  fs.writeFileSync(accountFile, JSON.stringify({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' } }));
  src.rescan(Date.now() + 61_000); // the profile is checked at most once a minute
  assert.equal(src.usage.plan, 'max 5x');
});

test('each new API response adds a reading to the recent-pace history; a new window starts over', (t) => {
  const dir = tempDir(t);
  const src = new ClaudeUsageSource({ dir });
  t.after(() => src.stop());
  const file = path.join(dir, 's1.json');
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * H;
  const at = (min) => Date.now() - (30 - min) * 60_000;
  for (const [min, used] of [[0, 10], [10, 14], [20, 19]]) {
    fs.writeFileSync(file, JSON.stringify(snap('s1', { five_hour: { used_percentage: used, resets_at: resetsAt } }, at(min))));
    fs.utimesSync(file, new Date(at(min)), new Date(at(min))); // same size each time: make the mtime tell them apart
    src.rescan();
  }
  assert.deepEqual(src.usage.five_hour.recent.map((p) => p[1]), [10, 14, 19]);
  fs.writeFileSync(file, JSON.stringify(snap('s1', { five_hour: { used_percentage: 2, resets_at: resetsAt + 5 * H } }, Date.now())));
  src.rescan();
  assert.deepEqual(src.usage.five_hour.recent.map((p) => p[1]), [2]);
});

test('the periodic pass catches a rewrite that kept the same size and mtime', (t) => {
  const dir = tempDir(t);
  const src = new ClaudeUsageSource({ dir });
  t.after(() => src.stop());
  const file = path.join(dir, 's1.json');
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * H;
  const stamp = new Date(Date.now() - 1000);
  fs.writeFileSync(file, JSON.stringify(snap('s1', { five_hour: { used_percentage: 10, resets_at: resetsAt } }, 1)));
  fs.utimesSync(file, stamp, stamp);
  src.rescan();
  fs.writeFileSync(file, JSON.stringify(snap('s1', { five_hour: { used_percentage: 14, resets_at: resetsAt } }, 1)));
  fs.utimesSync(file, stamp, stamp);
  src.rescan();
  assert.equal(src.usage.five_hour.usedPercent, 10, 'the quick check cannot tell');
  src.rescan(Date.now(), { force: true });
  assert.equal(src.usage.five_hour.usedPercent, 14);
});

test('fs.watch picks up a new snapshot without waiting for the periodic rescan', async (t) => {
  const dir = tempDir(t);
  const src = new ClaudeUsageSource({ dir, rescanMs: 60_000 });
  t.after(() => src.stop());
  src.start();
  const changed = new Promise((resolve) => src.once('change', resolve));
  const future = Math.floor(Date.now() / 1000) + 3 * 24 * H;
  fs.writeFileSync(path.join(dir, 's2.json'), JSON.stringify(snap('s2', { seven_day: { used_percentage: 33, resets_at: future } }, Date.now())));
  const usage = await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no change event within 3s')), 3000))]);
  assert.equal(usage.seven_day.usedPercent, 33);
});
