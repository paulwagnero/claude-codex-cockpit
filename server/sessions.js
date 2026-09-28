'use strict';
// Open Claude Code and Codex sessions with a status and the last few things
// said or done in each.
//
// Claude Code keeps a registry of running sessions, ~/.claude/sessions/<pid>.json,
// with its own status: "busy", "idle", or "waiting" plus waitingFor (a dialog,
// "input needed", ...). Its transcript supplies the title and the messages.
// Codex has no registry. Its rollout log carries the turn lifecycle
// (task_started, task_complete, turn_aborted) and the messages, so a Codex
// session counts as open while its rollout has been written recently.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { describeRequest, projectName } = require('./describe-request');

const TAIL_BYTES = 256 * 1024;
const RECENT_ITEMS = 4;
const MAX_TEXT = 400;
const CODEX_OPEN_MS = 8 * 3600 * 1000; // rollout written in the last 8 h
const CODEX_QUIET_MS = 20 * 60 * 1000; // "working" with no writes for 20 min: probably closed

// Status vocabulary shared with the panel:
//   working      the agent is running
//   needs-you    the tool is waiting on a dialog or question (waitingFor says which)
//   your-turn    the turn is done; it waits for your next prompt
//   interrupted  the last turn was stopped
//   quiet        nothing written for a long while; may be closed
// ("approval" is layered on in the server when a hook is waiting.)

class SessionsSource extends EventEmitter {
  constructor({ claudeDir, codexUsage = null, rescanMs = 2000 }) {
    super();
    this.claudeDir = claudeDir;
    this.codexUsage = codexUsage;
    this.rescanMs = rescanMs;
    this.parsed = new Map(); // file -> { mtimeMs, size, value }
    this.transcripts = new Map(); // Claude sessionId -> transcript path
    this.sessions = [];
    this.key = '[]';
  }

