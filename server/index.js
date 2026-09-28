#!/usr/bin/env node
'use strict';
// cockpit server: HTTP and Server-Sent Events on 127.0.0.1 only, no npm dependencies.
//
//   GET  /api/health          identity check, used to spot an already-running server
//   GET  /api/state           current state as JSON
//   GET  /api/events          SSE stream: a `state` event on connect and on every change
//   POST /api/approvals       a permission hook waiting for an answer (held open)
//   POST /api/approvals/:id   the panel's answer: allow, deny or terminal
//   GET  /                    the panel (also what the Electron window loads)
//   GET  /debug               raw live view of the state
//
// Every POST needs this run's token: hooks read it from ~/.claude-codex-cockpit/server.json,
// the panel gets it inside its own page. A web page can't read either, so it
// can't answer a permission request for you.

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { describeWindow, formatDuration, formatPercent } = require('../lib/usage');
const { ClaudeUsageSource } = require('./claude-usage');
const { CodexUsageSource } = require('./codex-usage');
const { Approvals } = require('./approvals');
const { SessionsSource } = require('./sessions');
const { SseHub } = require('./sse');
const { version } = require('../package.json');

const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const STATIC = {
  '/ui/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/ui/style.css': ['ui/style.css', 'text/css; charset=utf-8'],
  '/debug': ['ui/debug.html', 'text/html; charset=utf-8'],
  '/debug.js': ['ui/debug.js', 'text/javascript; charset=utf-8'],
  '/lib/usage.js': ['lib/usage.js', 'text/javascript; charset=utf-8'],
};
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'";
const TOKEN_META = '<meta name="cockpit-token" content="">';
const STALE_MS = 10 * 60 * 1000;
const MAX_HOOK_BODY = 8 * 1024 * 1024; // a Write request carries the whole file
const MAX_WAIT_MS = 24 * 3600 * 1000;

