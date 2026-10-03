'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const setup = require('../lib/setup');
const shell = require('../lib/shell');
const { tempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');

// A machine with Claude Code and Codex installed, both still unconfigured,
// and no Stream Deck app (its folder is never created here).
function machine(t, overrides = {}) {
  const dir = tempDir(t);
  const env = setup.environment({
    root: ROOT,
    run: { node: 'node' },
    claudeDir: path.join(dir, '.claude'),
    codexHome: path.join(dir, '.codex'),
    cockpitHome: path.join(dir, '.claude-codex-cockpit'),
    streamDeckDir: path.join(dir, 'StreamDeck'),
    claudeShell: 'sh',
    codexShell: 'cmd',
    ...overrides,
  });
  fs.mkdirSync(env.claudeDir, { recursive: true });
  fs.mkdirSync(env.codexHome, { recursive: true });
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const files = setup.status(env).files;
  return { env, files, read };
}

const states = (s) => setup.PARTS.map((p) => s[p].state);

test('connect on a clean machine creates both files, and everything reads as on', (t) => {
  const { env, files, read } = machine(t);
  assert.deepEqual(states(setup.status(env)), ['off', 'off', 'off', 'unavailable']);
  const report = setup.apply('connect', setup.PARTS, env);
  assert.deepEqual(report.backups, [], 'nothing existed, so nothing to back up');
  assert.deepEqual(states(setup.status(env)), ['on', 'on', 'on', 'unavailable']);
  const claude = read(files.claude);
  assert.match(claude.statusLine.command, /statusline\.js" --cockpit$/);
  assert.equal(claude.statusLine.refreshInterval, 60);
  assert.equal(claude.hooks.PermissionRequest[0].hooks[0].command, 'node');
  assert.deepEqual(claude.hooks.PermissionRequest[0].hooks[0].args.slice(1), ['--agent', 'claude', '--timeout', '3600', '--cockpit']);
  const codex = read(files.codex);
  assert.match(codex.hooks.PermissionRequest[0].hooks[0].command, /^node ".+permission-hook\.js" --agent codex --timeout 60 --cockpit$/);
  assert.match(report.messages[0], /\/hooks/);
});

test('connect keeps everything else, and connecting twice changes nothing', (t) => {
  const { env, files, read } = machine(t);
  const theirs = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
      PermissionRequest: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-own-hook' }] }],
    },
  };
  fs.writeFileSync(files.claude, JSON.stringify(theirs));
  const first = setup.apply('connect', ['claude-approvals'], env);
  assert.equal(first.backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.backups[0], 'utf8')), theirs, 'the backup is the file as it was');
  const after = read(files.claude);
  assert.deepEqual(after.permissions, theirs.permissions);
  assert.deepEqual(after.hooks.PreToolUse, theirs.hooks.PreToolUse);
  assert.deepEqual(after.hooks.PermissionRequest[0], theirs.hooks.PermissionRequest[0], 'their hook comes first, untouched');
  assert.equal(after.hooks.PermissionRequest.length, 2);
  assert.deepEqual(setup.apply('connect', ['claude-approvals'], env).changed, [], 'idempotent');
});

test('an existing statusline keeps running (chained) and comes back exactly on disconnect', (t) => {
  const { env, files, read } = machine(t);
  const previous = { type: 'command', command: 'bash ~/.claude/my-line.sh', padding: 2 };
  fs.writeFileSync(files.claude, JSON.stringify({ statusLine: previous }));
  assert.match(setup.status(env)['claude-usage'].note, /keeps it running/);
  setup.apply('connect', ['claude-usage'], env);
  const cockpit = read(files.cockpit);
  assert.equal(cockpit.statusLine.chain, previous.command, 'our statusline runs theirs');
  assert.equal(read(files.claude).statusLine.padding, 2, 'their padding is kept');
  setup.apply('disconnect', ['claude-usage'], env);
  assert.deepEqual(read(files.claude).statusLine, previous);
  assert.equal(read(files.cockpit).statusLine, undefined);
});

test('an install from before the marker is recognized and replaced, not duplicated', (t) => {
  const { env, files, read } = machine(t);
  const legacy = {
    statusLine: { type: 'command', command: `node ${path.join(ROOT, 'bin', 'statusline.js').replace(/\\/g, '/')}`, refreshInterval: 60 },
    hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'node', args: [path.join(ROOT, 'bin', 'permission-hook.js'), '--agent', 'claude', '--timeout', '3600'], timeout: 3600 }] }] },
  };
  fs.writeFileSync(files.claude, JSON.stringify(legacy));
  assert.deepEqual(states(setup.status(env)).slice(0, 2), ['outdated', 'outdated']);
  setup.apply('connect', ['claude-usage', 'claude-approvals'], env);
  const after = read(files.claude);
  assert.equal(after.hooks.PermissionRequest.length, 1);
  assert.equal(fs.existsSync(files.cockpit), false, 'our own old statusline is not chained to itself');
  assert.deepEqual(states(setup.status(env)).slice(0, 2), ['on', 'on']);
});

