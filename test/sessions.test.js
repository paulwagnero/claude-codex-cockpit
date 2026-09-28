'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SessionsSource, parseClaudeTranscript, parseCodexRollout, toolLine } = require('../server/sessions');
const { groupSessions } = require('../server');
const { tempDir } = require('./helpers');

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s) => new Date(Date.UTC(2026, 8, 28, 12, 0, s)).toISOString();

// ---- Claude Code transcript ----

const claudeTranscript = jsonl(
  { type: 'ai-title', aiTitle: 'Old title' },
  { type: 'user', timestamp: ts(1), message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' } },
  { type: 'user', timestamp: ts(2), message: { role: 'user', content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>max</command-args>' } },
  { type: 'user', timestamp: ts(3), isMeta: true, message: { role: 'user', content: 'meta, not yours' } },
  { type: 'user', timestamp: ts(4), message: { role: 'user', content: [{ type: 'text', text: 'run the tests please' }] } },
  { type: 'assistant', timestamp: ts(5), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: '**Running** them `now`.' }] } },
  { type: 'assistant', timestamp: ts(6), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\n--verbose' } }] } },
  { type: 'user', timestamp: ts(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', timestamp: ts(8), isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent talking' }] } },
  { type: 'ai-title', aiTitle: 'Fix the flaky tests' },
);

test('Claude transcript: title, your words, its words and tool calls; noise and subagents left out', () => {
  const t = parseClaudeTranscript(claudeTranscript, '/work/shop');
  assert.equal(t.title, 'Fix the flaky tests');
  assert.equal(t.interrupted, false);
  assert.equal(t.lastAt, Date.parse(ts(8)));
  assert.deepEqual(
    t.recent.map(({ kind, text }) => [kind, text]),
    [
      ['you', '/effort max'],
      ['you', 'run the tests please'],
      ['agent', 'Running them now.'],
      ['tool', 'Bash npm test --verbose'],
    ],
  );
});

test('Claude transcript: a stopped turn reads as interrupted until the next message', () => {
  const stopped = jsonl({ type: 'user', timestamp: ts(9), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.equal(parseClaudeTranscript(claudeTranscript + stopped, '').interrupted, true);
  const again = jsonl({ type: 'user', timestamp: ts(10), message: { role: 'user', content: 'go on' } });
  assert.equal(parseClaudeTranscript(claudeTranscript + stopped + again, '').interrupted, false);
});

test('tool lines name the tool and its target', () => {
  assert.equal(toolLine('Edit', { file_path: path.resolve('/w/src/a.js'), old_string: 'x', new_string: 'y' }, path.resolve('/w')), `Edit ${path.join('src', 'a.js')}`);
  assert.equal(toolLine('Task', { description: 'Find usages' }, ''), 'Task Find usages');
  assert.equal(toolLine('WebFetch', { url: 'https://example.com' }, ''), 'WebFetch https://example.com');
});

// ---- Codex rollout ----

const codexHead = jsonl({ timestamp: ts(0), type: 'session_meta', payload: { session_id: 'cx-1', id: 'cx-1', cwd: 'D:\\Repos\\astro', originator: 'codex-tui' } });
const codexEvents = (...events) => jsonl(...events.map(([s, payload, type = 'event_msg']) => ({ timestamp: ts(s), type, payload })));

test('Codex rollout: session id, folder, messages and the turn lifecycle', () => {
  const tail = codexEvents(
    [1, { type: 'task_started', turn_id: 'a' }],
    [2, { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'where are we?' }] } }],
    [3, { type: 'item_completed', item: { type: 'CommandExecution', parsed_cmd: [{ cmd: 'git status' }], command: ['pwsh', '-Command', 'git status'], status: 'completed' } }],
    [4, { type: 'item_completed', item: { type: 'FileChange', changes: { 'D:\\Repos\\astro\\HANDOVER.md': { type: 'update' } } } }],
    [5, { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'All clean, see :codex-file-citation{path="D:/Repos/astro/HANDOVER.md" line_start=1}' }] } }],
    [6, { type: 'task_complete', turn_id: 'a' }],
  );
  const r = parseCodexRollout(codexHead, tail);
  assert.equal(r.id, 'cx-1');
  assert.equal(r.cwd, 'D:\\Repos\\astro');
  assert.equal(r.status, 'your-turn');
  assert.deepEqual(r.recent.map(({ kind, text }) => [kind, text]), [
    ['you', 'where are we?'],
    ['tool', 'Run git status'],
    ['tool', 'Edit HANDOVER.md'],
    ['agent', 'All clean, see HANDOVER.md'],
  ]);
});

