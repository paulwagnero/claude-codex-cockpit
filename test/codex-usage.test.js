'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexUsageSource, parseEntry, scanFile, pickUsage } = require('../server/codex-usage');

const nowS = () => Math.floor(Date.now() / 1000);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// A token_count line shaped like the ones Codex 0.157 writes.
function line({ at = new Date().toISOString(), limitId = 'codex', limitName = null, primary = null, secondary = null }) {
  return JSON.stringify({
    timestamp: at,
    ordinal: 1,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1 } },
      rate_limits: {
        limit_id: limitId,
        limit_name: limitName,
        primary,
        secondary,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: 'plus',
        rate_limit_reached_type: null,
      },
    },
  });
}
const win = (used, minutes, resetsAt) => ({ used_percent: used, window_minutes: minutes, resets_at: resetsAt });
const only = (entry) => new Map([[entry.limitId, entry]]);

test('the main codex bucket maps its 300-minute window to 5h and 10080 to weekly', () => {
  const u = pickUsage([only(parseEntry(line({ primary: win(99, 300, 111), secondary: win(31, 10080, 222) })))]);
  assert.equal(u.limitId, 'codex');
  assert.deepEqual(u.fiveHour, { usedPercent: 99, resetsAt: 111, windowSeconds: 300 * 60 });
  assert.deepEqual(u.weekly, { usedPercent: 31, resetsAt: 222, windowSeconds: 10080 * 60 });
  assert.equal(u.planType, 'plus');
});

test('the empty premium bucket is skipped instead of blanking the bars', () => {
  assert.equal(parseEntry(line({ limitId: 'premium' })), null);
});

test('the gpt-reserve bucket goes to the weekly slot and never replaces the main limit', () => {
  const main = parseEntry(line({ at: '2026-09-02T11:47:10Z', primary: win(20, 300, 1), secondary: win(15, 10080, 2) }));
  const reserve = parseEntry(
    line({ at: '2026-09-02T11:52:17Z', limitId: 'base_model_inference', limitName: 'gpt-reserve', primary: win(0, 10080, 3) }),
  );
  const u = pickUsage([only(main), only(reserve)]);
  assert.equal(u.limitId, 'codex');
  assert.equal(u.fiveHour.usedPercent, 20);
  assert.equal(u.otherLimits.length, 1);
  assert.equal(u.otherLimits[0].limitName, 'gpt-reserve');
  assert.equal(u.otherLimits[0].fiveHour, null);
  assert.equal(u.otherLimits[0].weekly.usedPercent, 0);
});

test('with no codex bucket at all, the newest usable bucket is shown', () => {
  const reserve = parseEntry(line({ limitId: 'base_model_inference', primary: win(12, 10080, 3) }));
  const u = pickUsage([only(reserve)]);
  assert.equal(u.limitId, 'base_model_inference');
  assert.equal(u.fiveHour, null);
  assert.equal(u.weekly.usedPercent, 12);
});

test('older builds that wrote resets_in_seconds still get an absolute reset time', () => {
  const at = '2026-09-01T00:00:00Z';
  const e = parseEntry(line({ at, primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 600 } }));
  assert.equal(e.windows[0].resetsAt, Date.parse(at) / 1000 + 600);
});

test('null numbers never read as 0%', () => {
  assert.equal(parseEntry(line({ primary: win(null, 300, 5) })), null);
  assert.equal(parseEntry(line({ primary: win(5, 300, null) })), null);
});

test('other event types and junk are ignored', () => {
  assert.equal(parseEntry('{"type":"response_item","payload":{"type":"message"}}'), null);
  assert.equal(parseEntry('not json "token_count" "rate_limits"'), null);
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRollout(home, rel, lines, mtime) {
  const file = path.join(home, 'sessions', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

test('scanFile reads back past megabytes of tool output, a trailing premium line and a half-written line', (t) => {
  const home = tempHome(t);
  const filler = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(100_000) } });
  const file = writeRollout(home, '2026/09/27/rollout-a.jsonl', [
    line({ primary: win(42, 300, nowS() + 3600), secondary: win(7, 10080, nowS() + 86400) }),
    ...Array(30).fill(filler), // about 3 MB, well past the first 256 KB chunk
    line({ limitId: 'premium' }),
    '{"timestamp":"2026-09-27T19:19:07Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"prim',
  ]);
  const found = scanFile(file);
  assert.equal(found.get('codex').windows[0].usedPercent, 42);
  assert.equal(found.has('premium'), false);
});

test('the newest entry wins even when it sits in an old day folder (resumed session)', (t) => {
  const home = tempHome(t);
  writeRollout(home, '2026/09/07/rollout-resumed.jsonl', [
    line({ at: ago(60_000), primary: win(55, 300, nowS() + 3600), secondary: win(30, 10080, nowS() + 86400) }),
  ]);
  writeRollout(
    home,
    '2026/09/27/rollout-newer-folder.jsonl',
    [line({ at: ago(600_000), primary: win(40, 300, nowS() + 3600), secondary: win(29, 10080, nowS() + 86400) })],
    new Date(Date.now() - 3600_000),
  );
  const src = new CodexUsageSource({ home });
  t.after(() => src.stop());
  src.rescan();
  assert.equal(src.usage.fiveHour.usedPercent, 55);
  assert.equal(src.usage.weekly.usedPercent, 30);
});

test('older readings in the rollout become the 5h recent-pace history', (t) => {
  const home = tempHome(t);
  const resets = nowS() + 3 * 3600;
  const reading = (msAgo, used) => line({ at: ago(msAgo), primary: win(used, 300, resets), secondary: win(40, 10080, nowS() + 86400) });
  writeRollout(home, '2026/09/28/rollout-h.jsonl', [
    line({ at: ago(3 * 3600_000), primary: win(90, 300, resets - 5 * 3600) }), // previous window: ignored
    reading(40 * 60_000, 20),
    reading(25 * 60_000, 26),
    reading(5 * 60_000, 33),
    line({ limitId: 'premium' }),
  ]);
  const src = new CodexUsageSource({ home });
  t.after(() => src.stop());
  src.rescan();
  assert.deepEqual(src.usage.fiveHour.recent.map((p) => p[1]), [20, 26, 33]);
  assert.equal(src.usage.fiveHour.usedPercent, 33);
});

test('no sessions folder means no data; one created later is picked up', (t) => {
  const home = tempHome(t);
  const src = new CodexUsageSource({ home });
  t.after(() => src.stop());
  src.rescan();
  assert.equal(src.usage, null);
  writeRollout(home, '2026/09/28/rollout-x.jsonl', [line({ primary: win(5, 300, nowS() + 3600) })]);
  src.rescan();
  assert.equal(src.usage.fiveHour.usedPercent, 5);
});