test('disconnect removes only ours and tidies empty containers', (t) => {
  const { env, files, read } = machine(t);
  fs.writeFileSync(files.codex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
  setup.apply('connect', setup.PARTS, env);
  setup.apply('disconnect', setup.PARTS, env);
  assert.deepEqual(read(files.codex), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
  assert.deepEqual(read(files.claude), {});
  assert.deepEqual(states(setup.status(env)), ['off', 'off', 'off', 'unavailable']);
});

test('a settings file that is not valid JSON is refused and left byte-for-byte alone', (t) => {
  const { env, files } = machine(t);
  const broken = '{ "model": "opus", // comments are not JSON\n}';
  fs.writeFileSync(files.claude, broken);
  assert.throws(() => setup.apply('connect', ['claude-usage'], env), setup.SetupError);
  assert.equal(fs.readFileSync(files.claude, 'utf8'), broken);
  assert.equal(setup.status(env)['claude-usage'].state, 'error');
});

test('a tool that is not installed is reported, and skipped', (t) => {
  const { env } = machine(t);
  fs.rmSync(env.codexHome, { recursive: true });
  assert.equal(setup.status(env)['codex-approvals'].state, 'unavailable');
  assert.deepEqual(setup.apply('connect', ['codex-approvals'], env).changed, []);
  assert.equal(fs.existsSync(env.codexHome), false, 'no .codex folder is created for someone without Codex');
});

// A Stream Deck app, and a stand-in install whose plugin folder gets linked:
// a test never links the real one.
function withStreamDeck(t) {
  const fake = path.join(tempDir(t), 'app');
  const plugin = path.join(fake, 'streamdeck', 'io.github.paulwagnero.claude-codex-cockpit.sdPlugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'manifest.json'), '{}');
  const m = machine(t, { root: fake });
  fs.mkdirSync(m.env.streamDeckDir);
  return { ...m, plugin };
}

test('Stream Deck: connect links the plugin in, disconnect removes only the link', (t) => {
  const { env, files, plugin } = withStreamDeck(t);
  assert.equal(setup.status(env).streamdeck.state, 'off');
  const report = setup.apply('connect', ['streamdeck'], env);
  assert.deepEqual(report.changed, [files.streamdeck]);
  assert.match(report.messages[0], /start it again/);
  assert.equal(setup.status(env).streamdeck.state, 'on');
  assert.ok(fs.lstatSync(files.streamdeck).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(files.streamdeck, 'manifest.json')), 'the link leads to the plugin');
  assert.deepEqual(setup.apply('connect', ['streamdeck'], env).changed, [], 'connecting twice changes nothing');
  setup.apply('disconnect', ['streamdeck'], env);
  assert.equal(fs.existsSync(files.streamdeck), false);
  assert.ok(fs.existsSync(path.join(plugin, 'manifest.json')), 'the plugin itself is untouched');
  assert.equal(setup.status(env).streamdeck.state, 'off');
});

test('Stream Deck: a link to another install is replaced; a copied plugin is left alone', (t) => {
  const { env, files } = withStreamDeck(t);
  const old = path.join(tempDir(t), 'old-install');
  fs.mkdirSync(old);
  fs.mkdirSync(path.dirname(files.streamdeck), { recursive: true });
  fs.symlinkSync(old, files.streamdeck, 'junction');
  assert.equal(setup.status(env).streamdeck.state, 'outdated');
  setup.apply('connect', ['streamdeck'], env);
  assert.equal(setup.status(env).streamdeck.state, 'on');
  assert.ok(fs.existsSync(old), "the old link's target is not deleted");

  fs.unlinkSync(files.streamdeck);
  fs.mkdirSync(files.streamdeck);
  fs.writeFileSync(path.join(files.streamdeck, 'manifest.json'), '{}');
  assert.equal(setup.status(env).streamdeck.state, 'error');
  assert.throws(() => setup.apply('connect', ['streamdeck'], env), setup.SetupError);
  setup.apply('disconnect', ['streamdeck'], env);
  assert.ok(fs.existsSync(path.join(files.streamdeck, 'manifest.json')), 'a real folder is never removed');
});

test('Stream Deck: not installed means nothing to do', (t) => {
  const { env } = machine(t);
  assert.equal(setup.status(env).streamdeck.state, 'unavailable');
  assert.deepEqual(setup.apply('connect', ['streamdeck'], env).changed, []);
  assert.equal(fs.existsSync(env.streamDeckDir), false);
});

test('dry run reports without writing', (t) => {
  const { env, files } = machine(t);
  const report = setup.apply('connect', setup.PARTS, env, { dryRun: true });
  assert.deepEqual(report.changed, [files.claude, files.codex], 'nothing to chain, so our own config.json stays as it is');
  assert.equal(fs.existsSync(files.claude), false);
  assert.equal(fs.existsSync(files.codex), false);
});

test('packaged app: each shell gets its own way of setting ELECTRON_RUN_AS_NODE', () => {
  const exe = 'C:/Program Files/Claude Codex Cockpit/claude-codex-cockpit.exe';
  const base = { root: 'C:/Program Files/Claude Codex Cockpit/resources/app', run: { exe } };
  const win = (claudeShell) => setup.environment({ ...base, platform: 'win32', claudeShell, codexShell: 'cmd' });
  assert.equal(
    setup.statusLineCommand(win('sh')),
    'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Claude Codex Cockpit/claude-codex-cockpit.exe" "C:/Program Files/Claude Codex Cockpit/resources/app/bin/statusline.js" --cockpit',
  );
  assert.match(setup.statusLineCommand(win('powershell')), /^\$env:ELECTRON_RUN_AS_NODE=1; & "C:\/Program Files\/.+\.exe" /);
  assert.match(setup.codexHookHandler(win('sh')).command, /^set "ELECTRON_RUN_AS_NODE=1" && "C:\\Program Files\\Claude Codex Cockpit\\claude-codex-cockpit\.exe" "C:\\Program Files\\.+\\permission-hook\.js" --agent codex/);
  assert.equal(setup.claudeHookHandler(win('sh')).args, undefined, 'Windows: shell form, since exec form cannot set the variable');
  const mac = setup.claudeHookHandler(setup.environment({ platform: 'darwin', root: '/Applications/Claude Codex Cockpit.app/Contents/Resources/app', run: { exe: '/Applications/Claude Codex Cockpit.app/Contents/MacOS/Claude Codex Cockpit' }, claudeShell: 'sh' }));
  assert.equal(mac.command, '/usr/bin/env');
  assert.deepEqual(mac.args.slice(0, 2), ['ELECTRON_RUN_AS_NODE=1', '/Applications/Claude Codex Cockpit.app/Contents/MacOS/Claude Codex Cockpit']);
});

test('paths with quotes or shell metacharacters are refused rather than half-quoted', () => {
  assert.throws(() => shell.quote('C:/a"b/x.exe', 'sh'), /unsupported character/);
  assert.throws(() => shell.quote('/home/$USER/x', 'sh'), /unsupported character/);
});

// The generated command lines, executed for real in the shells that will run
// them, with the dev Electron binary standing in for the packaged app.
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const gitBash = shell.findGitBash();
const payload = JSON.stringify({ session_id: 'cmd-check', model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 12 } });

test('generated statusLine command runs in Git Bash with the packaged-style runtime', { skip: !(gitBash && fs.existsSync(electronExe)) && 'needs Git Bash and the Electron binary' }, (t) => {
  const home = tempDir(t);
  const cmd = setup.statusLineCommand(setup.environment({ root: ROOT, run: { exe: electronExe }, claudeShell: 'sh' }));
  const out = execFileSync(gitBash, ['-c', cmd], { input: payload, env: { ...process.env, CLAUDE_CODEX_COCKPIT_HOME: home, NO_COLOR: '1' } }).toString();
  assert.equal(out, 'Opus 5.5 · ctx 12%\n');
  assert.ok(fs.existsSync(path.join(home, 'claude-statusline', 'cmd-check.json')));
});

test('generated Codex hook command runs in cmd.exe and steps aside when no panel runs', { skip: (process.platform !== 'win32' || !fs.existsSync(electronExe)) && 'Windows only' }, (t) => {
  const home = tempDir(t);
  const cmd = setup.codexHookHandler(setup.environment({ root: ROOT, run: { exe: electronExe }, codexShell: 'cmd' })).command;
  const r = spawnSync(process.env.COMSPEC || 'cmd.exe', ['/C', cmd], {
    input: JSON.stringify({ hook_event_name: 'PermissionRequest', turn_id: 't', tool_name: 'Bash', tool_input: { command: 'x' } }),
    env: { ...process.env, CLAUDE_CODEX_COCKPIT_HOME: home },
    windowsVerbatimArguments: true,
  });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(r.stdout.toString(), '');
});

test('generated PowerShell statusLine command runs too', { skip: (process.platform !== 'win32' || !fs.existsSync(electronExe)) && 'Windows only' }, (t) => {
  const home = tempDir(t);
  const cmd = setup.statusLineCommand(setup.environment({ root: ROOT, run: { exe: electronExe }, claudeShell: 'powershell' }));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { input: payload, env: { ...process.env, CLAUDE_CODEX_COCKPIT_HOME: home, NO_COLOR: '1' } });
  assert.equal(r.stdout.toString().trim(), 'Opus 5.5 · ctx 12%');
});
