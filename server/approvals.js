'use strict';
// Permission requests waiting in the panel. Each one holds its hook's HTTP
// response open until one of these happens, and the hook hears about it once:
//   Approve / Deny clicked      -> allow / deny
//   "answer in terminal"        -> no decision, the tool shows its own prompt
//   wait runs out               -> no decision
//   hook goes away              -> nothing to answer (killed, session ended)
//   answered in the terminal    -> no decision (Claude Code only; see transcript-answer.js)

const crypto = require('crypto');
const EventEmitter = require('events');
const { describeRequest, projectName } = require('./describe-request');
const { TranscriptAnswerWatch } = require('./transcript-answer');

const DENY_MESSAGE = 'The user denied this in Claude Codex Cockpit.';

class Approvals extends EventEmitter {
  constructor({ pollMs = 1000 } = {}) {
    super();
    this.pollMs = pollMs;
    this.pending = new Map(); // id -> { item, respond, timer, poll }
  }

  // respond(answer) delivers the hook's answer; it is called at most once.
  open({ agent, payload, waitMs, unattended = false, respond }) {
    const now = Date.now();
    const item = {
      id: crypto.randomUUID(),
      agent,
      sessionId: str(payload.session_id),
      cwd: str(payload.cwd),
      project: projectName(payload.cwd),
      toolName: str(payload.tool_name),
      ...describeRequest(payload),
      permissionMode: str(payload.permission_mode),
      // What happens if the panel doesn't answer:
      //   race   Claude Code's own dialog is up too; first answer wins
      //   after  Codex shows its prompt only once the hook gives up
      //   deny   unattended run (claude -p): no prompt anywhere, it denies
      fallback: agent === 'codex' ? 'after' : unattended ? 'deny' : 'race',
      createdAt: now,
      expiresAt: now + waitMs,
    };
    const entry = { item, respond, timer: setTimeout(() => this.finish(item.id, 'none', 'timeout'), waitMs) };
    if (agent === 'claude' && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      const watch = new TranscriptAnswerWatch(payload.transcript_path, payload.tool_name, payload.tool_input);
      entry.poll = setInterval(() => watch.settled() && this.finish(item.id, 'none', 'answered in terminal'), this.pollMs);
    }
    this.pending.set(item.id, entry);
    this.emit('change');
    return item;
  }

  // A click in the panel. false when the request is already gone.
  decide(id, decision) {
    if (decision === 'allow') return this.finish(id, 'allow', 'panel');
    if (decision === 'deny') return this.finish(id, 'deny', 'panel');
    if (decision === 'terminal') return this.finish(id, 'none', 'sent to terminal');
    return false;
  }

  // The hook's connection closed before an answer: nobody left to tell.
  drop(id) {
    return this.finish(id, null, 'hook gone');
  }

  finish(id, decision, reason) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    clearInterval(entry.poll);
    if (decision) {
      entry.respond(decision === 'deny' ? { decision, message: DENY_MESSAGE } : decision === 'allow' ? { decision } : { decision, reason });
    }
    this.emit('settled', entry.item, decision ?? 'none', reason);
    this.emit('change');
    return true;
  }

  list() {
    return [...this.pending.values()].map((e) => e.item).sort((a, b) => a.createdAt - b.createdAt);
  }

  closeAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, 'none', 'server stopping');
  }
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

module.exports = { Approvals, DENY_MESSAGE };
