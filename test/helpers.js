'use strict';
// Shared test plumbing. Everything runs against temp folders: tests never
// touch the real ~/.claude-codex-cockpit, ~/.claude or ~/.codex.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

function tempDir(t, prefix = 'cockpit-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startApp(t, options = {}) {
  const home = tempDir(t, 'cockpit-srv-');
  const app = createApp({
    port: 0,
    home,
    codexHome: path.join(home, 'codex'),
    claudeDir: path.join(home, 'claude'),
    claudeAccountFile: path.join(home, 'claude.json'),
    // Most tests ask without a panel open; the viewer rule has its own tests.
    requireViewer: false,
    log: () => {},
    ...options,
  });
  await app.start();
  t.after(() => app.stop());
  return { app, home };
}

// Resolves { status, headers, body, json } when the response ends. The
// underlying ClientRequest is exposed as .req so a test can abort it.
function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  let req;
  const promise = new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        agent: false,
        headers: {
          ...(data !== undefined && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
  promise.req = req;
  return promise;
}

async function waitFor(check, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const permissionRequest = (over = {}) => ({
  session_id: 'sess-1',
  transcript_path: null,
  cwd: path.join(os.tmpdir(), 'shop'),
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run the tests' },
  ...over,
});

module.exports = { tempDir, startApp, request, waitFor, permissionRequest };
