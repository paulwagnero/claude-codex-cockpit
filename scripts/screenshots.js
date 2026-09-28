'use strict';
// Renders the README screenshots from made-up data, so no real session,
// prompt, path or account ever ends up in them.
//
//   node scripts/screenshots.js      -> docs/screenshots/*.png
//
// Starts a real server on a throwaway home with a fake Claude Code session
// registry and transcript, a fake Codex rollout and fake statusline
// snapshots, then points the Electron window at it in screenshot mode.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('../server');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const MIN = 60 * 1000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const line = (o) => JSON.stringify(o);
const sep = path.sep;
const folder = (name) => (process.platform === 'win32' ? `D:${sep}work${sep}${name}` : `/Users/you/work/${name}`);

function fixture(home) {
  const claudeDir = path.join(home, 'claude');
  const codexHome = path.join(home, 'codex');
  const shop = folder('shop-api');
  const blog = folder('blog');

  // Claude plan, as Claude Code caches it.
  fs.writeFileSync(path.join(home, 'claude.json'), line({ oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' } }));

  // A running Claude Code session: registry entry (pid = this process, so it counts as alive) and transcript.
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'sessions', `${process.pid}.json`), line({
    pid: process.pid, sessionId: 'demo-claude', cwd: shop, kind: 'interactive', status: 'busy', statusUpdatedAt: now - 3 * MIN, updatedAt: now - 3 * MIN,
  }));
  const tdir = path.join(claudeDir, 'projects', shop.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'demo-claude.jsonl'), [
    line({ type: 'ai-title', aiTitle: 'Rate limiting for the checkout API' }),
    line({ type: 'user', timestamp: iso(9 * MIN), message: { role: 'user', content: 'add rate limiting to /checkout, 20 req/min per user' } }),
    line({ type: 'assistant', timestamp: iso(7 * MIN), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${shop}${sep}src${sep}middleware${sep}rateLimit.ts`, old_string: 'a', new_string: 'b' } }] } }),
    line({ type: 'assistant', timestamp: iso(4 * MIN), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test -- checkout' } }] } }),
    line({ type: 'assistant', timestamp: iso(1 * MIN), message: { role: 'assistant', content: [{ type: 'text', text: 'All 48 checkout tests pass. Pushing the branch next.' }] } }),
  ].join('\n') + '\n');

  // A Codex session between turns, with its usage history.
  const cdir = path.join(codexHome, 'sessions', '2026', '09', '28');
  fs.mkdirSync(cdir, { recursive: true });
  const resets5h = Math.floor(now / 1000) + 3 * 3600 + 20 * 60;
  const tokenCount = (msAgo, used) => line({ timestamp: iso(msAgo), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: resets5h }, secondary: { used_percent: 71, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 2 * 86400 + 5 * 3600 }, plan_type: 'plus' } } });
  fs.writeFileSync(path.join(cdir, 'rollout-demo.jsonl'), [
    line({ timestamp: iso(60 * MIN), type: 'session_meta', payload: { session_id: 'demo-codex', id: 'demo-codex', cwd: blog, originator: 'codex-tui' } }),
    line({ timestamp: iso(30 * MIN), type: 'event_msg', payload: { type: 'task_started' } }),
    line({ timestamp: iso(29 * MIN), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'add a dark mode toggle to the post layout' }] } } }),
    tokenCount(28 * MIN, 12),
    line({ timestamp: iso(20 * MIN), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [`${blog}${sep}src${sep}layouts${sep}Post.astro`]: { type: 'update' } } } } }),
    tokenCount(19 * MIN, 15),
    line({ timestamp: iso(16 * MIN), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', parsed_cmd: [{ cmd: 'npm run build' }], status: 'completed' } } }),
    tokenCount(15 * MIN, 17),
    line({ timestamp: iso(14 * MIN), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Dark mode is in: the toggle remembers the choice. Build passes.' }] } } }),
    line({ timestamp: iso(14 * MIN), type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');

  return { claudeDir, codexHome, shop };
}

// Claude usage arrives one statusline snapshot at a time; feed a short burst.
function feedClaudeUsage(app, home) {
  const dir = path.join(home, 'claude-statusline');
  fs.mkdirSync(dir, { recursive: true });
  const resets5h = Math.floor(now / 1000) + 2 * 3600 + 35 * 60;
  const weekly = { used_percentage: 38, resets_at: Math.floor(now / 1000) + 4 * 86400 + 2 * 3600 };
  for (const [minAgo, used] of [[32, 41], [21, 49], [11, 56], [2, 62]]) {
    fs.writeFileSync(path.join(dir, 'demo-claude.json'), line({
      v: 1, writtenAt: now - minAgo * MIN, rateLimitsAt: now - minAgo * MIN,
      payload: { session_id: 'demo-claude', rate_limits: { five_hour: { used_percentage: used, resets_at: resets5h }, seven_day: weekly } },
    }));
    // Distinct mtimes, so each write is read as new.
    const t = new Date(now - minAgo * MIN);
    fs.utimesSync(path.join(dir, 'demo-claude.json'), t, t);
    app.claude.rescan();
  }
}

// Async on purpose: the demo server lives in this process and must keep
// answering while the window loads.
function shoot(port, home, name, { size = '380x620', hash = '' } = {}) {
  const file = path.join(OUT, `${name}.png`);
  fs.rmSync(file, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [ROOT], {
      env: {
        ...process.env,
        CLAUDE_CODEX_COCKPIT_HOME: home,
        CLAUDE_CODEX_COCKPIT_PORT: String(port),
        CLAUDE_CODEX_COCKPIT_SCREENSHOT: file,
        CLAUDE_CODEX_COCKPIT_SCREENSHOT_SIZE: size,
        CLAUDE_CODEX_COCKPIT_SCREENSHOT_HASH: hash,
        CLAUDE_CODEX_COCKPIT_SCREENSHOT_DELAY_MS: '1800',
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('exit', () => {
      clearTimeout(timer);
      if (!fs.existsSync(file)) return reject(new Error(`no screenshot for ${name}`));
      console.log(`wrote ${path.relative(ROOT, file)}`);
      resolve();
    });
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-shots-'));
  const { claudeDir, codexHome, shop } = fixture(home);
  const app = createApp({ port: 0, home, claudeDir, codexHome, claudeAccountFile: path.join(home, 'claude.json'), log: () => {} });
  await app.start();
  try {
    fs.mkdirSync(OUT, { recursive: true });
    feedClaudeUsage(app, home);
    app.sessions.rescan();
    await shoot(app.port, home, 'panel');

    app.approvals.open({
      agent: 'claude',
      waitMs: 3_595_000,
      respond: () => {},
      payload: {
        hook_event_name: 'PermissionRequest', session_id: 'demo-claude', cwd: shop, tool_name: 'Bash',
        tool_input: { command: 'git push origin feat/checkout-rate-limit', description: 'Push the rate limiting branch' },
      },
    });
    await shoot(app.port, home, 'approval', { size: '380x700' });
  } finally {
    await app.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
