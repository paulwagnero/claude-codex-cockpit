'use strict';
// Turns a PermissionRequest hook payload (Claude Code or Codex) into what the
// panel shows: a title naming the tool and its target, the detail being
// approved (command, diff, patch, arguments) and an optional reason.

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

module.exports = { describeRequest, projectName };
