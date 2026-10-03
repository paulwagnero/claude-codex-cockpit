'use strict';
// Claude Codex Cockpit on a Stream Deck: usage bars on keys, and Allow, Always
// or Deny for the request that waits.
//
// Stream Deck runs this file with its own Node (Nodejs 24 in manifest.json)
// and these arguments:
//   -port <n> -pluginUUID <id> -registerEvent <name> -info <json>
// It talks to Stream Deck over a WebSocket on that port, and to the cockpit the
// way the permission hook does: server.json for the port and token, then
// /api/events for the state and POST /api/approvals/:id for an answer. No npm
// packages: Node 24 has WebSocket built in.
//
// The deck doesn't need the app open: with no cockpit server running, the
// plugin starts one (see startServer). It only watches while its keys are in
// view; the server holds requests only while someone watches.
//
// The first time a Stream Deck Mini shows up, it switches to the profile that
// ships with this plugin (profiles/Cockpit Mini), once.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const keys = require('./keys');

const ROOT = path.join(fs.realpathSync(__dirname), '..', '..');
const config = require(path.join(ROOT, 'lib', 'config'));

const PLUGIN = 'io.github.paulwagnero.claude-codex-cockpit';
const PROFILE = 'profiles/Cockpit Mini';
const MINI = 1; // Stream Deck's device type for the Mini
const RETRY_MS = 3000;
const STARTING_RETRY_MS = 500;
const TICK_MS = 250; // the waiting request's border pulses every 500 ms
const LOG_MAX = 256 * 1024;
const NO_KEYS_MS = 5000;
const RESTART_AT_MOST_MS = 5 * 60 * 1000;

const files = config.paths();
const LOG = path.join(files.home, 'streamdeck.log');
const STATE_FILE = path.join(files.home, 'streamdeck.json');

const args = parseArgs(process.argv.slice(2));
const instances = new Map(); // context -> action name
const shown = new Map(); // context -> the SVG on it now
const firstSeen = new Map(); // approval id -> when the keys first showed it
let deck = null;
let cockpit = null; // { port, token } while the event stream is open
let stream = null; // that stream's request, to close it when no key is in view
let state = null;
let retry = null;
let refused = 0; // connections refused by a server that server.json says is alive
let server = null; // the cockpit server this plugin started, while it runs
let nextStart = 0;
let failedStarts = 0;
let noKeys = null;

// ---- Stream Deck ----

function connectDeck() {
  deck = new WebSocket(`ws://127.0.0.1:${args.port}`);
  deck.addEventListener('open', () => {
    send({ event: args.registerEvent, uuid: args.pluginUUID });
    log(`registered with Stream Deck ${args.info?.application?.version ?? '?'}`);
    for (const d of args.info?.devices ?? []) switchOnce(d.id, d);
    expectKeys();
  });
  deck.addEventListener('message', (e) => {
    try {
      onDeckEvent(JSON.parse(e.data));
    } catch (err) {
      log(`event failed: ${err.stack || err}`);
    }
  });
  // Stream Deck starts the plugin again when it needs it.
  deck.addEventListener('close', () => process.exit(0));
  deck.addEventListener('error', () => {});
}

function onDeckEvent(msg) {
  switch (msg.event) {
    case 'willAppear': {
      const action = actionName(msg.action);
      if (!action) return;
      instances.set(msg.context, action);
      shown.delete(msg.context);
      const at = msg.payload?.coordinates;
      log(`key ${action}${at ? ` at ${at.column},${at.row}` : ''}`);
      render();
      if (!stream) connectCockpit();
      return;
    }
    case 'willDisappear':
      instances.delete(msg.context);
      shown.delete(msg.context);
      // Another page, another profile, or the device unplugged: stop watching,
      // so the server stops holding requests for keys nobody sees.
      if (!instances.size) disconnect();
      return;
    case 'keyDown':
      if (instances.has(msg.context)) onKey(msg.context, instances.get(msg.context));
      return;
    case 'deviceDidConnect':
      log(`device ${msg.deviceInfo?.name ?? msg.device} connected (type ${msg.deviceInfo?.type})`);
      switchOnce(msg.device, msg.deviceInfo);
      expectKeys();
      return;
    case 'deviceDidDisconnect':
      log(`device ${msg.device} disconnected`);
      return;
    case 'systemDidWakeUp':
      shown.clear();
      render();
      return;
  }
}

