'use strict';
// cockpit window: always on top, frameless, remembers where you put it.
// Reuses a server that is already running (npm run server, or the one the
// Stream Deck plugin starts), otherwise starts one as a child process with
// Electron's own Node, so no system Node is needed.

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const setup = require('../lib/setup');
const { probe } = require('../server');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
// In a packaged build the executable carries the icon; these cover `npm start`.
const ICON = path.join(ROOT, 'build', process.platform === 'win32' ? 'icon.ico' : path.join('icons', '512.png'));
// Groups the taskbar button under our own name and icon instead of Electron's.
const APP_ID = 'io.github.paulwagnero.claude-codex-cockpit';
const WINDOW_FILE = path.join(config.home(), 'window.json');
const DEFAULT_SIZE = { width: 360, height: 400 };

let port;
let origin;
let win = null;
let serverChild = null;
let ensuring = null;
let quitting = false;

// Dev aid: CLAUDE_CODEX_COCKPIT_SCREENSHOT=out.png renders the panel to a file and quits.
// It runs beside a live panel: own profile, no single-instance lock, and the
// saved window position is neither used nor overwritten.
const SCREENSHOT = process.env.CLAUDE_CODEX_COCKPIT_SCREENSHOT;
if (SCREENSHOT) {
  app.disableHardwareAcceleration(); // capturePage fails with UnknownVizError under GPU compositing
  app.setPath('userData', path.join(app.getPath('temp'), 'cockpit-screenshot'));
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!SCREENSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
  });
  app.whenReady().then(start);
}

async function start() {
  let cfg = {};
  try {
    cfg = config.loadConfig();
  } catch {
    // The server reports a broken config.json; the window just uses defaults.
  }
  port = config.resolvePort(cfg);
  origin = `http://${HOST}:${port}`;
  if (process.platform === 'darwin' && fs.existsSync(ICON)) app.dock?.setIcon(ICON);
  await ensureServer();
  createWindow();
  // A reused server can go away without us (the Stream Deck plugin's stops
  // when Stream Deck quits): then start ours.
  setInterval(() => serverChild || quitting || ensureServer(), 5000);
}

function ensureServer() {
  ensuring ??= (async () => {
    if (await probe(port)) return;
    startServer();
    for (let i = 0; i < 50 && !(await probe(port)); i++) await sleep(100);
  })().finally(() => (ensuring = null));
  return ensuring;
}

function startServer() {
  fs.mkdirSync(config.home(), { recursive: true });
  const log = fs.openSync(path.join(config.home(), 'server.log'), 'a');
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODEX_COCKPIT_PARENT_PID: String(process.pid) },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  serverChild.on('exit', () => {
    serverChild = null;
    if (!quitting) setTimeout(ensureServer, 2000);
  });
}

function createWindow() {
  const saved = SCREENSHOT ? screenshotWindowState() : loadWindowState();
  win = new BrowserWindow({
    ...DEFAULT_SIZE,
    ...saved.bounds,
    minWidth: 260,
    minHeight: 120,
    frame: false,
    alwaysOnTop: saved.pinned,
    backgroundColor: '#0d0f12',
    title: 'Claude Codex Cockpit',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Approvals must render and flash even while the window is minimized.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // The page comes from the local server and must never leave it.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) setTimeout(() => win && !win.isDestroyed() && win.loadURL(`${origin}/`), 1500);
  });
  // CLAUDE_CODEX_COCKPIT_SCREENSHOT_HASH=setup opens a screenshot on that view.
  win.loadURL(`${origin}/${SCREENSHOT && process.env.CLAUDE_CODEX_COCKPIT_SCREENSHOT_HASH ? `#${process.env.CLAUDE_CODEX_COCKPIT_SCREENSHOT_HASH}` : ''}`);

  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(saveWindowState, 400);
  };
  if (!SCREENSHOT) {
    win.on('move', save);
    win.on('resize', save);
    win.on('close', saveWindowState);
  }
  win.on('closed', () => (win = null));

  if (SCREENSHOT) screenshotAndQuit(SCREENSHOT);
}

// CLAUDE_CODEX_COCKPIT_SCREENSHOT_SIZE=360x620 picks the window size for a screenshot.
function screenshotWindowState() {
  const [width, height] = String(process.env.CLAUDE_CODEX_COCKPIT_SCREENSHOT_SIZE || '').split('x').map(Number);
  return { bounds: width > 0 && height > 0 ? { width, height } : {}, pinned: false };
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
    const b = s.bounds || {};
    const pinned = s.pinned !== false;
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { bounds: {}, pinned };
    // Restore the position only if it still lands on a connected display;
    // the second monitor may be unplugged.
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width - 60 && b.x + b.width > a.x + 60 && b.y >= a.y - 8 && b.y < a.y + a.height - 40);
    return { bounds: onScreen ? b : { width: b.width, height: b.height }, pinned };
  } catch {
    return { bounds: {}, pinned: true };
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.mkdirSync(path.dirname(WINDOW_FILE), { recursive: true });
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ bounds: win.getBounds(), pinned: win.isAlwaysOnTop() }));
  } catch {}
}

// Only our own page may drive the window.
function fromPanel(event) {
  return Boolean(win) && event.sender === win.webContents && event.senderFrame?.url.startsWith(`${origin}/`);
}

ipcMain.on('cockpit:close', (e) => fromPanel(e) && win.close());
ipcMain.on('cockpit:minimize', (e) => fromPanel(e) && win.minimize());
ipcMain.handle('cockpit:pinned', (e) => fromPanel(e) && win.isAlwaysOnTop());
ipcMain.handle('cockpit:pin', (e, on) => {
  if (!fromPanel(e)) return false;
  win.setAlwaysOnTop(Boolean(on));
  saveWindowState();
  return win.isAlwaysOnTop();
});
// Connections (lib/setup.js). A packaged build runs our scripts with its own
// binary as Node; a clone runs them with the system's node.
function setupEnv() {
  return setup.environment({ root: ROOT, run: app.isPackaged ? { exe: process.execPath } : { node: 'node' } });
}
ipcMain.handle('cockpit:setup-status', (e) => (fromPanel(e) ? setup.status(setupEnv()) : null));
ipcMain.handle('cockpit:setup-apply', (e, action, parts) => {
  if (!fromPanel(e)) return null;
  try {
    const { changed, backups, messages } = setup.apply(action, parts, setupEnv());
    return { ok: true, changed, backups, messages, status: setup.status(setupEnv()) };
  } catch (err) {
    return { ok: false, error: err instanceof setup.SetupError ? err.message : String(err.message || err) };
  }
});

// A request is waiting: bring the panel back without taking focus from the
// editor, and flash its taskbar button until nothing is pending.
ipcMain.on('cockpit:attention', (e, on) => {
  if (!fromPanel(e)) return;
  if (on) {
    if (win.isMinimized() || !win.isVisible()) win.showInactive();
    if (!win.isAlwaysOnTop()) win.moveTop();
  }
  win.flashFrame(Boolean(on));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (serverChild) serverChild.kill();
});

function screenshotAndQuit(file) {
  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(Number(process.env.CLAUDE_CODEX_COCKPIT_SCREENSHOT_DELAY_MS) || 1500);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
    } catch (err) {
      console.error(`screenshot failed: ${err.message}`);
    }
    app.quit();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
