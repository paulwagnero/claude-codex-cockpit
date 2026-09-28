# Verified behavior

Everything Claude Codex Cockpit relies on, and how each point was checked:
against the live docs, in the tools' own source, or by running the real CLI.
Versions: Claude Code 2.1.283 and Codex CLI 0.158.0 (September 2026). Re-check
these points when either tool changes.

## Claude Code

### statusLine ([docs](https://code.claude.com/docs/en/statusline))

- stdin carries `rate_limits.five_hour` and `rate_limits.seven_day`, each
  `{used_percentage 0-100, resets_at unix-seconds}`. They are present only on
  Pro and Max, and only after the session's first API response. Each window can
  be absent on its own, and a window is dropped once its `resets_at` passes.
- The script runs when an assistant message arrives, when the permission mode
  changes, at a window's `resets_at`, and every `refreshInterval` seconds.
  Updates are debounced by 300 ms, and a new update cancels a script that is
  still running. So the script writes a file and makes no network calls.
- An idle session re-sends the numbers from its last response. Across sessions,
  the largest `resets_at` wins; inside one window, the highest
  `used_percentage` wins.
- On Windows, statusLine commands run through Git Bash, or PowerShell when Git
  Bash is absent. Unquoted backslashes get eaten, so paths use forward slashes.
- Any custom status line hides the footer hints ("esc to interrupt").
- Live check: editing `statusLine.command` makes running sessions execute the
  new command immediately.

### PermissionRequest hook ([docs](https://code.claude.com/docs/en/hooks))

- The output is `hookSpecificOutput.decision.behavior` (`allow` or `deny`).
  `message` goes with deny; `updatedInput`, `updatedPermissions` and `interrupt`
  also exist. `permissionDecision` is the PreToolUse field and does not apply.
- Exit 0 with no output means no decision, and the normal flow continues. Exit 2
  is **not** honored for this event.
- stdin carries `session_id, transcript_path, cwd, permission_mode,
  hook_event_name, tool_name, tool_input, permission_suggestions`, and
  `mcp_server` for MCP tools. There is no `tool_use_id`.
- The default timeout is 600 s. With `args` (exec form), the command is spawned
  directly with no shell.
- **Source (bundled JS):** in the interactive flow the permission dialog is set
  up first, and the hooks run in a detached async block that races it:
  `if(!S&&r.personOnly!==!0)(async()=>{… await s.runHooks(…) … if(!N||!R())return; … })()`.
  `R()` claims the answer, so the first answer wins. The hook is **not** killed
  when the user answers in the terminal.
- The hook runs as a child of `claude.exe`, whose environment includes
  `CLAUDE_CODE_SESSION_ATTENDED` (`1` interactive, `0` for `claude -p`),
  `CLAUDE_CODE_ENTRYPOINT` (`cli` or `sdk-cli`) and `CLAUDE_PID`.
- In `claude -p` a hook without a decision means the tool call is denied.
- End to end with `claude -p --settings`: allow runs the tool, deny reaches
  Claude as a denial, and a closed panel leaves Claude's normal behavior
  unchanged. The hook exits in under 100 ms.

### Session registry and status

- `~/.claude/sessions/<pid>.json` holds one live file per running session:
  `pid, sessionId, cwd, kind, entrypoint, name, status, waitingFor, updatedAt,
  statusUpdatedAt`. The `<pid>.<hash>.key` files next to them are secrets and
  are never read.
- **Source:** `status` is `busy` when `isLoading || delegatedActive`, `waiting`
  (with `waitingFor`) when a dialog or question is open, and `idle` otherwise.
  It becomes `shell` when idle in shell mode.
- Transcript: `~/.claude/projects/<cwd with non-alphanumerics as ->/<sessionId>.jsonl`.
  It holds `ai-title` entries (the generated title), user and assistant messages
  with `tool_use` and `tool_result` blocks, and `isSidechain` or `isMeta` flags.
  A `tool_use` input equals the hook's `tool_input`, which is what lets the
  panel detect an answer given in the terminal.
- Plan: `~/.claude.json` `oauthAccount.organizationType` (`claude_pro`,
  `claude_max`) with `organizationRateLimitTier` (`…_max_5x`, `…_max_20x`). No
  credentials are needed.

## Codex

### Usage (rollout logs)