function createApp({
  port = config.DEFAULT_PORT,
  home = config.home(),
  claudeDir = config.claudeDir(),
  claudeAccountFile = config.claudeAccountFile(),
  codexHome = config.codexHome(),
  audit = false,
  log = console.log,
} = {}) {
  const files = config.paths(home);
  const claude = new ClaudeUsageSource({ dir: files.claudeStatusline, accountFile: claudeAccountFile });
  const codex = new CodexUsageSource({ home: codexHome });
  const sessions = new SessionsSource({ claudeDir, codexUsage: codex });
  const approvals = new Approvals();
  const hub = new SseHub();
  const token = crypto.randomBytes(24).toString('base64url');
  const startedAt = Date.now();
  let boundPort = port;

  function state(now = Date.now()) {
    const c = claude.usage;
    const x = codex.usage;
    return {
      app: 'claude-codex-cockpit',
      serverTime: now,
      usage: {
        claude: {
          fiveHour: describeWindow(c.five_hour, now),
          weekly: describeWindow(c.seven_day, now),
          updatedAt: c.updatedAt,
          planType: c.plan ?? null,
        },
        codex: {
          fiveHour: describeWindow(x?.fiveHour, now),
          weekly: describeWindow(x?.weekly, now),
          updatedAt: x?.updatedAt ?? null,
          planType: x?.planType ?? null,
          limitId: x?.limitId ?? null,
          reachedType: x?.reachedType ?? null,
          otherLimits: x?.otherLimits ?? [],
        },
      },
      approvals: approvals.list(),
      projects: groupSessions(sessions.sessions, approvals.list()),
    };
  }

  // Every API response is a change (timestamps move), but the log only needs a
  // line when the numbers a person would read are different.
  const lastLogged = {};
  function logUsage(provider, s = state()) {
    const line = usageLine(provider, s);
    const text = line.slice(10); // without the clock
    if (text === lastLogged[provider]) return;
    lastLogged[provider] = text;
    log(line);
  }

  const onUsageChange = (provider) => () => {
    const s = state();
    hub.broadcast('state', s);
    logUsage(provider, s);
  };

  approvals.on('change', () => hub.broadcast('state', state()));
  sessions.on('change', () => hub.broadcast('state', state()));
  approvals.on('settled', (item, decision, reason) => {
    log(`${clock()}  ${decision.padEnd(6)}  ${item.agent.padEnd(6)}  ${item.project}  ${item.title}  (${reason})`);
    if (audit) appendAudit(files.approvalsLog, item, decision, reason);
  });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log(`request failed: ${err.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function route(req, res) {
    if (!allowedHost(req) || !allowedOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    const pathname = req.url.split('?')[0];

    if (req.method === 'POST') {
      if (!hasToken(req)) return sendJson(res, 401, { error: 'missing or wrong token' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'expected application/json' });
      if (pathname === '/api/approvals') return openApproval(req, res);
      const match = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(pathname);
      if (match) return answerApproval(req, res, match[1]);
      return sendJson(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

    switch (pathname) {
      case '/':
        return sendPanel(res, token);
      case '/api/health':
        return sendJson(res, 200, { ok: true, app: 'claude-codex-cockpit', version, pid: process.pid, port: boundPort, startedAt });
      case '/api/state':
        return sendJson(res, 200, state());
      case '/api/events':
        hub.open(res);
        return hub.send(res, 'state', state());
    }
    if (STATIC[pathname]) return sendFile(res, ...STATIC[pathname]);
    sendJson(res, 404, { error: 'not found' });
  }

  // A hook waiting for the panel. The response stays open until the request is
  // settled; if the hook goes away first, the request leaves the panel.
  async function openApproval(req, res) {
    let body;
    try {
      body = await readJson(req, MAX_HOOK_BODY);
    } catch (err) {
      return sendJson(res, err.status || 400, { decision: 'none', error: err.message });
    }
    const { agent, payload } = body || {};
    if ((agent !== 'claude' && agent !== 'codex') || !payload || typeof payload !== 'object' || payload.hook_event_name !== 'PermissionRequest') {
      return sendJson(res, 400, { decision: 'none', error: 'expected a PermissionRequest from claude or codex' });
    }
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(1000, Number(body.waitMs) || 60_000));
    let answered = false;
    const item = approvals.open({
      agent,
      payload,
      waitMs,
      unattended: body.unattended === true,
      respond: (answer) => {
        answered = true;
        sendJson(res, 200, answer);
      },
    });
    log(`${clock()}  ask     ${agent.padEnd(6)}  ${item.project}  ${item.title}`);
    res.on('close', () => answered || approvals.drop(item.id));
  }

  async function answerApproval(req, res, id) {
    let body;
    try {
      body = await readJson(req, 4096);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    if (!['allow', 'deny', 'terminal'].includes(body?.decision)) return sendJson(res, 400, { error: 'decision must be allow, deny or terminal' });
    if (!approvals.decide(id, body.decision)) return sendJson(res, 404, { error: 'already answered or gone' });
    sendJson(res, 200, { ok: true });
  }

  function hasToken(req) {
    const got = Buffer.from(String(req.headers['x-cockpit-token'] || ''));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  // DNS rebinding: a hostile page can point its own hostname at 127.0.0.1,
  // but the browser will still send that hostname, not ours, as Host.
  function allowedHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
  }

  // Refuse anything a browser marks as coming from another site. The hook
  // script and curl send neither header.
  function allowedOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
  }

  function writeServerFile() {
    fs.mkdirSync(files.home, { recursive: true });
    const info = { app: 'claude-codex-cockpit', version, pid: process.pid, port: boundPort, token, startedAt };
    fs.writeFileSync(files.serverFile, JSON.stringify(info), { mode: 0o600 });
  }

  function removeServerFile() {
    try {
      const info = JSON.parse(fs.readFileSync(files.serverFile, 'utf8'));
      if (info.pid === process.pid && info.token === token) fs.unlinkSync(files.serverFile);
    } catch {}
  }

  return {
    server,
    claude,
    codex,
    sessions,
    approvals,
    state,
    logUsage,
    get port() {
      return boundPort;
    },
    get token() {
      return token;
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          boundPort = server.address().port;
          writeServerFile();
          // First scans are silent; main() prints the starting numbers.
          claude.start();
          codex.start();
          sessions.start(); // after codex: it reads codex.recentFiles
          claude.on('change', onUsageChange('claude'));
          codex.on('change', onUsageChange('codex'));
          resolve(boundPort);
        });
      });
    },
    stop() {
      approvals.closeAll();
      claude.stop();
      codex.stop();
      sessions.stop();
      hub.close();
      removeServerFile();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // The answers just sent to waiting hooks are still in flight.
        setTimeout(() => server.closeAllConnections(), 500).unref();
      });
    },
  };
}

const STATUS_RANK = { approval: 0, 'needs-you': 1, working: 2, interrupted: 3, 'your-turn': 4, quiet: 5 };
const rank = (s) => STATUS_RANK[s.status] ?? 9;
const newest = (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);

// One row per project folder, the most urgent first. A waiting approval turns
// its session's status to "approval" so the row can hold the request.
function groupSessions(sessions, approvals) {
  const pending = new Map();
  for (const a of approvals) {
    if (!a.sessionId) continue;
    if (!pending.has(a.sessionId)) pending.set(a.sessionId, []);
    pending.get(a.sessionId).push(a.id);
  }
  const rows = new Map();
  for (const { file, ...s } of sessions) {
    const key = folderKey(s.cwd);
    if (!rows.has(key)) rows.set(key, { key, project: s.project || s.cwd || 'unknown folder', cwd: s.cwd, sessions: [] });
    const approvalIds = pending.get(s.id) ?? [];
    rows.get(key).sessions.push({ ...s, status: approvalIds.length ? 'approval' : s.status, approvalIds });
  }
  for (const row of rows.values()) row.sessions.sort((a, b) => rank(a) - rank(b) || newest(a, b));
  return [...rows.values()].sort((a, b) => rank(a.sessions[0]) - rank(b.sessions[0]) || newest(a.sessions[0], b.sessions[0]));
}

// The same folder can arrive as D:\Repos\x and d:/repos/x/.
function folderKey(cwd) {
  const k = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendFile(res, rel, type) {
  fs.readFile(path.join(ROOT, rel), (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Security-Policy': PAGE_CSP });
    res.end(buf);
  });
}

// The panel page carries this run's token so its own clicks can be verified.
function sendPanel(res, token) {
  fs.readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8', (err, html) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP });
    res.end(html.replace(TOKEN_META, `<meta name="cockpit-token" content="${token}">`));
  });
}

// One JSON line per settled request, so you can check later what was approved.
function appendAudit(file, item, decision, reason) {
  const line = {
    at: new Date().toISOString(),
    agent: item.agent,
    project: item.project,
    cwd: item.cwd,
    tool: item.toolName,
    title: item.title,
    detail: item.detail.slice(0, 500),
    decision,
    reason,
  };
  fs.appendFile(file, `${JSON.stringify(line)}\n`, () => {});
}

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

function hasData(u) {
  return Boolean(u.fiveHour || u.weekly);
}

function usageLine(provider, s) {
  const u = s.usage[provider];
  const head = `${new Date(s.serverTime).toTimeString().slice(0, 8)}  ${provider.padEnd(6)}`;
  if (!hasData(u)) return `${head}  no data`;
  const age = u.updatedAt && s.serverTime - u.updatedAt > STALE_MS ? `  (as of ${formatDuration((s.serverTime - u.updatedAt) / 1000)} ago)` : '';
  return `${head}  ${windowText('5h', u.fiveHour)}  |  ${windowText('week', u.weekly)}${age}`;
}

function windowText(label, w) {
  if (!w) return `${label} no data`;
  if (w.level === 'reset') return `${label} reset, waiting for the next response`;
  const elapsed = `${Math.round(w.elapsedPct)}% of window gone`;
  return `${label} ${formatPercent(w.usedPercent)} ${w.level} (${elapsed}, resets in ${formatDuration(w.remainingSec)})`;
}

// Is an cockpit server already answering on this port?
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.app === 'claude-codex-cockpit' ? info : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function main() {
  const files = config.paths();
  let cfg = {};
  try {
    cfg = config.loadConfig();
  } catch (err) {
    console.error(`cockpit: ignoring ${files.config}: ${err.message}`);
  }
  const port = config.resolvePort(cfg);
  const app = createApp({ port, audit: cfg.approvals?.log !== false });
  try {
    await app.start();
  } catch (err) {
    const fix = `Set "port" in ${files.config} or the CLAUDE_CODEX_COCKPIT_PORT environment variable.`;
    if (err.code === 'EADDRINUSE') {
      const running = await probe(port);
      if (running) {
        console.log(`claude-codex-cockpit server already running on http://${HOST}:${port} (pid ${running.pid})`);
        return;
      }
      console.error(`cockpit: port ${port} is taken by another program. ${fix}`);
    } else if (err.code === 'EACCES') {
      console.error(
        `cockpit: Windows refused port ${port}, probably a reserved range ` +
          `(netsh interface ipv4 show excludedportrange protocol=tcp). ${fix}`,
      );
    } else {
      console.error(`cockpit: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`claude-codex-cockpit ${version} on http://${HOST}:${app.port}  (panel: /, raw state: /debug)`);
  console.log(`claude: watching ${files.claudeStatusline}`);
  console.log(`codex:  watching ${app.codex.sessionsDir}`);
  const s = app.state();
  if (hasData(s.usage.claude)) app.logUsage('claude', s);
  else console.log('claude: no rate limits yet. Connect "usage bars" (gear in the panel, or node bin/setup.js connect), then send one message in Claude Code');
  if (hasData(s.usage.codex)) app.logUsage('codex', s);
  else console.log('codex:  no rate limits yet. They appear after your first Codex turn');

  const shutdown = () => {
    setTimeout(() => process.exit(0), 1000).unref();
    app.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Started by the Electron window: go away with it, even if it crashed.
  const parentPid = Number(process.env.CLAUDE_CODEX_COCKPIT_PARENT_PID);
  if (parentPid) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') shutdown();
      }
    }, 2000).unref();
  }
}

if (require.main === module) main();

module.exports = { createApp, probe, groupSessions };
