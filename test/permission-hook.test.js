'use strict';
// The hook as Claude Code and Codex run it: a real process, stdin in,
// stdout and exit code out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DENY_MESSAGE } = require('../server/approvals');
const { toHookOutput, parseArgs } = require('../bin/permission-hook');
const { startApp, tempDir, waitFor, permissionRequest } = require('./helpers');

const HOOK = path.join(__dirname, '..', 'bin', 'permission-hook.js');

// Whatever CLAUDE_* the test runner inherited (it may itself run inside
// Claude Code) is dropped; each test sets what it needs.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));

function runHook({ home, args = ['--agent', 'claude', '--timeout', '600'], input = JSON.stringify(permissionRequest()), env = {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...cleanEnv, CLAUDE_CODEX_COCKPIT_HOME: home, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

const deadPid = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('close', () => resolve(child.pid));
  });

test('panel not running: exits 0 at once, prints nothing', async (t) => {
  const r = await runHook({ home: tempDir(t) });
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test('leftover server.json from a crashed server: same', async (t) => {
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ pid: await deadPid(), port: 47821, token: 'x' }));
  const r = await runHook({ home });
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
});

test('server alive but not answering on its port: gives up fast', async (t) => {
  const home = tempDir(t);
  // A live pid (this test runner) with a port nothing listens on.
  fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ pid: process.pid, port: 1, token: 'x' }));
  const r = await runHook({ home });
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.ok(r.ms < 2500, `took ${r.ms} ms`);
});

test('Approve in the panel: prints exactly the allow decision', async (t) => {
  const { app, home } = await startApp(t);
  const hook = runHook({ home });
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  app.approvals.decide(item.id, 'allow');
  const r = await hook;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('Deny for Codex: only behavior and message, nothing Codex would reject', async (t) => {
  const { app, home } = await startApp(t);
  const hook = runHook({ home, args: ['--agent', 'codex', '--timeout', '60'], input: JSON.stringify(permissionRequest({ turn_id: 't1' })) });
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  assert.equal(item.agent, 'codex');
  app.approvals.decide(item.id, 'deny');
  const r = await hook;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENY_MESSAGE } },
  });
});

test('no answer: gives up before --timeout, prints nothing', async (t) => {
  const { app, home } = await startApp(t);
  const r = await runHook({ home, args: ['--agent', 'codex', '--timeout', '7'] }); // waits 7 - 5 = 2 s
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.ok(r.ms >= 1900 && r.ms < 6000, `took ${r.ms} ms`);
  assert.deepEqual(app.approvals.list(), []);
});

test('claude -p (unattended): waits only briefly, since nothing else can answer', async (t) => {
  const { app, home } = await startApp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { unattendedWaitSec: 2 } }));
  const hook = runHook({ home, env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }); // --timeout 600 alone would wait 595 s
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  assert.equal(item.fallback, 'deny');
  assert.ok(item.expiresAt - item.createdAt <= 2000);
  const r = await hook;
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
});

test('an interactive Claude session keeps the long wait', async (t) => {
  const { app, home } = await startApp(t);
  const hook = runHook({ home, env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  assert.equal(item.fallback, 'race');
  assert.equal(item.expiresAt - item.createdAt, 595_000);
  app.approvals.decide(item.id, 'terminal');
  await hook;
});

test('"answer in terminal": prints nothing', async (t) => {
  const { app, home } = await startApp(t);
  const hook = runHook({ home });
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  app.approvals.decide(item.id, 'terminal');
  assert.deepEqual(await hook.then(({ code, out }) => ({ code, out })), { code: 0, out: '' });
});

test('other events and garbage are ignored without opening anything', async (t) => {
  const { app, home } = await startApp(t);
  for (const input of [JSON.stringify(permissionRequest({ hook_event_name: 'PreToolUse' })), 'not json', '']) {
    const r = await runHook({ home, input });
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  }
  assert.deepEqual(app.approvals.list(), []);
});

test('config.json can turn approvals off, per agent', async (t) => {
  const { app, home } = await startApp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { codex: false } }));
  const r = await runHook({ home, args: ['--agent', 'codex', '--timeout', '60'] });
  assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' });
  assert.deepEqual(app.approvals.list(), []);
});

test('Always for Claude Code: echoes its suggestions as updatedPermissions', async (t) => {
  const { app, home } = await startApp(t);
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
  const hook = runHook({ home, input: JSON.stringify(permissionRequest({ permission_suggestions: suggestions })) });
  const [item] = await waitFor(() => app.approvals.list().length === 1 && app.approvals.list());
  app.approvals.decide(item.id, 'always');
  const r = await hook;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: suggestions } },
  });
});

test('toHookOutput sends updatedPermissions only to Claude Code, and only for Always', () => {
  const payload = { permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
  const decision = (answer, p, agent) => toHookOutput(answer, p, agent).hookSpecificOutput.decision;
  assert.deepEqual(decision({ decision: 'allow', always: true }, payload, 'codex'), { behavior: 'allow' }, 'Codex fails closed on it');
  assert.deepEqual(decision({ decision: 'allow' }, payload, 'claude'), { behavior: 'allow' }, 'a plain allow saves nothing');
  assert.deepEqual(decision({ decision: 'allow', always: true }, {}, 'claude'), { behavior: 'allow' }, 'nothing suggested');
  assert.deepEqual(decision({ decision: 'allow', always: true }, payload, 'claude').updatedPermissions, payload.permission_suggestions);
});

test('toHookOutput only ever allows on an explicit allow', () => {
  for (const answer of [null, undefined, {}, { decision: 'none' }, { decision: 'ALLOW' }, { decision: true }, 'allow']) {
    assert.equal(toHookOutput(answer), null);
  }
  assert.equal(toHookOutput({ decision: 'deny' }).hookSpecificOutput.decision.message, 'Denied in Claude Codex Cockpit.');
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--agent', 'codex', '--timeout', '60']), { agent: 'codex', timeout: 60 });
  assert.deepEqual(parseArgs(['--timeout', 'soon']), { agent: null, timeout: 0 });
});