  start() {
    this.rescan();
    this.timer = setInterval(() => this.rescan(), this.rescanMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  rescan(now = Date.now()) {
    const sessions = [...this.claudeSessions(), ...this.codexSessions(now)];
    const seen = new Set(sessions.map((s) => s.file).filter(Boolean));
    for (const file of [...this.parsed.keys()]) if (!seen.has(file)) this.parsed.delete(file);
    const key = JSON.stringify(sessions);
    if (key !== this.key) {
      this.key = key;
      this.sessions = sessions;
      this.emit('change', sessions);
    }
  }

  // Parse a file only when it changed.
  cached(file, parse) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = this.parsed.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = parse(file, st);
    this.parsed.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  claudeSessions() {
    const dir = path.join(this.claudeDir, 'sessions');
    let names = [];
    try {
      // Only <pid>.json: the <pid>.<hash>.key files next to them are secrets.
      names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      let reg;
      try {
        reg = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (typeof reg.sessionId !== 'string' || !isAlive(reg.pid)) continue; // left behind by a crash
      const file = this.claudeTranscript(reg.sessionId, reg.cwd);
      const t = file ? this.cached(file, (f) => parseClaudeTranscript(readTail(f), reg.cwd)) : null;
      out.push({
        agent: 'claude',
        id: reg.sessionId,
        cwd: typeof reg.cwd === 'string' ? reg.cwd : '',
        project: projectName(reg.cwd),
        title: t?.title || (typeof reg.name === 'string' ? reg.name : ''),
        kind: typeof reg.kind === 'string' ? reg.kind : null,
        status: claudeStatus(reg.status, t),
        waitingFor: reg.status === 'waiting' && typeof reg.waitingFor === 'string' ? reg.waitingFor : null,
        statusSince: num(reg.statusUpdatedAt) ?? num(reg.updatedAt),
        lastActivityAt: t?.lastAt ?? num(reg.updatedAt) ?? num(reg.startedAt),
        recent: t?.recent ?? [],
        file,
      });
    }
    return out;
  }

  // ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl,
  // or wherever that session id turns up.
  claudeTranscript(sessionId, cwd) {
    const known = this.transcripts.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    const projects = path.join(this.claudeDir, 'projects');
    const guess = typeof cwd === 'string' ? path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`) : null;
    let found = guess && fs.existsSync(guess) ? guess : null;
    if (!found) {
      try {
        for (const d of fs.readdirSync(projects)) {
          const f = path.join(projects, d, `${sessionId}.jsonl`);
          if (fs.existsSync(f)) {
            found = f;
            break;
          }
        }
      } catch {}
    }
    if (found) this.transcripts.set(sessionId, found);
    return found;
  }

  codexSessions(now) {
    const files = (this.codexUsage?.recentFiles ?? []).filter((f) => now - f.mtimeMs < CODEX_OPEN_MS);
    const out = [];
    for (const f of files) {
      const r = this.cached(f.file, (file) => parseCodexRollout(readHead(file), readTail(file)));
      if (!r?.id) continue;
      let status = r.status;
      if (status === 'working' && now - f.mtimeMs > CODEX_QUIET_MS) status = 'quiet';
      out.push({
        agent: 'codex',
        id: r.id,
        cwd: r.cwd,
        project: projectName(r.cwd),
        title: '',
        kind: r.originator,
        status,
        waitingFor: null,
        statusSince: r.statusAt,
        lastActivityAt: r.lastAt ?? f.mtimeMs,
        recent: r.recent,
        file: f.file,
      });
    }
    return out;
  }
}

function claudeStatus(registryStatus, t) {
  if (registryStatus === 'busy') return 'working';
  if (registryStatus === 'waiting') return 'needs-you';
  if (registryStatus === 'idle' || registryStatus === 'shell') return t?.interrupted ? 'interrupted' : 'your-turn';
  return t?.interrupted ? 'interrupted' : 'your-turn';
}

// ---- Claude Code transcript ----

// Wrappers Claude Code puts around things that aren't your words.
const CLAUDE_NOISE = /^<(local-command-|system-reminder|bash-|user-memory-input|command-message)/;

function parseClaudeTranscript(text, cwd) {
  let title = '';
  let lastAt = null;
  let interrupted = false;
  const items = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // cut by the tail window, or still being written
    }
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) lastAt = at;
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') title = e.aiTitle;
    if (e.isSidechain || e.isMeta || !e.message) continue;
    const content = e.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (e.type === 'user') {
      if (blocks.some((b) => b?.type === 'tool_result')) continue;
      const said = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (!said) continue;
      if (said.startsWith('[Request interrupted')) {
        interrupted = true;
        items.push({ kind: 'note', text: 'interrupted', at });
        continue;
      }
      const command = /^<command-name>([^<]*)<\/command-name>/.exec(said);
      if (command) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(said);
        items.push({ kind: 'you', text: `${command[1]} ${args ? args[1] : ''}`.trim(), at });
      } else if (!CLAUDE_NOISE.test(said)) items.push({ kind: 'you', text: said, at });
      interrupted = false;
    } else if (e.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) items.push({ kind: 'agent', text: b.text.trim(), at });
        else if (b?.type === 'tool_use') items.push({ kind: 'tool', text: toolLine(b.name, b.input, cwd), at });
      }
      interrupted = false;
    }
  }
  return { title, lastAt, interrupted, recent: items.slice(-RECENT_ITEMS).map(clipItem) };
}

// "Bash npm test", "Edit src/cart.js", "Read README.md": the tool and its target.
function toolLine(name, input, cwd) {
  const d = describeRequest({ tool_name: name, tool_input: input, cwd });
  // Whole command on one line (clipItem folds the whitespace); a first line
  // like "node -e '" says nothing.
  if (name === 'Bash' || name === 'PowerShell') return `${name} ${d.detail}`.trim();
  if (name === 'WebFetch' || name === 'WebSearch') return `${name} ${firstLine(d.detail)}`.trim();
  if ((name === 'Task' || name === 'Agent') && typeof input?.description === 'string') return `${name} ${input.description}`;
  return d.title;
}

// ---- Codex rollout ----

function parseCodexRollout(head, tail) {
  let meta = null;
  try {
    const nl = head.indexOf('\n');
    const first = JSON.parse(nl === -1 ? head : head.slice(0, nl));
    if (first.type === 'session_meta') meta = first.payload;
  } catch {}
  let cwd = typeof meta?.cwd === 'string' ? meta.cwd : '';
  let status = 'your-turn';
  let statusAt = null;
  let lastAt = null;
  const items = [];
  for (const line of tail.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(o.timestamp);
    if (Number.isFinite(at)) lastAt = at;
    const p = o.payload || {};
    if (o.type === 'turn_context' && typeof p.cwd === 'string') cwd = p.cwd;
    if (o.type !== 'event_msg') continue;
    if (p.type === 'task_started') [status, statusAt] = ['working', at];
    else if (p.type === 'task_complete') [status, statusAt] = ['your-turn', at];
    else if (p.type === 'turn_aborted') {
      [status, statusAt] = ['interrupted', at];
      items.push({ kind: 'note', text: p.reason || 'interrupted', at });
    } else if (p.type === 'item_completed' && p.item) {
      const item = codexItem(p.item);
      if (item) items.push({ ...item, at });
    }
  }
  const id = typeof meta?.session_id === 'string' ? meta.session_id : typeof meta?.id === 'string' ? meta.id : null;
  return {
    id,
    cwd,
    originator: typeof meta?.originator === 'string' ? meta.originator : null,
    status,
    statusAt,
    lastAt,
    recent: items.slice(-RECENT_ITEMS).map(clipItem),
  };
}

function codexItem(item) {
  const text = (content) => (Array.isArray(content) ? content.map((c) => c?.text || '').join('\n').trim() : '');
  switch (item.type) {
    case 'UserMessage':
      return { kind: 'you', text: text(item.content) };
    case 'AgentMessage':
      // :codex-file-citation{path="D:/x/HANDOVER.md" ...} reads better as the file name.
      return {
        kind: 'agent',
        text: text(item.content).replace(/:codex-file-citation\{[^}]*?path="([^"]*)"[^}]*\}/g, (_, p) => p.split(/[\\/]/).pop()),
      };
    case 'CommandExecution': {
      const cmd = item.parsed_cmd?.[0]?.cmd || (Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command);
      return { kind: 'tool', text: `Run ${String(cmd || '')}${item.status === 'failed' ? '  (failed)' : ''}` };
    }
    case 'FileChange': {
      const files = Object.keys(item.changes || {}).map((f) => f.split(/[\\/]/).pop());
      return { kind: 'tool', text: `Edit ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}` };
    }
    default:
      return null;
  }
}

// ---- helpers ----

// One line each; agent text loses its markdown emphasis on the way.
function clipItem(item) {
  let t = item.text;
  if (item.kind === 'agent') t = t.replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  return { ...item, text: t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t, at: Number.isFinite(item.at) ? item.at : null };
}

function firstLine(s) {
  return String(s).split('\n')[0].trim();
}

function num(v) {
  return Number.isFinite(v) ? v : null;
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

function readTail(file, bytes = TAIL_BYTES) {
  return readRange(file, (size) => Math.max(0, size - bytes), bytes);
}

// The first line of a rollout (session_meta) holds the base instructions and
// can be tens of KB.
function readHead(file, bytes = 256 * 1024) {
  return readRange(file, () => 0, bytes);
}

function readRange(file, startOf, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = startOf(size);
    const buf = Buffer.alloc(Math.min(bytes, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // drop the cut first line
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { SessionsSource, parseClaudeTranscript, parseCodexRollout, toolLine };