- `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, with `CODEX_HOME`
  defaulting to `~/.codex`. After each API turn, an
  `event_msg`/`token_count` line carries `rate_limits`.
- Several buckets share the stream. On a Plus plan:

  | `limit_id` | windows |
  | --- | --- |
  | `codex` | primary 300 min, secondary 10080 min: the real limits |
  | `premium` | primary and secondary null |
  | `base_model_inference` (`gpt-reserve`) | primary 10080 min, no secondary |

  So windows are placed by `window_minutes`, never by primary/secondary. The
  newest line is often the empty `premium` one, which is why a "newest line"
  reader shows nothing.
- A resumed session keeps writing into its original day folder, so "recent"
  means most recent mtime across all folders.
- Files reach tens of MB; they are read from the tail.
- Older builds wrote `resets_in_seconds` instead of `resets_at`.

### Session lifecycle

- The first line is `session_meta` (`session_id`, `cwd`, `originator`). A
  `turn_context` line carries the current `cwd`.
- `event_msg` types `task_started`, `task_complete` (with
  `last_agent_message`) and `turn_aborted` (with `reason`) make up the turn
  lifecycle.
- `item_completed` items: `UserMessage`, `AgentMessage` (`phase`),
  `CommandExecution` (`parsed_cmd`, `status`) and `FileChange` (`changes`).
- There is no registry of open sessions.

### PermissionRequest hook ([docs](https://developers.openai.com/codex/hooks))

- It uses the same output shape as Claude Code, `hookSpecificOutput.decision.behavior`
  plus `message` on deny. `updatedInput`, `updatedPermissions` and `interrupt`
  are rejected on this event.
- Hooks live in `~/.codex/hooks.json` or `[hooks]` in `config.toml`. A new or
  changed hook runs only after it is trusted in `/hooks`.
- **Source (`core/src/tools/approvals.rs`):** hooks run **first** and are
  awaited. Only when no hook decides does Codex go on to Guardian (auto-review)
  or the user prompt:
  ```rust
  // Approval precedence is:
  // 1. Hooks
  // 2. If StrictAutoReview || Guardian enabled, then Guardian. Else, user.
  ```
- **Source (`hooks/src/events/permission_request.rs`):** exit 0 with empty
  stdout means no decision. A timeout, an error or invalid JSON counts as a
  failed hook, which means no decision. **Exit 2 with stderr is a deny.**
- **Source (`hooks/src/engine/command_runner.rs`):** on Windows the command
  runs through `%COMSPEC% /C`, and on timeout the process tree is killed with
  taskkill.
- Hooks can't see whether Guardian would review a request
  ([openai/codex#23465](https://github.com/openai/codex/issues/23465)).
- `codex exec` cannot request escalated permissions on its own, but
  `--approve-for-me` does route approvals through the flow above.
- End to end with `codex exec --approve-for-me --dangerously-bypass-hook-trust -c hooks…`:
  allow, deny and panel closed all behaved as expected.

## Windows and the packaged app

- A GUI-subsystem Electron main process gets an empty `process.stdin` from a
  pipe, although `fs.readFileSync(0)` works, and it writes a stray newline to
  stdout. The packaged app therefore runs the scripts with
  `ELECTRON_RUN_AS_NODE=1`, which gives clean stdio at about 95 ms against
  about 80 ms for Node.
- Each tool gets that variable its own way:

  | Where | Form |
  | --- | --- |
  | Claude statusLine, Windows with Git Bash | `ELECTRON_RUN_AS_NODE=1 "exe" "script" …` |
  | Claude statusLine, Windows without Git Bash | `$env:ELECTRON_RUN_AS_NODE=1; & "exe" "script" …` |
  | Claude hook, macOS | exec form: `/usr/bin/env ELECTRON_RUN_AS_NODE=1 exe script …` |
  | Codex hook, Windows | `set "ELECTRON_RUN_AS_NODE=1" && "exe" "script" …` |

  The test suite runs the Git Bash, cmd.exe and PowerShell forms for real.
- With `mac.identity: null`, electron-builder skips signing completely
  (`handleNullIdentity`) and does not ad-hoc sign. Apple Silicon won't run
  unsigned code, so CI signs the universal app ad hoc
  (`codesign --force --deep --sign -`) before packaging.
- Hyper-V and WSL can reserve port ranges. The default port 47821 sits below
  the 49152+ dynamic range.
