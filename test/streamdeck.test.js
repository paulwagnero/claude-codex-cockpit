'use strict';
// The Stream Deck plugin's keys, its parsing of what Stream Deck and the
// cockpit send, and the generated files it ships with.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'streamdeck', 'io.github.paulwagnero.claude-codex-cockpit.sdPlugin');
const keys = require(path.join(DIR, 'keys'));
const { sseParser, parseArgs, actionName } = require(path.join(DIR, 'plugin'));
const make = require('../scripts/make-streamdeck');
const manifest = require(path.join(DIR, 'manifest.json'));

const now = Date.UTC(2026, 9, 3, 12);
const sec = (s) => now / 1000 + s;
const state = (over = {}) => ({ approvals: [], projects: [], usage: {}, ...over });
const request = (over = {}) => ({
  id: 'r1',
  agent: 'claude',
  project: 'shop',
  title: 'Bash',
  detail: 'npm test',
  fallback: 'race',
  createdAt: now,
  expiresAt: now + 60_000,
  always: { what: 'Bash(npm test:*)', short: 'npm test:*', where: 'this project' },
  ...over,
});
const face = (action, s, armedAt) => keys.face(action, keys.deckView(s, now, armedAt), now);

test('usage keys: percent, time to the reset and the pace color, as on the panel', () => {
  const usage = {
    claude: {
      fiveHour: { usedPercent: 42, resetsAt: sec(2 * 3600 + 240), windowSeconds: 5 * 3600 },
      weekly: { usedPercent: 90, resetsAt: sec(6 * 86400), windowSeconds: 7 * 86400 },
    },
  };
  const svg = face('claude', state({ usage }));
  assert.match(svg, />CLAUDE</);
  assert.match(svg, />42%</);
  assert.match(svg, />2h04</);
  assert.match(svg, />90%</);
  assert.match(svg, /fill="#e5534b"/, '90% used on the first day of the week is hot');
});

test('usage keys say when there is nothing to show, and why', () => {
  assert.match(face('codex', state()), />no data yet</);
  assert.match(face('codex', null), />cockpit off</);
  const starting = keys.deckView(null, now, undefined, true);
  assert.match(keys.face('codex', starting, now), />starting…</, 'the plugin started a server that is not up yet');
  assert.match(keys.face('request', starting, now), />starting…</);
});

test('the request key shows the oldest request; with none, the sessions', () => {
  const svg = face('request', state({ approvals: [request(), request({ id: 'r2', agent: 'codex' })] }));
  assert.match(svg, />CLAUDE</);
  assert.match(svg, />1\/2</);
  assert.match(svg, />npm test</);
  const idle = face('request', state({ projects: [{ sessions: [{ status: 'working' }, { status: 'working' }, { status: 'your-turn' }] }] }));
  assert.match(idle, />2<\/text><text[^>]*>working</);
  assert.match(idle, />your turn</);
  assert.match(face('request', null), />not running</);
});

test('a Codex request counts down to its terminal prompt', () => {
  assert.match(face('request', state({ approvals: [request({ agent: 'codex', fallback: 'after', expiresAt: now + 42_000 })] })), />terminal in 42s</);
});

test('Allow, Always and Deny light up only with something to answer, faded while arming', () => {
  for (const k of ['allow', 'always', 'deny']) assert.doesNotMatch(face(k, state()), /fill="#ffffff"/, k);
  assert.match(face('allow', state({ approvals: [request()] }), () => now + 500), /fill-opacity="0.4"/);
  assert.doesNotMatch(face('allow', state({ approvals: [request()] })), /fill-opacity/);
  const always = face('always', state({ approvals: [request()] }));
  assert.match(always, />npm test:\*</, 'Always says what it remembers');
  assert.match(always, />project</, 'and where it applies');
  assert.match(face('always', state({ approvals: [request({ always: null })] })), />once only</);
});

test('a press answers the oldest request, once it is armed', () => {
  const view = (s, armedAt) => keys.deckView(s, now, armedAt);
  const armed = view(state({ approvals: [request(), request({ id: 'r2' })] }));
  assert.deepEqual(keys.keyAction('allow', armed, now), { id: 'r1', decision: 'allow' });
  assert.deepEqual(keys.keyAction('always', armed, now), { id: 'r1', decision: 'always' });
  assert.deepEqual(keys.keyAction('deny', armed, now), { id: 'r1', decision: 'deny' });
  assert.deepEqual(keys.keyAction('request', armed, now), { id: 'r1', decision: 'terminal' });
  assert.ok(keys.keyAction('allow', view(state({ approvals: [request()] }), () => now + 1), now).refuse, 'not before the guard time');
  assert.ok(keys.keyAction('always', view(state({ approvals: [request({ always: null })] })), now).refuse);
  assert.ok(keys.keyAction('deny', view(state()), now).refuse, 'nothing to answer');
  assert.ok(keys.keyAction('claude', armed, now).ignore);
  assert.ok(keys.keyAction('request', view(state()), now).ignore);
  assert.ok(keys.keyAction('allow', view(null), now).refuse);
});

test('text from a request is escaped, not markup', () => {
  const svg = face('request', state({ approvals: [request({ title: '<b>&', detail: 'echo "<x>"' })] }));
  assert.match(svg, /&lt;b&gt;&amp;/);
  assert.doesNotMatch(svg, /<b>/);
});

