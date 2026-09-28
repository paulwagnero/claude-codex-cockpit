#!/usr/bin/env node
'use strict';
// Connect Claude Code and Codex to Claude Codex Cockpit from a terminal.
// (The panel has the same thing behind its gear button.)
//
//   node bin/setup.js status
//   node bin/setup.js connect    [claude-usage] [claude-approvals] [codex-approvals] [--dry-run]
//   node bin/setup.js disconnect [claude-usage] [claude-approvals] [codex-approvals] [--dry-run]
//
// With no parts listed, connect and disconnect cover everything installed.

const setup = require('../lib/setup');

const LABELS = {
  'claude-usage': 'Claude Code usage bars (statusLine)',
  'claude-approvals': 'Claude Code approvals (PermissionRequest hook)',
  'codex-approvals': 'Codex approvals (PermissionRequest hook)',
};

function printStatus(s) {
  for (const part of setup.PARTS) {
    const { state, note } = s[part];
    console.log(`  ${state.padEnd(11)} ${LABELS[part]}${note ? `\n              ${note}` : ''}`);
  }
  console.log(`\n  files: ${s.files.claude}\n         ${s.files.codex}`);
}

function main(argv) {
  const [command = 'status', ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const parts = rest.filter((a) => !a.startsWith('--'));
  if (command === 'status') return printStatus(setup.status());
  if (command !== 'connect' && command !== 'disconnect') {
    console.error('usage: setup.js status | connect [parts] | disconnect [parts] [--dry-run]');
    return 2;
  }
  const report = setup.apply(command, parts.length ? parts : setup.PARTS, setup.environment(), { dryRun });
  if (!report.changed.length) console.log('Nothing to change.');
  for (const file of report.changed) {
    console.log(`${dryRun ? 'would write' : 'wrote'} ${file}`);
    if (dryRun) console.log(JSON.stringify(report.preview[file], null, 2));
  }
  for (const b of report.backups) console.log(`backup  ${b}`);
  for (const m of report.messages) console.log(`\n${m}`);
  if (!dryRun) {
    console.log('');
    printStatus(setup.status());
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2)) || 0;
  } catch (err) {
    console.error(err instanceof setup.SetupError ? err.message : err.stack || err);
    process.exitCode = 1;
  }
}
