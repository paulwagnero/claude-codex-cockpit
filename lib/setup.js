'use strict';
// Connects Claude Code and Codex to the cockpit, and disconnects them again.
//
//   claude-usage      statusLine in ~/.claude/settings.json (the usage bars)
//   claude-approvals  PermissionRequest hook in ~/.claude/settings.json
//   codex-approvals   PermissionRequest hook in ~/.codex/hooks.json
//
// Files are merged, never replaced: other settings and hooks stay as they are,
// an existing statusLine keeps running (chained, and restored on disconnect),
// a backup is written next to a file before it changes, and a file that isn't
// valid JSON is left alone. Every command written carries --cockpit, so it can
// be found again; so do entries pointing at this install's bin/ folder.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const shell = require('./shell');

const MARKER = '--cockpit';
const CLAUDE_HOOK_TIMEOUT = 3600; // Claude Code shows its own dialog meanwhile
const CODEX_HOOK_TIMEOUT = 60; // Codex holds its prompt until the hook gives up
const STATUSLINE_REFRESH = 60;
const PARTS = ['claude-usage', 'claude-approvals', 'codex-approvals'];

class SetupError extends Error {}

// Everything machine-specific, overridable for tests:
//   root  folder holding bin/ (the repo, or resources/app in a packaged build)
//   run   { node: 'node' } or { exe: <packaged app binary> }
function environment(overrides = {}) {
  return {
    platform: process.platform,
    root: path.join(__dirname, '..'),
    run: { node: 'node' },
    claudeDir: config.claudeDir(),
    codexHome: config.codexHome(),
    cockpitHome: config.home(),
    claudeShell: shell.claudeShell(),
    codexShell: shell.codexShell(),
    ...overrides,
  };
}

// ---- the commands we write ----

const script = (env, name) => path.join(env.root, 'bin', `${name}.js`);

function statusLineCommand(env) {
  return shell.commandLine(env.run, script(env, 'statusline'), [MARKER], env.claudeShell);
}

// Exec form (no shell, no quoting) wherever it can carry the command.
function claudeHookHandler(env) {
  const args = [script(env, 'permission-hook'), '--agent', 'claude', '--timeout', String(CLAUDE_HOOK_TIMEOUT), MARKER];
  const handler = { type: 'command', timeout: CLAUDE_HOOK_TIMEOUT };
  if (env.run.node) return { ...handler, command: env.run.node, args };
  // The packaged app runs our scripts as Node only with ELECTRON_RUN_AS_NODE=1.
  if (env.platform !== 'win32') return { ...handler, command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', env.run.exe, ...args] };
  return { ...handler, command: shell.commandLine(env.run, args[0], args.slice(1), env.claudeShell) };
}

function codexHookHandler(env) {
  const args = ['--agent', 'codex', '--timeout', String(CODEX_HOOK_TIMEOUT), MARKER];
  return {
    type: 'command',
    command: shell.commandLine(env.run, script(env, 'permission-hook'), args, env.codexShell),
    timeout: CODEX_HOOK_TIMEOUT,
    statusMessage: `Waiting for approval in Claude Codex Cockpit (terminal prompt in ${CODEX_HOOK_TIMEOUT}s)`,
  };
}

function isOurs(env, handler) {
  const text = [handler?.command, ...(Array.isArray(handler?.args) ? handler.args : [])].filter((s) => typeof s === 'string').join(' ');
  if (text.includes(MARKER)) return true;
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  return norm(text).includes(norm(path.join(env.root, 'bin')));
}

const sameHandler = (a, b) => canonical(a) === canonical(b);
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---- files ----

function readJsonFile(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: fallback, existed: false };
    throw err;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a BOM from Notepad
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SetupError(`${file} is not valid JSON (${err.message}). Left untouched.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SetupError(`${file} is not a JSON object. Left untouched.`);
  return { data, existed: true };
}

function writeJsonFile(file, data, existed, stamp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = existed ? `${file}.cockpit-backup-${stamp}` : null;
  if (backup) fs.copyFileSync(file, backup);
  const tmp = `${file}.cockpit-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return backup;
}

function files(env) {
  return {
    claude: path.join(env.claudeDir, 'settings.json'),
    codex: path.join(env.codexHome, 'hooks.json'),
    cockpit: path.join(env.cockpitHome, 'config.json'),
  };
}

// ---- status ----

function hookHandlers(root) {
  const groups = root?.hooks?.PermissionRequest;
  return (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []));
}

function hookState(env, root, wanted) {
  const ours = hookHandlers(root).filter((h) => isOurs(env, h));
  if (!ours.length) return 'off';
  return ours.length === 1 && sameHandler(ours[0], wanted) ? 'on' : 'outdated';
}

// state: on | off | outdated (ours, but written by another version or install
// path: reconnect to fix) | unavailable (the tool isn't installed)
function status(env = environment()) {
  const f = files(env);
  const result = { files: f };
  const claudeInstalled = fs.existsSync(env.claudeDir);
  const codexInstalled = fs.existsSync(env.codexHome);

  let claude;
  try {
    claude = readJsonFile(f.claude, {}).data;
  } catch (err) {
    claude = null;
    result.claudeError = err.message;
  }
  if (!claudeInstalled) {
    result['claude-usage'] = { state: 'unavailable' };
    result['claude-approvals'] = { state: 'unavailable' };
  } else if (!claude) {
    result['claude-usage'] = { state: 'error', note: result.claudeError };
    result['claude-approvals'] = { state: 'error', note: result.claudeError };
  } else {
    const sl = claude.statusLine;
    const ours = sl && isOurs(env, { command: sl.command });
    result['claude-usage'] = {
      state: !ours ? 'off' : sl.command === statusLineCommand(env) ? 'on' : 'outdated',
      ...(sl && !ours && { note: 'You already have a statusline. Connecting keeps it running.' }),
    };
    result['claude-approvals'] = { state: hookState(env, claude, claudeHookHandler(env)) };
  }

  if (!codexInstalled) {
    result['codex-approvals'] = { state: 'unavailable' };
  } else {
    try {
      const codex = readJsonFile(f.codex, {}).data;
      result['codex-approvals'] = { state: hookState(env, codex, codexHookHandler(env)) };
    } catch (err) {
      result['codex-approvals'] = { state: 'error', note: err.message };
    }
  }
  return result;
}

