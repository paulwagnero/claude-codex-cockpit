'use strict';
// Permission requests waiting in the panel. Each one holds its hook's HTTP
// response open until one of these happens, and the hook hears about it once:
//   Approve / Deny clicked      -> allow / deny
//   Always clicked              -> allow, and remember it (see describeAlways)
//   "answer in terminal"        -> no decision, the tool shows its own prompt
//   wait runs out               -> no decision
//   hook goes away              -> nothing to answer (killed, session ended)
//   answered in the terminal    -> no decision (Claude Code only; see transcript-answer.js)
// A Codex request matching a saved rule is allowed at once and never waits.

const crypto = require('crypto');
const EventEmitter = require('events');
const { describeRequest, describeAlways, savedRuleFor, projectName } = require('./describe-request');
const { TranscriptAnswerWatch } = require('./transcript-answer');

const DENY_MESSAGE = 'The user denied this in Claude Codex Cockpit.';

class Approvals extends EventEmitter {
  // rules: a SavedRules store for Codex's "Allow always", or null for none.
  constructor({ pollMs = 1000, rules = null } = {}) {
    super();
    this.pollMs = pollMs;
    this.rules = rules;
    this.pending = new Map(); // id -> { item, respond, timer, poll, rule }
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
      // Codex's "always" lives in the rules store, so it needs one.
      always: agent === 'codex' && !this.rules ? null : describeAlways(agent, payload),
      createdAt: now,
      expiresAt: now + waitMs,
    };
    if (this.savedRuleAllows(agent, payload)) {
      respond({ decision: 'allow' });
      this.emit('settled', item, 'allow', 'saved rule');
      return { ...item, settled: true };
    }
    const rule = agent === 'codex' ? savedRuleFor(payload) : null;
    const entry = { item, respond, rule, timer: setTimeout(() => this.finish(item.id, 'none', 'timeout'), waitMs) };
    if (agent === 'claude' && typeof payload.transcript_path === 'string' && payload.transcript_path) {
      const watch = new TranscriptAnswerWatch(payload.transcript_path, payload.tool_name, payload.tool_input);
      entry.poll = setInterval(() => watch.settled() && this.finish(item.id, 'none', 'answered in terminal'), this.pollMs);
    }
    this.pending.set(item.id, entry);
    this.emit('change');
    return item;
  }

  // A click in the panel or on a Stream Deck key. false when the request is
  // already gone, or can't be allowed always.
  decide(id, decision) {
    if (decision === 'allow') return this.finish(id, 'allow', 'panel');
    if (decision === 'always') return this.get(id)?.always ? this.finish(id, 'always', 'panel') : false;
    if (decision === 'deny') return this.finish(id, 'deny', 'panel');
    if (decision === 'terminal') return this.finish(id, 'none', 'sent to terminal');
    return false;
  }

  get(id) {
    return this.pending.get(id)?.item ?? null;
  }

  // A Codex command saved with "Always" is allowed without anyone looking.
  savedRuleAllows(agent, payload) {
    const rule = agent === 'codex' ? savedRuleFor(payload) : null;
    return Boolean(rule && this.rules?.matches(rule));
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
    if (decision === 'always') {
      // Claude Code saves its own rule from the hook's answer; a Codex command
      // is remembered here. A rule that can't be saved still allows this once.
      if (entry.rule) {
        try {
          this.rules.add(entry.rule);
        } catch (err) {
          reason = `${reason}; rule not saved: ${err.message}`;
        }
      }
      entry.respond(entry.rule ? { decision: 'allow' } : { decision: 'allow', always: true });
    } else if (decision) {
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
