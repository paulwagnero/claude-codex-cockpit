# Verified behavior

Everything Claude Codex Cockpit relies on, and how each point was checked:
against the live docs, in the tools' own source, or by running the real CLI.
Versions: Claude Code 2.1.283 and Codex CLI 0.158.0 (September 2026); the
"Always" and Stream Deck points with Claude Code 2.1.288, Codex CLI 0.160.0
and Stream Deck 7.6.0 (October 2026). Re-check these points when a tool
changes.

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

### "Always" (updatedPermissions)

- **Docs:** `updatedPermissions` (allow only) is an **array** of permission
  update entries, the same shape as the `permission_suggestions` input, and
  "a hook can echo one of the `permission_suggestions` it received". Entry
  types: `addRules`, `replaceRules`, `removeRules`, `setMode`,
  `addDirectories`, `removeDirectories`, each with a `destination`
  (`session`, `localSettings`, `projectSettings`, `userSettings`).
  `permission_suggestions` "isn't an exact list of the options you see".
- **Source (bundled binary):** the decision validator rejects "an allow
  decision whose updatedPermissions is not a list", and checks each entry's
  type, destination and mode.
- **End to end** (`claude -p`, Haiku, the real hook and server, answered
  Always):
  - `git init`: suggestions were one `addRules` entry with `localSettings`;
    the tool ran, and `.claude/settings.local.json` gained
    `"allow": ["Bash(git init *)"]`.
  - `touch file`: suggestions were `addDirectories` and `setMode acceptEdits`,
    both `session`; the tool ran and nothing was written to disk. So "Always"
    is sometimes session-only, exactly as Claude Code's own dialog.

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
- **No "Always" through the hook ([docs](https://developers.openai.com/codex/hooks), 0.160.0):**
  "Don't return `updatedInput`, `updatedPermissions`, or `interrupt` for
  `PermissionRequest`; those fields are reserved for future behavior and fail
  closed today." The input carries `turn_id`, `tool_name`, `tool_input`
  (`command` for Bash and apply_patch) and no suggested rule.
- **Codex's own "don't ask again"** appends a line like
  `prefix_rule(pattern=["npm", "test"], decision="allow")` to
  `~/.codex/rules/default.rules`. **Source (`core/src/exec_policy.rs`):**
  `append_amendment_and_update` writes the file *and* updates the policy in
  memory; the policy is otherwise loaded once, when the session starts. A line
  added from outside would only reach new sessions, and the prefix Codex would
  propose (`proposed_execpolicy_amendment`) never reaches a hook. Hence the
  cockpit keeps Codex's "Always" itself.
- End to end with `codex exec --approve-for-me --dangerously-bypass-hook-trust -c hooks…`:
  allow, deny and panel closed all behaved as expected.

## Stream Deck

- **Docs ([SDK](https://docs.elgato.com/streamdeck/sdk/), WebSocket API 3.0):**
  a plugin is started with `-port`, `-pluginUUID`, `-registerEvent` and
  `-info`, connects to `ws://127.0.0.1:<port>` and sends
  `{event: <registerEvent>, uuid: <pluginUUID>}`. The `@elgato/streamdeck`
  package wraps the same protocol, so a plain script needs no packages:
  `Nodejs.Version: "24"` in the manifest (Stream Deck 7.1+) brings Node's
  built-in `WebSocket`.
- `setImage` takes SVG as `data:image/svg+xml,<URL-encoded SVG>`; no animated
  formats. Device type 1 is the Stream Deck Mini. A profile listed under
  `Profiles` is installed the first time the plugin calls `switchToProfile`
  with that `Name`.
- **Live (Windows, Stream Deck 7.6.0, a Mini, model `20GAI9901`):**
  - Stream Deck ran the plugin with its own Node 24.13.1
    (`%APPDATA%\Elgato\StreamDeck\NodeJS`), through a junction in its
    `Plugins` folder; `fs.realpathSync(__dirname)` resolves to the real folder,
    so `lib/` is found.
  - The bundled profile, a zip in the format of Elgato's own tutorial profiles
    (`<id>.sdProfile/manifest.json` with an `Actions` map keyed `"column,row"`),
    was converted ("Convert profile to new version"), installed ("Profile
    profiles/Cockpit Mini installed for @(1)[…]") and shown after one
    confirmation. `willAppear` reported each key at its column and row.
  - A killed plugin was restarted by Stream Deck within about 6 seconds; a
    restarted cockpit was picked up within 3.
  - Key presses on the device answered three test requests as pressed:
    Always, Always, Allow.
  - Stream Deck does not reload plugins while running; a newly linked one
    needs a restart of the app. A graceful close only hides it in the tray.
  - A plugin that exits, even with code 0, is started again about 10 seconds
    later.
  - **Start-up race:** on a cold start (`StreamDeck.exe --runinbk`, as at
    login), `willAppear` came right after the plugin connected when the plugin
    connected first (2 of 3 starts). When the log showed "device attached" in
    the same millisecond as "Plugin connected", no `willAppear` came at all,
    while the Mini showed the cockpit page; restarting the plugin brought them
    at once. Hence the plugin's one-time restart when no key shows up.
  - With the app closed, the server the plugin started held a test request
    for the deck and passed the answer back; opening the app reused that
    server, and quitting Stream Deck stopped it, after which the open app
    started its own.

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