test('sseParser reads events split across chunks and skips heartbeats', () => {
  const got = [];
  const parse = sseParser((event, data) => got.push([event, data]));
  parse('retry: 2000\n\nevent: state\ndata: {"a"');
  parse(':1}\n\n: ping\n\nevent: state\ndata: {}\n\n');
  assert.deepEqual(got, [
    ['state', '{"a":1}'],
    ['state', '{}'],
  ]);
});

test('parseArgs reads what Stream Deck passes the plugin', () => {
  assert.deepEqual(parseArgs(['-port', '28196', '-pluginUUID', 'abc', '-registerEvent', 'registerPlugin', '-info', '{"devices":[]}']), {
    port: '28196',
    pluginUUID: 'abc',
    registerEvent: 'registerPlugin',
    info: { devices: [] },
  });
});

test('the manifest, the Mini layout and the key images agree', () => {
  assert.deepEqual(
    manifest.Actions.map((a) => a.UUID),
    keys.ACTIONS.map((a) => `${manifest.UUID}.${a}`),
  );
  assert.deepEqual(
    make.PROFILES.map((p) => p.file),
    manifest.Profiles.map((p) => p.Name),
  );
  const used = new Set(make.PROFILES.flatMap((p) => Object.values(p.layout)));
  assert.deepEqual([...used].sort(), [...keys.ACTIONS].sort(), 'every action is on some profile');
  for (const a of manifest.Actions) {
    assert.ok(fs.existsSync(path.join(DIR, `${a.Icon}.svg`)), a.Icon);
    assert.ok(fs.existsSync(path.join(DIR, `${a.States[0].Image}.svg`)), a.States[0].Image);
    assert.equal(actionName(a.UUID), a.UUID.split('.').pop());
  }
  assert.ok(fs.existsSync(path.join(DIR, `${manifest.Icon}.png`)) && fs.existsSync(path.join(DIR, `${manifest.Icon}@2x.png`)));
  assert.equal(actionName('com.someone.else.allow'), null);
  assert.equal(manifest.Profiles[0].DeviceType, 1, 'Stream Deck Mini');
});

test('the generated files are up to date (npm run streamdeck)', () => {
  for (const action of keys.ACTIONS) assert.equal(fs.readFileSync(make.keyImageFile(action), 'utf8'), make.keyImage(action), action);
  for (const p of make.PROFILES) assert.ok(fs.readFileSync(make.profileFile(p)).equals(make.profileZip(p)), p.file);
});

test('each profile unzips to its keys on a Mini', () => {
  for (const p of make.PROFILES) {
    const profile = JSON.parse(unzip(make.profileZip(p))[`${p.id}.sdProfile/manifest.json`]);
    assert.equal(profile.DeviceModel, '20GAI9901');
    assert.equal(profile.Name, p.name);
    assert.deepEqual(Object.keys(profile.Actions).sort(), Object.keys(p.layout).sort());
    for (const [pos, action] of Object.entries(p.layout)) assert.equal(profile.Actions[pos].UUID, `${manifest.UUID}.${action}`, pos);
  }
  assert.deepEqual(Object.keys(make.PROFILES[1].layout), ['0,0', '1,0', '2,0'], 'the top-row profile leaves the bottom row free');
});

test('top row: the usage key of the tool next in line glows, and a press allows once', () => {
  const claudeFirst = state({ approvals: [request(), request({ id: 'r2', agent: 'codex' })] });
  assert.match(face('claude-allow', claudeFirst), /stroke="#ffae34"/, 'Claude is next: its key glows');
  assert.doesNotMatch(face('codex-allow', claudeFirst), /stroke="#ffae34"/, 'Codex waits its turn');
  assert.doesNotMatch(face('claude-allow', state()), /stroke="#ffae34"/);
  assert.match(face('claude-allow', claudeFirst), />42%|>CLAUDE</, 'it still shows the usage');
  const view = keys.deckView(claudeFirst, now);
  assert.deepEqual(keys.keyAction('claude-allow', view, now), { id: 'r1', decision: 'allow' });
  assert.ok(keys.keyAction('codex-allow', view, now).refuse, 'not its turn');
  assert.ok(keys.keyAction('claude-allow', keys.deckView(state(), now), now).ignore, 'nothing waits: just a usage key');
  assert.ok(keys.keyAction('claude-allow', keys.deckView(claudeFirst, now, () => now + 1), now).refuse, 'same guard time');
  assert.match(face('claude-allow', claudeFirst, () => now + 1), /stroke-width="2"/, 'thin and still while arming');
});

// Reads a stored (uncompressed) zip, checking each entry's CRC.
function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    assert.equal(buf.readUInt16LE(i + 8), 0, 'stored');
    const size = buf.readUInt32LE(i + 18);
    const nameLength = buf.readUInt16LE(i + 26);
    const start = i + 30 + nameLength + buf.readUInt16LE(i + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(zlib.crc32(data), buf.readUInt32LE(i + 14));
    files[buf.toString('utf8', i + 30, i + 30 + nameLength)] = data.toString('utf8');
    i = start + size;
  }
  assert.equal(buf.readUInt32LE(i), 0x02014b50, 'the central directory follows');
  return files;
}