test('Codex rollout: started is working, aborted is interrupted', () => {
  assert.equal(parseCodexRollout(codexHead, codexEvents([1, { type: 'task_started' }])).status, 'working');
  const aborted = parseCodexRollout(codexHead, codexEvents([1, { type: 'task_started' }], [2, { type: 'turn_aborted', reason: 'interrupted' }]));
  assert.equal(aborted.status, 'interrupted');
  assert.deepEqual(aborted.recent.at(-1).text, 'interrupted');
});

// ---- the live source ----

const deadPid = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('close', () => resolve(child.pid));
  });

test('Claude sessions come from the registry: live pid only, status from Claude Code itself', async (t) => {
  const claudeDir = tempDir(t);
  const cwd = path.join(claudeDir, 'work', 'shop');
  const registry = path.join(claudeDir, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'live-1', cwd, name: 'shop-1', kind: 'interactive', status: 'busy', statusUpdatedAt: 1000 }));
  const dead = await deadPid();
  fs.writeFileSync(path.join(registry, `${dead}.json`), JSON.stringify({ pid: dead, sessionId: 'crashed', cwd, status: 'busy' }));
  fs.writeFileSync(path.join(registry, `${process.pid}.deadbeef.key`), 'secret: never read'); // must be ignored
  const transcriptDir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'live-1.jsonl'), claudeTranscript);

  const src = new SessionsSource({ claudeDir });
  src.rescan();
  assert.equal(src.sessions.length, 1, 'the crashed session is left out');
  const s = src.sessions[0];
  assert.equal(s.agent, 'claude');
  assert.equal(s.status, 'working');
  assert.equal(s.title, 'Fix the flaky tests');
  assert.equal(s.project, 'shop');
  assert.equal(s.statusSince, 1000);
  assert.equal(s.recent.at(-1).text, 'Bash npm test --verbose');

  fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'live-1', cwd, status: 'waiting', waitingFor: 'input needed' }));
  src.rescan();
  assert.equal(src.sessions[0].status, 'needs-you');
  assert.equal(src.sessions[0].waitingFor, 'input needed');
});

test('Codex sessions come from recent rollouts; an old "working" one reads as quiet', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'rollout-a.jsonl');
  fs.writeFileSync(file, codexHead + codexEvents([1, { type: 'task_started' }]));
  const now = Date.now();
  const codexUsage = { recentFiles: [{ file, mtimeMs: now - 1000, size: 1 }] };
  const src = new SessionsSource({ claudeDir: path.join(dir, 'no-claude'), codexUsage });
  src.rescan(now);
  assert.equal(src.sessions[0].agent, 'codex');
  assert.equal(src.sessions[0].status, 'working');
  codexUsage.recentFiles[0].mtimeMs = now - 25 * 60 * 1000;
  src.rescan(now);
  assert.equal(src.sessions[0].status, 'quiet');
  codexUsage.recentFiles[0].mtimeMs = now - 9 * 3600 * 1000;
  src.rescan(now);
  assert.equal(src.sessions.length, 0, 'not touched in 8 hours: not listed');
});

test('rows: one per folder, a pending approval marks its session and goes first', () => {
  const s = (agent, id, cwd, status, lastActivityAt) => ({ agent, id, cwd, project: cwd.split(/[\\/]/).pop(), status, lastActivityAt, recent: [], file: 'x' });
  const rows = groupSessions(
    [
      s('claude', 'a', 'D:\\Repos\\shop', 'your-turn', 5),
      s('codex', 'b', 'd:/repos/shop/', 'working', 4),
      s('claude', 'c', 'D:\\Repos\\blog', 'your-turn', 9),
    ],
    [{ id: 'ap-1', sessionId: 'c' }],
  );
  assert.deepEqual(rows.map((r) => r.project), ['blog', 'shop']);
  assert.equal(rows[0].sessions[0].status, 'approval');
  assert.deepEqual(rows[0].sessions[0].approvalIds, ['ap-1']);
  if (process.platform === 'win32') assert.deepEqual(rows[1].sessions.map((x) => x.id), ['b', 'a'], 'same folder, working first');
  assert.equal('file' in rows[1].sessions[0], false, 'internal paths stay on the server');
});