// ---- changes ----

function removeOurHooks(env, root) {
  const groups = root.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return false;
  let removed = false;
  const kept = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) {
      kept.push(g);
      continue;
    }
    const hooks = g.hooks.filter((h) => {
      if (!isOurs(env, h)) return true;
      removed = true;
      return false;
    });
    if (hooks.length) kept.push({ ...g, hooks });
  }
  if (kept.length) root.hooks.PermissionRequest = kept;
  else delete root.hooks.PermissionRequest;
  if (!Object.keys(root.hooks).length) delete root.hooks;
  return removed;
}

function addHook(env, root, handler) {
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) root.hooks = {};
  removeOurHooks(env, root); // replace any older version of ours
  if (!root.hooks) root.hooks = {};
  const groups = Array.isArray(root.hooks.PermissionRequest) ? root.hooks.PermissionRequest : [];
  root.hooks.PermissionRequest = [...groups, { hooks: [handler] }];
}

function connectStatusLine(env, settings, cockpit) {
  const current = settings.statusLine;
  const ours = current && isOurs(env, { command: current.command });
  let keep = {};
  if (current && typeof current === 'object') {
    // Theirs: keep it running through our script, and remember it exactly.
    if (!ours && current.type === 'command' && typeof current.command === 'string') {
      cockpit.statusLine = { ...(cockpit.statusLine || {}), chain: current.command, previous: current };
    }
    for (const k of ['padding', 'hideVimModeIndicator', 'refreshInterval']) if (current[k] !== undefined) keep[k] = current[k];
  }
  settings.statusLine = { type: 'command', command: statusLineCommand(env), refreshInterval: STATUSLINE_REFRESH, ...keep };
}

function disconnectStatusLine(env, settings, cockpit) {
  const current = settings.statusLine;
  if (!current || !isOurs(env, { command: current.command })) return false; // someone else's: not ours to touch
  if (cockpit.statusLine?.previous) settings.statusLine = cockpit.statusLine.previous;
  else delete settings.statusLine;
  if (cockpit.statusLine) {
    delete cockpit.statusLine.chain;
    delete cockpit.statusLine.previous;
    if (!Object.keys(cockpit.statusLine).length) delete cockpit.statusLine;
  }
  return true;
}

// action: 'connect' | 'disconnect'. Returns what changed, for the UI and CLI.
function apply(action, parts = PARTS, env = environment(), { dryRun = false } = {}) {
  if (action !== 'connect' && action !== 'disconnect') throw new SetupError(`unknown action: ${action}`);
  for (const p of parts) if (!PARTS.includes(p)) throw new SetupError(`unknown part: ${p}`);
  const f = files(env);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const connect = action === 'connect';
  const report = { action, changed: [], backups: [], messages: [], preview: {} };

  const wantsClaude = parts.includes('claude-usage') || parts.includes('claude-approvals');
  if (wantsClaude && fs.existsSync(env.claudeDir)) {
    const claude = readJsonFile(f.claude, {});
    const cockpit = readJsonFile(f.cockpit, {});
    const before = JSON.stringify(claude.data);
    const cockpitBefore = JSON.stringify(cockpit.data);
    if (parts.includes('claude-usage')) {
      if (connect) connectStatusLine(env, claude.data, cockpit.data);
      else disconnectStatusLine(env, claude.data, cockpit.data);
    }
    if (parts.includes('claude-approvals')) {
      if (connect) addHook(env, claude.data, claudeHookHandler(env));
      else removeOurHooks(env, claude.data);
    }
    if (JSON.stringify(claude.data) !== before) {
      report.preview[f.claude] = claude.data;
      if (!dryRun) report.backups.push(writeJsonFile(f.claude, claude.data, claude.existed, stamp));
      report.changed.push(f.claude);
    }
    if (JSON.stringify(cockpit.data) !== cockpitBefore) {
      report.preview[f.cockpit] = cockpit.data;
      if (!dryRun) writeJsonFile(f.cockpit, cockpit.data, false, stamp); // our own file: no backup needed
      report.changed.push(f.cockpit);
    }
  }

  if (parts.includes('codex-approvals') && fs.existsSync(env.codexHome)) {
    const codex = readJsonFile(f.codex, { description: 'Codex hooks (includes Claude Codex Cockpit approvals)' });
    const before = JSON.stringify(codex.data);
    if (connect) addHook(env, codex.data, codexHookHandler(env));
    else removeOurHooks(env, codex.data);
    if (JSON.stringify(codex.data) !== before) {
      report.preview[f.codex] = codex.data;
      if (!dryRun) report.backups.push(writeJsonFile(f.codex, codex.data, codex.existed, stamp));
      report.changed.push(f.codex);
      if (connect) report.messages.push('Codex runs a new or changed hook only after you trust it: start codex, type /hooks, and trust the Claude Codex Cockpit entry.');
    }
  }

  report.backups = report.backups.filter(Boolean);
  return report;
}

module.exports = {
  PARTS,
  MARKER,
  SetupError,
  environment,
  status,
  apply,
  statusLineCommand,
  claudeHookHandler,
  codexHookHandler,
  isOurs,
};
