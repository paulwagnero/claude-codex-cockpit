'use strict';
// Codex commands answered with "Allow always".
//
// Codex keeps its own allow rules in ~/.codex/rules, but a hook can't add to
// them (updatedPermissions fails closed on PermissionRequest), and a running
// Codex reads that file only when a session starts. So the cockpit remembers
// these itself: the exact command, in the same folder. While the cockpit runs, a
// matching request is allowed at once; with it closed, Codex asks as usual.
//
// The file is read on every match, so deleting a line takes effect right away:
//   { "codex": [ { "tool": "Bash", "command": "npm test", "cwd": "D:\\src\\shop", "savedAt": "…" } ] }

const fs = require('fs');
const path = require('path');

class SavedRules {
  constructor(file) {
    this.file = file;
  }

  // rule: { tool, command, cwd }
  matches(rule) {
    const key = ruleKey(rule);
    return this.read().some((r) => ruleKey(r) === key);
  }

  add(rule) {
    if (this.matches(rule)) return;
    const { data, broken } = this.readFile();
    const now = new Date().toISOString();
    // A hand edit that broke the file is kept aside rather than overwritten.
    if (broken) fs.renameSync(this.file, `${this.file}.broken-${now.replace(/[:.]/g, '-')}`);
    const list = Array.isArray(data.codex) ? data.codex : [];
    data.codex = [...list, { tool: rule.tool, command: rule.command, cwd: rule.cwd, savedAt: now }];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  read() {
    const list = this.readFile().data.codex;
    return Array.isArray(list) ? list.filter((r) => r && typeof r.command === 'string' && typeof r.tool === 'string') : [];
  }

  // A missing or broken file remembers nothing; it never allows by accident.
  readFile() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { data: {}, broken: false };
    }
    try {
      const data = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (data && typeof data === 'object' && !Array.isArray(data)) return { data, broken: false };
    } catch {}
    return { data: {}, broken: true };
  }
}

// The command must match exactly; the folder may differ in slashes and, on
// Windows, case: D:\Repos\x and d:/repos/x/ are one folder.
function ruleKey(r) {
  let cwd = String(r.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') cwd = cwd.toLowerCase();
  return JSON.stringify([r.tool, r.command, cwd]);
}

module.exports = { SavedRules };
