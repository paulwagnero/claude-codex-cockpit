'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

// Temp homes for both cockpit and Codex: tests never read the real ~/.codex.
async function startApp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-srv-'));
  const codexHome = path.join(home, 'codex');
  const claudeAccountFile = path.join(home, 'claude.json');
  const claudeDir = path.join(home, 'claude');
  const app = createApp({ port: 0, home, codexHome, claudeDir, claudeAccountFile, log: () => {} });
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { app, home, codexHome };
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

// Reads `state` events off an open SSE response, one per call.
function sseReader(res) {
  let buf = '';
  const queue = [];
  const waiters = [];
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event === 'state') {
        const parsed = JSON.parse(data);
        if (waiters.length) waiters.shift()(parsed);
        else queue.push(parsed);
      }
    }
  });
  return () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error('no state event within 3s')), 3000).unref();
        });
}

test('binds to 127.0.0.1 and answers health', async (t) => {
  const { app } = await startApp(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  const r = await get(app.port, '/api/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).app, 'claude-codex-cockpit');
});

test('refuses foreign Host headers (DNS rebinding) and cross-site browser requests', async (t) => {
  const { app } = await startApp(t);
  assert.equal((await get(app.port, '/api/state', { Host: 'evil.example:80' })).status, 403);
  assert.equal((await get(app.port, '/api/state', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(app.port, '/api/state', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get(app.port, '/api/state', { Origin: `http://127.0.0.1:${app.port}` })).status, 200);
});

test('SSE sends state on connect and again when a snapshot lands', async (t) => {
  const { app, home } = await startApp(t);
  const res = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: app.port, path: '/api/events' }, resolve);
    req.on('error', reject);
    t.after(() => req.destroy());
  });
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  const next = sseReader(res);

  const first = await next();
  assert.equal(first.usage.claude.fiveHour, null);

  const resetsAt = Math.floor(Date.now() / 1000) + 4.5 * 3600;
  const snapshot = {
    v: 1,
    writtenAt: Date.now(),
    rateLimitsAt: Date.now(),
    payload: { session_id: 's', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: resetsAt } } },
  };
  fs.writeFileSync(path.join(home, 'claude-statusline', 's.json'), JSON.stringify(snapshot));
  app.claude.rescan(); // do not depend on fs.watch timing here; claude-usage.test.js covers the watcher

  const second = await next();
  const w = second.usage.claude.fiveHour;
  assert.equal(w.usedPercent, 23.5);
  assert.equal(w.resetsAt, resetsAt);
  assert.equal(w.level, 'hot'); // 23.5% used with only 10% of the window gone
});

test('Codex usage from CODEX_HOME shows up in the state', async (t) => {
  const { app, codexHome } = await startApp(t);
  assert.equal(app.state().usage.codex.fiveHour, null);

  const nowS = Math.floor(Date.now() / 1000);
  const event = {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 12, window_minutes: 300, resets_at: nowS + 4 * 3600 },
        secondary: { used_percent: 31, window_minutes: 10080, resets_at: nowS + 5 * 86400 },
        plan_type: 'plus',
      },
    },
  };
  const dir = path.join(codexHome, 'sessions', '2026', '09', '28');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-test.jsonl'), `${JSON.stringify(event)}\n`);
  app.codex.rescan();

  const codex = JSON.parse((await get(app.port, '/api/state')).body).usage.codex;
  assert.equal(codex.fiveHour.usedPercent, 12);
  assert.equal(codex.weekly.usedPercent, 31);
  assert.equal(codex.planType, 'plus');
});

test('serves the panel, the debug page and the shared usage module, 404s the rest', async (t) => {
  const { app } = await startApp(t);
  const panel = await get(app.port, '/');
  assert.equal(panel.status, 200);
  assert.match(panel.headers['content-security-policy'], /default-src 'self'/);
  assert.match(panel.body, /<title>Claude Codex Cockpit<\/title>/);
  assert.equal((await get(app.port, '/ui/style.css')).headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await get(app.port, '/debug')).status, 200);
  assert.match((await get(app.port, '/lib/usage.js')).body, /CockpitUsage/);
  assert.equal((await get(app.port, '/../package.json')).status, 404);
  assert.equal((await get(app.port, '/nope')).status, 404);
});
