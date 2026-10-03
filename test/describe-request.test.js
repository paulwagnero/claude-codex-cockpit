'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { describeRequest, describeAlways, projectName } = require('../server/describe-request');

const cwd = path.resolve('/work/shop');
const ask = (tool_name, tool_input, extra = {}) => describeRequest({ cwd, tool_name, tool_input, ...extra });

test('Bash shows the command and why', () => {
  const d = ask('Bash', { command: 'rm -rf node_modules', description: 'Remove node_modules', run_in_background: true });
  assert.equal(d.title, 'Bash');
  assert.equal(d.detail, 'rm -rf node_modules');
  assert.equal(d.note, 'Remove node_modules · runs in the background');
});

test('Edit names the file relative to the session folder and shows the change', () => {
  const d = ask('Edit', { file_path: path.join(cwd, 'src', 'cart.js'), old_string: 'a\nb', new_string: 'c' });
  assert.equal(d.title, `Edit ${path.join('src', 'cart.js')}`);
  assert.equal(d.detail, '- a\n- b\n+ c');
});

test('paths outside the session folder stay absolute', () => {
  const outside = path.resolve('/etc/hosts');
  assert.equal(ask('Write', { file_path: outside, content: 'x' }).title, `Write ${outside}`);
});

test('Codex apply_patch lists the files it touches', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y', '*** Add File: src/b.js', '+z', '*** End Patch'].join('\n');
  const d = ask('apply_patch', { command: patch });
  assert.equal(d.title, 'Patch src/a.js, src/b.js');
  assert.equal(d.detail, patch);
});

test('MCP tools show server and tool, with the arguments', () => {
  const d = ask('mcp__github__create_issue', { title: 'bug' });
  assert.equal(d.title, 'github · create_issue');
  assert.equal(d.detail, JSON.stringify({ title: 'bug' }, null, 2));
});

test('long details are clipped and say by how much', () => {
  const d = ask('Bash', { command: 'x'.repeat(9000) });
  assert.match(d.detail, /\n… 1000 more characters$/);
});

test('junk input never throws', () => {
  assert.deepEqual(describeRequest({}), { title: 'unknown tool', detail: '', note: '' });
  assert.equal(ask('Edit', null).title, 'Edit ');
});

test('Always for Claude Code: the rule it suggested, and where it is saved', () => {
  const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
  assert.deepEqual(describeAlways('claude', { permission_suggestions: [rule] }), { what: 'Bash(npm test:*)', short: 'npm test:*', where: 'this project' });
  const edits = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/data'], destination: 'session' },
  ];
  assert.deepEqual(describeAlways('claude', { permission_suggestions: edits }), { what: 'accept edits, access to /data', short: 'accept edits', where: 'this session' });
  assert.deepEqual(describeAlways('claude', { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], destination: 'userSettings' }] }), {
    what: 'WebFetch',
    short: 'WebFetch',
    where: 'every project',
  });
  assert.equal(describeAlways('claude', {}), null, 'nothing suggested, nothing to remember');
  assert.equal(describeAlways('claude', { permission_suggestions: ['junk', null] }), null);
});

test('Always for Codex: only a shell command, kept by the cockpit', () => {
  assert.deepEqual(describeAlways('codex', { cwd, tool_name: 'Bash', tool_input: { command: 'npm test' } }), { what: 'this exact command', short: 'this command', where: 'this folder' });
  assert.equal(describeAlways('codex', { cwd, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' } }), null);
  assert.equal(describeAlways('codex', { cwd, tool_name: 'Bash', tool_input: { command: '  ' } }), null);
});

test('project name is the last folder of cwd', () => {
  assert.equal(projectName('D:\\Repos\\shop-api\\'), 'shop-api');
  assert.equal(projectName('/home/me/shop'), 'shop');
  assert.equal(projectName(undefined), '');
});