function send(msg) {
  if (deck?.readyState === WebSocket.OPEN) deck.send(JSON.stringify(msg));
}

function actionName(uuid) {
  const name = typeof uuid === 'string' && uuid.startsWith(`${PLUGIN}.`) ? uuid.slice(PLUGIN.length + 1) : '';
  return keys.ACTIONS.includes(name) ? name : null;
}

// The Mini gets the cockpit layout the first time it shows up; Stream Deck
// asks before it installs the profile. After that the profile is yours.
function switchOnce(device, info) {
  if (info?.type !== MINI) return;
  const saved = readState();
  const done = Array.isArray(saved.switched) ? saved.switched : [];
  if (done.includes(device)) return;
  send({ event: 'switchToProfile', context: args.pluginUUID, device, payload: { profile: PROFILE } });
  writeState({ ...saved, switched: [...done, device] });
  log(`switched ${info.name || device} to ${PROFILE}`);
}

// Stream Deck doesn't always say which keys are showing: when it starts and
// the device attaches in the same moment, willAppear never comes, though a
// restarted plugin gets it at once (seen with 7.6.0). So if no key shows up
// soon after registering or a device connecting, restart once; Stream Deck
// starts the plugin again within seconds. At most every few minutes, so a
// device showing some other profile can't keep it restarting.
function expectKeys() {
  clearTimeout(noKeys);
  noKeys = setTimeout(() => {
    if (instances.size) return;
    const saved = readState();
    if (Date.now() - (saved.restartedAt ?? 0) < RESTART_AT_MOST_MS) return;
    writeState({ ...saved, restartedAt: Date.now() });
    log('no keys reported by Stream Deck: restarting to get them');
    process.exit(0);
  }, NO_KEYS_MS);
}

// ---- the keys ----

function view(now) {
  const ids = new Set((state?.approvals ?? []).map((a) => a.id));
  for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
  const first = state?.approvals?.[0];
  if (first && !firstSeen.has(first.id)) firstSeen.set(first.id, now);
  return keys.deckView(state, now, (id) => (firstSeen.get(id) ?? now) + keys.ARM_MS, Boolean(server) && !state);
}

function render() {
  const now = Date.now();
  const v = view(now);
  for (const [context, action] of instances) {
    const image = keys.face(action, v, now);
    if (shown.get(context) === image) continue;
    shown.set(context, image);
    send({ event: 'setImage', context, payload: { image: keys.dataUrl(image), target: 0 } });
  }
}

async function onKey(context, action) {
  const what = keys.keyAction(action, view(Date.now()), Date.now());
  if (what.ignore) return;
  if (what.refuse) {
    log(`${action}: ${what.refuse}`);
    return send({ event: 'showAlert', context });
  }
  const ok = await answer(what.id, what.decision);
  log(`${action}: ${what.decision} ${ok ? 'sent' : 'failed'}`);
  send({ event: ok ? 'showOk' : 'showAlert', context });
}

// ---- the cockpit ----

