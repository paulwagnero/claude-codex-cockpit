'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SavedRules } = require('../server/saved-rules');
const { tempDir } = require('./helpers');

const rule = (over = {}) => ({ tool: 'Bash', command: 'npm test', cwd: 'D:\\Repos\\Shop', ...over });

test('a saved command matches itself only: same tool, same command, same folder', (t) => {
  const rules = new SavedRules(path.join(tempDir(t), 'saved-rules.json'));
  assert.equal(rules.matches(rule()), false);
  rules.add(rule());
  rules.add(rule()); // once is enough
  assert.equal(rules.matches(rule()), true);
  assert.equal(rules.read().length, 1);
  assert.equal(rules.matches(rule({ command: 'npm test -- --watch' })), false);
  assert.equal(rules.matches(rule({ command: 'npm test ' })), false, 'no trimming: exact');
  assert.equal(rules.matches(rule({ cwd: 'D:\\Repos\\Other' })), false);
  assert.equal(rules.matches(rule({ tool: 'apply_patch' })), false);
});

test('the folder may differ in slashes, and on Windows in case', (t) => {
  const rules = new SavedRules(path.join(tempDir(t), 'saved-rules.json'));
  rules.add(rule());
  assert.equal(rules.matches(rule({ cwd: 'D:/Repos/Shop/' })), true);
  assert.equal(rules.matches(rule({ cwd: 'd:\\repos\\shop' })), process.platform === 'win32');
});

test('the file is read on every match: deleting a line forgets it at once', (t) => {
  const file = path.join(tempDir(t), 'saved-rules.json');
  const rules = new SavedRules(file);
  rules.add(rule());
  rules.add(rule({ command: 'npm run lint' }));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.codex = data.codex.filter((r) => r.command !== 'npm test');
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(rules.matches(rule()), false);
  assert.equal(rules.matches(rule({ command: 'npm run lint' })), true);
});

test('a broken file allows nothing, and is kept aside rather than overwritten', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'saved-rules.json');
  fs.writeFileSync(file, '{ "codex": [ oops');
  const rules = new SavedRules(file);
  assert.equal(rules.matches(rule()), false);
  rules.add(rule());
  assert.equal(rules.matches(rule()), true);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('saved-rules.json.broken-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{ "codex": [ oops');
});

test('other keys in the file are kept', (t) => {
  const file = path.join(tempDir(t), 'saved-rules.json');
  fs.writeFileSync(file, JSON.stringify({ note: 'mine', codex: [{ hand: 'written' }] }));
  new SavedRules(file).add(rule());
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.note, 'mine');
  assert.deepEqual(data.codex[0], { hand: 'written' });
  assert.equal(data.codex.length, 2);
});
