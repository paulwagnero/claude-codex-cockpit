'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DENY_MESSAGE } = require('../server/approvals');
const { startApp, request, waitFor, permissionRequest, tempDir } = require('./helpers');

// What the hook script sends.
function hookAsk(app, { agent = 'claude', payload = permissionRequest(), waitMs = 60_000, unattended, token = app.token, headers = {} } = {}) {
  return request(app.port, {
    method: 'POST',
    path: '/api/approvals',
    headers: { 'X-Cockpit-Token': token, ...headers },
    body: { agent, payload, waitMs, unattended },
  });
}

// What a click in the panel sends.
function click(app, id, decision, headers = {}) {
  return request(app.port, {
    method: 'POST',
    path: `/api/approvals/${id}`,
    headers: { 'X-Cockpit-Token': app.token, ...headers },
    body: { decision },
  });
}

const pending = (app, n = 1) => waitFor(() => app.approvals.list().length === n && app.approvals.list());

test('Approve: the waiting hook gets allow and the request leaves the panel', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app);
  const [item] = await pending(app);
  assert.equal(item.agent, 'claude');
  assert.equal(item.project, 'shop');
  assert.equal(item.title, 'Bash');
  assert.equal(item.detail, 'npm test');
  assert.equal(item.note, 'Run the tests');
  assert.equal(item.fallback, 'race', "Claude Code's own dialog is up at the same time");
  assert.deepEqual(app.state().approvals.map((a) => a.id), [item.id]);

  assert.equal((await click(app, item.id, 'allow')).status, 200);
  assert.deepEqual((await hook).json, { decision: 'allow' });
  assert.deepEqual(app.approvals.list(), []);
  assert.equal((await click(app, item.id, 'allow')).status, 404, 'a request is answered once');
});

test('Deny tells the agent why', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app, { agent: 'codex', payload: permissionRequest({ turn_id: 't1' }) });
  const [item] = await pending(app);
  assert.equal(item.fallback, 'after', 'Codex holds its own prompt until the hook gives up');
  await click(app, item.id, 'deny');
  assert.deepEqual((await hook).json, { decision: 'deny', message: DENY_MESSAGE });
});

test('an unattended Claude run (claude -p) is marked: no prompt anywhere else', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app, { unattended: true });
  const [item] = await pending(app);
  assert.equal(item.fallback, 'deny');
  await click(app, item.id, 'allow');
  assert.deepEqual((await hook).json, { decision: 'allow' });
});

test('"answer in terminal" releases the hook with no decision', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app);
  const [item] = await pending(app);
  await click(app, item.id, 'terminal');
  assert.deepEqual((await hook).json, { decision: 'none', reason: 'sent to terminal' });
});

test('no answer in time means no decision', async (t) => {
  const { app } = await startApp(t);
  const started = Date.now();
  const res = await hookAsk(app, { waitMs: 1000 });
  assert.deepEqual(res.json, { decision: 'none', reason: 'timeout' });
  assert.ok(Date.now() - started < 2500);
  assert.deepEqual(app.approvals.list(), []);
});

test('a hook that goes away takes its request out of the panel', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app);
  hook.catch(() => {});
  await pending(app);
  hook.req.destroy();
  await waitFor(() => app.approvals.list().length === 0);
});

test('Claude Code: answering in the terminal first clears the panel', async (t) => {
  const { app } = await startApp(t);
  const transcript = path.join(tempDir(t), 'session.jsonl');
  const use = (id) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
  const result = (id) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  // An identical earlier call, already answered, must not clear the new request.
  fs.writeFileSync(transcript, [use('toolu_old'), result('toolu_old'), use('toolu_new')].join('\n') + '\n');

  const hook = hookAsk(app, { payload: permissionRequest({ transcript_path: transcript }) });
  await pending(app);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(app.approvals.list().length, 1, 'still waiting after a poll');

  fs.appendFileSync(transcript, `${result('toolu_new')}\n`);
  assert.deepEqual((await hook).json, { decision: 'none', reason: 'answered in terminal' });
});

test('stopping the server releases every waiting hook', async (t) => {
  const { app } = await startApp(t);
  const hooks = [hookAsk(app), hookAsk(app)];
  await pending(app, 2);
  await app.stop();
  for (const res of await Promise.all(hooks)) assert.deepEqual(res.json, { decision: 'none', reason: 'server stopping' });
});

test('a hook without this run\'s token is refused', async (t) => {
  const { app } = await startApp(t);
  assert.equal((await hookAsk(app, { token: '' })).status, 401);
  assert.equal((await hookAsk(app, { token: 'x'.repeat(32) })).status, 401);
  assert.deepEqual(app.approvals.list(), []);
});

test('a web page cannot answer, even holding a token', async (t) => {
  const { app } = await startApp(t);
  const hook = hookAsk(app);
  const [item] = await pending(app);
  assert.equal((await click(app, item.id, 'allow', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await click(app, item.id, 'allow', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await click(app, item.id, 'allow', { Host: 'evil.example' })).status, 403);
  const plainForm = await request(app.port, {
    method: 'POST',
    path: `/api/approvals/${item.id}`,
    headers: { 'X-Cockpit-Token': app.token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'decision=allow',
  });
  assert.equal(plainForm.status, 415);
  assert.equal(app.approvals.list().length, 1, 'still waiting for a real click');
  await click(app, item.id, 'deny');
  await hook;
});

test('bad requests are refused without opening anything', async (t) => {
  const { app } = await startApp(t);
  const notPermission = await hookAsk(app, { payload: permissionRequest({ hook_event_name: 'PreToolUse' }) });
  assert.equal(notPermission.status, 400);
  assert.equal(notPermission.json.decision, 'none');
  assert.equal((await hookAsk(app, { agent: 'gemini' })).status, 400);
  const hook = hookAsk(app);
  const [item] = await pending(app);
  assert.equal((await click(app, item.id, 'maybe')).status, 400);
  assert.equal((await click(app, '00000000-0000-0000-0000-000000000000', 'allow')).status, 404);
  await click(app, item.id, 'deny');
  await hook;
});

test('server.json carries pid, port and token while running, and goes away on stop', async (t) => {
  const { app, home } = await startApp(t);
  const file = path.join(home, 'server.json');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, app.port);
  assert.equal(info.token, app.token);
  await app.stop();
  assert.equal(fs.existsSync(file), false);
});

test('the panel page carries the token; nothing else does', async (t) => {
  const { app } = await startApp(t);
  assert.match((await request(app.port, { path: '/' })).body, new RegExp(`<meta name="cockpit-token" content="${app.token}">`));
  assert.doesNotMatch((await request(app.port, { path: '/api/state' })).body, new RegExp(app.token));
  assert.doesNotMatch((await request(app.port, { path: '/api/health' })).body, new RegExp(app.token));
});

test('every settled request is written to the audit log', async (t) => {
  const { app, home } = await startApp(t, { audit: true });
  const hook = hookAsk(app);
  const [item] = await pending(app);
  await click(app, item.id, 'allow');
  await hook;
  const log = path.join(home, 'approvals.log');
  const line = await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim());
  assert.deepEqual(
    (({ agent, project, tool, title, detail, decision, reason }) => ({ agent, project, tool, title, detail, decision, reason }))(JSON.parse(line)),
    { agent: 'claude', project: 'shop', tool: 'Bash', title: 'Bash', detail: 'npm test', decision: 'allow', reason: 'panel' },
  );
});
