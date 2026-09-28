'use strict';
// Claude Code keeps its own permission dialog up while the PermissionRequest
// hook runs, takes whichever answer comes first, and does not stop the hook
// when you answer in the terminal. Once the tool's result is in the session
// transcript the question is settled, and the panel can drop it.

const fs = require('fs');

const TAIL_BYTES = 512 * 1024;

// tool_use ids in the transcript tail that match this request, and the ids
// that already have a tool_result. null when the transcript can't be read.
function scanTranscript(file, toolName, toolInput) {
  let text;
  try {
    text = readTail(file, TAIL_BYTES);
  } catch {
    return null;
  }
  const matching = new Set();
  const answered = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // cut off by the tail window or still being written
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === toolName && isSubset(block.input, toolInput)) matching.add(block.id);
      else if (block?.type === 'tool_result' && block.tool_use_id) answered.add(block.tool_use_id);
    }
  }
  return { matching, answered };
}

// The hook may see extra normalized fields (defaults filled in), so the
// transcript's input only has to be contained in the hook's.
function isSubset(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => isSubset(v, b[i]));
  return Object.keys(a).every((k) => isSubset(a[k], b[k]));
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

class TranscriptAnswerWatch {
  constructor(file, toolName, toolInput) {
    this.file = file;
    this.toolName = toolName;
    this.toolInput = toolInput;
    // An identical earlier call that was already answered must not count.
    const first = scanTranscript(file, toolName, toolInput);
    this.answeredBefore = new Set(first ? [...first.matching].filter((id) => first.answered.has(id)) : []);
  }

  settled() {
    const now = scanTranscript(this.file, this.toolName, this.toolInput);
    if (!now) return false;
    for (const id of now.matching) if (now.answered.has(id) && !this.answeredBefore.has(id)) return true;
    return false;
  }
}

module.exports = { TranscriptAnswerWatch, scanTranscript, isSubset };
