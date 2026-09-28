'use strict';
// Which shell a tool will run a command string through, and how to write a
// command for that shell. Claude Code runs statusLine and shell-form hooks
// through Git Bash on Windows (PowerShell when Git Bash is missing) and sh
// elsewhere; Codex runs hooks through %COMSPEC% (cmd.exe) on Windows and sh
// elsewhere.

const fs = require('fs');
const path = require('path');

// Git Bash the way Claude Code finds it. Never System32\bash.exe (WSL).
function findGitBash(env = process.env) {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    // Git\cmd\git.exe, Git\bin\git.exe or Git\mingw64\bin\git.exe -> Git\bin\bash.exe
    if (dir && isFile(path.join(dir, 'git.exe'))) {
      candidates.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe'));
    }
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.find(isFile) || null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// The shell Claude Code uses for command strings on this machine.
function claudeShell(env = process.env) {
  if (process.platform !== 'win32') return 'sh';
  return findGitBash(env) ? 'sh' : 'powershell';
}

// The shell Codex uses for hook command strings.
function codexShell() {
  return process.platform === 'win32' ? 'cmd' : 'sh';
}

// Double-quote a path for the given shell. Paths can contain spaces
// ("C:\Users\Ana Maria\...", "Claude Codex Cockpit.app"); these characters
// have no business in an install path, so they are refused outright.
function quote(p, shell) {
  if (/["$`%\r\n]/.test(p)) throw new Error(`unsupported character in path: ${p}`);
  // Git Bash eats unquoted backslashes and is happy with forward slashes;
  // cmd.exe wants backslashes.
  const s = shell === 'cmd' ? p.replace(/\//g, '\\') : shell === 'sh' ? p.replace(/\\/g, '/') : p;
  return `"${s}"`;
}

// `run` describes how to start one of our scripts:
//   { node: 'node' }                 system Node (running from a clone)
//   { exe: '/path/to/app binary' }   the packaged app, as Node via ELECTRON_RUN_AS_NODE
function commandLine(run, script, args, shell) {
  const tail = [quote(script, shell), ...args].join(' ');
  if (run.node) return `${run.node} ${tail}`;
  const exe = quote(run.exe, shell);
  if (shell === 'powershell') return `$env:ELECTRON_RUN_AS_NODE=1; & ${exe} ${tail}`;
  if (shell === 'cmd') return `set "ELECTRON_RUN_AS_NODE=1" && ${exe} ${tail}`;
  return `ELECTRON_RUN_AS_NODE=1 ${exe} ${tail}`;
}

module.exports = { findGitBash, claudeShell, codexShell, quote, commandLine };
