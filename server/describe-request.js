'use strict';
// Turns a PermissionRequest hook payload (Claude Code or Codex) into what the
// panel shows: a title naming the tool and its target, the detail being
// approved (command, diff, patch, arguments), an optional reason, and what
// "Allow always" would remember.

const path = require('path');

const MAX_DETAIL = 8000;
const MAX_NOTE = 600;

function describeRequest(payload) {
  const tool = typeof payload.tool_name === 'string' && payload.tool_name ? payload.tool_name : 'unknown tool';
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const rel = (p) => relativeTo(typeof payload.cwd === 'string' ? payload.cwd : '', text(p));
  let title = tool;
  let detail;
  const notes = [text(input.description)];

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      detail = text(input.command);
      if (input.run_in_background) notes.push('runs in the background');
      break;
    case 'Edit':
      title = `Edit ${rel(input.file_path)}`;
      detail = diff(input.old_string, input.new_string);
      if (input.replace_all) notes.push('replaces every occurrence');
      break;
    case 'MultiEdit':
      title = `Edit ${rel(input.file_path)}`;
      detail = (Array.isArray(input.edits) ? input.edits : []).map((e) => diff(e?.old_string, e?.new_string)).join('\n\n');
      break;
    case 'Write':
      title = `Write ${rel(input.file_path)}`;
      detail = text(input.content);
      break;
    case 'NotebookEdit':
      title = `Edit ${rel(input.notebook_path)}`;
      detail = text(input.new_source);
      break;
    case 'Read':
      title = `Read ${rel(input.file_path)}`;
      detail = '';
      break;
    case 'Glob':
    case 'Grep':
      title = `${tool} ${text(input.pattern)}`;
      detail = input.path ? `in ${rel(input.path)}` : '';
      break;
    case 'WebFetch':
      detail = text(input.url);
      notes.push(text(input.prompt));
      break;
    case 'WebSearch':
      detail = text(input.query);
      break;
    case 'apply_patch': {
      // Codex: the patch itself; name the files it touches.
      detail = text(input.command);
      const files = [...detail.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => rel(m[1].trim()));
      title = files.length ? `Patch ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}` : 'Patch';
      break;
    }
    default:
      if (tool.startsWith('mcp__')) {
        const [, server = '', name = ''] = tool.split('__');
        title = `${server} · ${name}`;
      }
      detail = Object.keys(input).length ? JSON.stringify(input, null, 2) : '';
  }
  return { title, detail: clip(detail, MAX_DETAIL), note: clip(notes.filter(Boolean).join(' · '), MAX_NOTE) };
}

// What "Allow always" would remember for this request, or null when it can't
// be remembered: { what, short, where }, short being what fits on a key.
//   Claude Code  the permission_suggestions it sent: what its own "don't ask
//                again" option applies. The hook echoes them as updatedPermissions.
//                That can be a rule for the project, or only a mode for this
//                session (file edits): where says which.
//   Codex        a hook can't add to Codex's rules (updatedPermissions fails
//                closed), so the cockpit keeps the exact command for this folder
//                itself: see saved-rules.js.
function describeAlways(agent, payload) {
  if (agent === 'claude') {
    const entries = permissionSuggestions(payload);
    if (!entries.length) return null;
    const parts = entries.map(describeUpdate).filter((p) => p.text);
    const where = [...new Set(entries.map((e) => DESTINATIONS[e.destination] || DESTINATIONS.session))];
    // One part fits on a key: an allow rule says the most, then a mode.
    const best = [...parts].sort((a, b) => a.rank - b.rank)[0];
    return { what: parts.map((p) => p.text).join(', ') || "Claude Code's suggestion", short: best?.short || 'as suggested', where: where.join(' + ') };
  }
  if (agent === 'codex' && savedRuleFor(payload)) return { what: 'this exact command', short: 'this command', where: 'this folder' };
  return null;
}

const DESTINATIONS = {
  session: 'this session',
  localSettings: 'this project',
  projectSettings: 'this project, shared',
  userSettings: 'every project',
};
const MODES = {
  default: 'ask as usual',
  manual: 'ask as usual',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  auto: 'auto mode',
  dontAsk: "don't ask",
  bypassPermissions: 'bypass permissions',
};

function permissionSuggestions(payload) {
  const list = payload?.permission_suggestions;
  return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object' && typeof e.type === 'string') : [];
}

// One permission update in words: { text, short, rank }, rank ordering which
// part a key shows.
function describeUpdate(e) {
  const list = (Array.isArray(e.rules) ? e.rules : []).filter((r) => r && typeof r.toolName === 'string');
  const rules = list.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
  // A shell rule reads best as the command itself: "npm test:*".
  const first = list[0];
  const shortRule = !first ? '' : first.ruleContent && /^(Bash|PowerShell)$/.test(first.toolName) ? first.ruleContent : first.ruleContent ? `${first.toolName}(${first.ruleContent})` : first.toolName;
  const dirs = Array.isArray(e.directories) ? e.directories.filter((d) => typeof d === 'string').join(', ') : '';
  const verb = e.behavior && e.behavior !== 'allow' ? `${e.behavior} ` : '';
  switch (e.type) {
    case 'addRules':
    case 'replaceRules':
      return { text: rules && `${verb}${rules}`, short: `${verb}${shortRule}`, rank: verb ? 3 : 0 };
    case 'removeRules':
      return { text: rules && `stop ${verb}${rules}`, short: `stop ${shortRule}`, rank: 4 };
    case 'setMode':
      return { text: MODES[e.mode] || `${e.mode} mode`, short: MODES[e.mode] || `${e.mode} mode`, rank: 1 };
    case 'addDirectories':
      return { text: dirs && `access to ${dirs}`, short: 'folder access', rank: 2 };
    case 'removeDirectories':
      return { text: dirs && `no access to ${dirs}`, short: 'no folder access', rank: 4 };
    default:
      return { text: '', short: '', rank: 9 };
  }
}

// The one kind of Codex request the cockpit can remember: a shell command.
// Patches and MCP calls rarely repeat word for word.
function savedRuleFor(payload) {
  const command = payload?.tool_input?.command;
  if (payload?.tool_name !== 'Bash' || typeof command !== 'string' || !command.trim()) return null;
  return { tool: 'Bash', command, cwd: typeof payload.cwd === 'string' ? payload.cwd : '' };
}

function text(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function diff(oldText, newText) {
  const lines = (v, sign) => text(v).split('\n').map((l) => `${sign} ${l}`).join('\n');
  return `${lines(oldText, '-')}\n${lines(newText, '+')}`;
}

function clip(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n… ${s.length - max} more characters` : s;
}

// Paths inside the session folder read better relative to it.
function relativeTo(cwd, p) {
  if (!cwd || !p || !path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

// Split on both separators: a Windows path must name its folder on any OS.
function projectName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}

module.exports = { describeRequest, describeAlways, savedRuleFor, projectName };
