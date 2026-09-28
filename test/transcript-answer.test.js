'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TranscriptAnswerWatch, isSubset } = require('../server/transcript-answer');
const { tempDir } = require('./helpers');

const toolUse = (id, command) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResult = (id) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

// The hook sees normalized input: the model's fields plus filled-in defaults.
const hookInput = { command: 'npm test', timeout: 120000, run_in_background: false };

test('settled once the matching tool_use gets its result', (t) => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, `${toolUse('toolu_1', 'npm test')}\n`);
  const watch = new TranscriptAnswerWatch(file, 'Bash', hookInput);
  assert.equal(watch.settled(), false);
  fs.appendFileSync(file, `${toolResult('toolu_1')}\n`);
  assert.equal(watch.settled(), true);
});

test('an identical earlier call that was already answered does not count', (t) => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, [toolUse('toolu_old', 'npm test'), toolResult('toolu_old'), toolUse('toolu_new', 'npm test')].join('\n') + '\n');
  const watch = new TranscriptAnswerWatch(file, 'Bash', hookInput);
  assert.equal(watch.settled(), false);
  fs.appendFileSync(file, `${toolResult('toolu_new')}\n`);
  assert.equal(watch.settled(), true);
});

test('results for other tools do not settle it', (t) => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, [toolUse('toolu_1', 'npm test'), toolUse('toolu_2', 'npm run lint'), toolResult('toolu_2')].join('\n') + '\n');
  assert.equal(new TranscriptAnswerWatch(file, 'Bash', hookInput).settled(), false);
});

test('a missing or half-written transcript never settles', (t) => {
  const dir = tempDir(t);
  assert.equal(new TranscriptAnswerWatch(path.join(dir, 'nope.jsonl'), 'Bash', hookInput).settled(), false);
  const file = path.join(dir, 'half.jsonl');
  fs.writeFileSync(file, `${toolUse('toolu_1', 'npm test')}\n${toolResult('toolu_1').slice(0, 40)}`);
  assert.equal(new TranscriptAnswerWatch(file, 'Bash', hookInput).settled(), false);
});

test('isSubset: the transcript input must be contained in the hook input', () => {
  assert.equal(isSubset({ command: 'a' }, { command: 'a', timeout: 1 }), true);
  assert.equal(isSubset({ command: 'a', timeout: 2 }, { command: 'a', timeout: 1 }), false);
  assert.equal(isSubset({ edits: [{ x: 1 }] }, { edits: [{ x: 1, y: 2 }] }), true);
  assert.equal(isSubset({ edits: [1, 2] }, { edits: [1] }), false);
  assert.equal(isSubset(undefined, {}), false);
});
