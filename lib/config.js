'use strict';
// Paths, port and the optional ~/.claude-codex-cockpit/config.json. Node only.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 47821;

function home() {
  return process.env.CLAUDE_CODEX_COCKPIT_HOME || path.join(os.homedir(), '.claude-codex-cockpit');
}

// Claude Code's own folder: the live session registry (sessions/) and the
// transcripts (projects/).
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude Code's cached account profile: plan name without touching any token.
function claudeAccountFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// Codex keeps its rollouts under $CODEX_HOME/sessions, ~/.codex by default.
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function paths(base = home()) {
  return {
    home: base,
    config: path.join(base, 'config.json'),
    claudeStatusline: path.join(base, 'claude-statusline'),
    // Written by the running server: pid, port and the per-run token. The
    // permission hook reads it to find the server without probing the network.
    serverFile: path.join(base, 'server.json'),
    approvalsLog: path.join(base, 'approvals.log'),
  };
}

// A missing file means defaults. Invalid JSON throws so callers can surface it
// instead of silently dropping settings like the chained statusline.
function loadConfig(file = paths().config) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const cfg = JSON.parse(text.replace(/^\uFEFF/, '')); // Notepad and PowerShell like to add a BOM
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}

function resolvePort(cfg = {}) {
  const fromEnv = process.env.CLAUDE_CODEX_COCKPIT_PORT;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n >= 0 && n < 65536) return n;
  }
  if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) return cfg.port;
  return DEFAULT_PORT;
}

module.exports = { DEFAULT_PORT, home, claudeDir, claudeAccountFile, codexHome, paths, loadConfig, resolvePort };
