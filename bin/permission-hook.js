#!/usr/bin/env node
'use strict';
// PermissionRequest hook for Claude Code and Codex.
//
//   node bin/permission-hook.js --agent claude|codex --timeout <seconds>
//
// Puts the request in the cockpit panel and waits for Approve or Deny.
// --timeout must equal the hook's `timeout` in the tool's settings: the hook
// gives up a few seconds before it, so the tool never has to kill it.
//
// Every other path ends the same way: exit 0 with nothing on stdout, which
// both tools read as "no decision" and answer with their own prompt.
//   panel not running        exits in milliseconds, without touching the network
//   server unreachable       gives up after 500 ms
//   no answer in time        gives up before --timeout
//   the tool went away       gives up within 2 s
//   anything unexpected      same
// "allow" is printed only when the server answers allow for this request.
// Never exits with code 2: Codex treats exit 2 as a deny.

const fs = require('fs');
const http = require('http');
const config = require('../lib/config');

const STDIN_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 500;
const MARGIN_SEC = 5;
// Claude Code keeps its own dialog up meanwhile, so it can wait long; Codex
// shows its prompt only after the hook gives up, so it waits briefly.
const DEFAULT_TIMEOUT_SEC = { claude: 600, codex: 60 };
// `claude -p` and other unattended runs have no dialog at all: without a
// decision they deny, so a long wait would only stall the script.
const DEFAULT_UNATTENDED_WAIT_SEC = 60;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || payload.hook_event_name !== 'PermissionRequest') return null;
  const agent = args.agent === 'claude' || args.agent === 'codex' ? args.agent : 'turn_id' in payload ? 'codex' : 'claude';

  let cfg = {};
  try {
    cfg = config.loadConfig();
  } catch {
    // A broken config.json doesn't turn approvals off.
  }
  if (cfg.approvals?.enabled === false || cfg.approvals?.[agent] === false) return null;

  const server = readServerFile();
  if (!server) return null;

  // Claude Code sets CLAUDE_CODE_SESSION_ATTENDED=1 for interactive sessions
  // and 0 for `claude -p` and SDK runs.
  const unattended = agent === 'claude' && process.env.CLAUDE_CODE_SESSION_ATTENDED === '0';
  const budgetSec = args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_SEC[agent];
  let waitSec = budgetSec - MARGIN_SEC;
  if (unattended) waitSec = Math.min(waitSec, Number(cfg.approvals?.unattendedWaitSec) || DEFAULT_UNATTENDED_WAIT_SEC);
  const waitMs = Math.max(1000, waitSec * 1000);
  // Exec-form hooks are children of the tool itself; CLAUDE_PID also covers shell form.
  const watchPid = (agent === 'claude' && Number(process.env.CLAUDE_PID)) || process.ppid;
  return toHookOutput(await ask(server, { agent, payload, waitMs, unattended }, waitMs + 1500, watchPid));
}

function parseArgs(argv) {
  const args = { agent: null, timeout: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') args.agent = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]) || 0;
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve('');
    const chunks = [];
    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

// The server writes this file when it starts and removes it when it stops.
// Missing file or dead pid: the panel isn't running.
function readServerFile() {
  try {
    const info = JSON.parse(fs.readFileSync(config.paths().serverFile, 'utf8'));
    if (!Number.isInteger(info.port) || typeof info.token !== 'string' || !isAlive(info.pid)) return null;
    return info;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// POST the request and wait for the answer. Resolves null on anything but a
// well-formed answer from the server.
function ask(server, body, deadlineMs, watchPid) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let settled = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/api/approvals',
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Cockpit-Token': server.token,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 65536) done(null);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return done(null);
          try {
            done(JSON.parse(text));
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      },
    );
    const connectTimer = setTimeout(() => done(null), CONNECT_TIMEOUT_MS);
    const deadline = setTimeout(() => done(null), deadlineMs);
    // The tool or its session went away without killing us.
    const parentWatch = setInterval(() => isAlive(watchPid) || done(null), 2000);

    function done(answer) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(deadline);
      clearInterval(parentWatch);
      req.destroy();
      resolve(answer);
    }

    req.on('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.on('error', () => done(null));
    req.end(data);
  });
}

// The same shape works for both tools. Only `behavior` and, on deny, `message`:
// Codex rejects updatedInput, updatedPermissions and interrupt on this event.
function toHookOutput(answer) {
  if (answer?.decision === 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  }
  if (answer?.decision === 'deny') {
    const message = typeof answer.message === 'string' && answer.message ? answer.message : 'Denied in Claude Codex Cockpit.';
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
  }
  return null;
}

// process.exit also ends any handle still open (stdin, a lingering socket);
// the write callback makes sure the decision is flushed first.
function emit(output) {
  if (output) process.stdout.write(JSON.stringify(output), () => process.exit(0));
  else process.exit(0);
}

if (require.main === module) main().then(emit, () => emit(null));

module.exports = { main, parseArgs, toHookOutput };