// Watches the cockpit while a key is in view; with none running, starts one.
function connectCockpit() {
  clearTimeout(retry);
  retry = null;
  if (stream || !instances.size) return;
  const info = readServerFile();
  if (!info || refused >= 3) {
    startServer();
    return later(server ? STARTING_RETRY_MS : RETRY_MS);
  }
  let done = false;
  const req = http.get({ host: '127.0.0.1', port: info.port, path: '/api/events', agent: false }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return end();
    }
    cockpit = info;
    refused = 0;
    log(`connected to the cockpit on port ${info.port}${server ? ' (started by the plugin)' : ''}`);
    res.setEncoding('utf8');
    const parse = sseParser((event, data) => {
      if (event !== 'state') return;
      state = JSON.parse(data);
      render();
    });
    res.on('data', parse);
    res.on('end', end);
    res.on('close', end);
    res.on('error', end);
  });
  req.on('error', () => {
    if (!cockpit) refused++;
    end();
  });
  stream = req;

  // The cockpit went away, or we stopped watching: the next tick shows that.
  // Its pending requests went with it; their hooks fall back to the terminal.
  function end() {
    if (done) return;
    done = true;
    if (cockpit) log('lost the cockpit');
    cockpit = null;
    state = null;
    stream = null;
    later(RETRY_MS);
  }
}

function later(ms) {
  if (!retry && instances.size) retry = setTimeout(connectCockpit, ms);
}

function disconnect() {
  clearTimeout(retry);
  retry = null;
  refused = 0;
  stream?.destroy();
}

// No cockpit running: start its server here, on Stream Deck's own Node, so
// the keys work without the app. It lives as long as this plugin does: with
// CLAUDE_CODEX_COCKPIT_PARENT_PID it shuts down within 2 s of the plugin going,
// so quitting Stream Deck stops it. The app reuses it when opened, and starts
// its own if this one goes away. Two starting at once is fine: the second
// finds the port taken and steps aside.
function startServer() {
  if (server || Date.now() < nextStart) return;
  let out = 'ignore';
  try {
    fs.mkdirSync(files.home, { recursive: true });
    out = fs.openSync(path.join(files.home, 'server.log'), 'a');
  } catch {}
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, CLAUDE_CODEX_COCKPIT_PARENT_PID: String(process.pid) },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  if (typeof out === 'number') fs.closeSync(out);
  server = child;
  refused = 0;
  log(`no cockpit running: started its server (pid ${child.pid})`);
  child.on('error', (err) => log(`could not start the cockpit server: ${err.message}`));
  child.on('exit', (code) => {
    if (server === child) server = null;
    // A quick exit 0 means another cockpit had the port: fine. A quick
    // failure (port taken by something else) backs off, up to a minute.
    failedStarts = code !== 0 && Date.now() - started < 10_000 ? failedStarts + 1 : 0;
    nextStart = failedStarts ? Date.now() + Math.min(60_000, RETRY_MS * 2 ** failedStarts) : 0;
    log(`the cockpit server stopped (exit ${code})`);
  });
}

function answer(id, decision) {
  return new Promise((resolve) => {
    if (!cockpit) return resolve(false);
    const body = JSON.stringify({ decision });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: cockpit.port,
        path: `/api/approvals/${id}`,
        method: 'POST',
        agent: false,
        timeout: 3000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Cockpit-Token': cockpit.token },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// Same checks as the hook: the server writes this file on start and removes
// it on stop; a dead pid means a crash left it behind.
function readServerFile() {
  try {
    const info = JSON.parse(fs.readFileSync(files.serverFile, 'utf8'));
    return Number.isInteger(info.port) && typeof info.token === 'string' && isAlive(info.pid) ? info : null;
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

// Server-Sent Events, as server/sse.js writes them: event and data lines,
// a blank line between events, comment lines as heartbeats.
function sseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  };
}

// ---- small things ----

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i + 1 < argv.length; i += 2) out[argv[i].replace(/^-+/, '')] = argv[i + 1];
  try {
    out.info = JSON.parse(out.info);
  } catch {
    out.info = null;
  }
  return out;
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(files.home, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {}
}

function log(line) {
  try {
    fs.mkdirSync(files.home, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
  } catch {}
}

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    log(`crashed: ${err.stack || err}`);
    process.exit(1);
  });
  log(`starting (node ${process.versions.node}, ${ROOT})`);
  connectDeck();
  setInterval(render, TICK_MS);
}

module.exports = { sseParser, parseArgs, actionName };
