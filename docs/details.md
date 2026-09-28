# Details

The README covers everyday use. This page is for when you want to know
exactly what happens under the hood.

## Connecting

The gear screen, or `node bin/setup.js`, manages three things:

| Row | What it writes | What you get |
| --- | --- | --- |
| Claude Code · usage bars | `statusLine` in `~/.claude/settings.json` | the Claude bars (Pro and Max only) |
| Claude Code · approvals | a `PermissionRequest` hook in `~/.claude/settings.json` | Approve and Deny for Claude Code |
| Codex · approvals | a `PermissionRequest` hook in `~/.codex/hooks.json` | Approve and Deny for Codex |

- **Files are merged, not replaced.** A backup, `<file>.cockpit-backup-<time>`,
  goes next to a file before it changes, and a file that isn't valid JSON is
  left alone.
- **An existing status line keeps working.** The cockpit's status line runs
  yours with the same input and prints its output unchanged. Disconnecting
  puts yours back exactly as it was.
- **If the app moved or was updated,** the gear shows a dot. Press **update**.
- **With any custom status line,** Claude Code hides its footer hints ("esc to
  interrupt"). That's Claude Code's behavior, not something the cockpit adds.

From a terminal, add `--dry-run` to preview:

```
node bin/setup.js status
node bin/setup.js connect      [claude-usage] [claude-approvals] [codex-approvals]
node bin/setup.js disconnect   [claude-usage] [claude-approvals] [codex-approvals]
```

### Manual setup

If you'd rather edit the files yourself, use your own path. For a clone at
`C:/src/claude-codex-cockpit`, this goes in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/src/claude-codex-cockpit/bin/statusline.js\" --cockpit",
    "refreshInterval": 60
  },
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["C:/src/claude-codex-cockpit/bin/permission-hook.js", "--agent", "claude", "--timeout", "3600", "--cockpit"],
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

And this goes in `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/src/claude-codex-cockpit/bin/permission-hook.js\" --agent codex --timeout 60 --cockpit",
            "timeout": 60,
            "statusMessage": "Waiting for approval in Claude Codex Cockpit (terminal prompt in 60s)"
          }
        ]
      }
    ]
  }
}
```

- **Forward slashes:** on Windows, Claude Code runs the status line through Git
  Bash, which drops backslashes.
- **Timeouts:** `--timeout` must match `timeout`.
- **Installed app:** it runs these scripts with its own binary instead of
  `node`, and the gear screen writes those longer commands for you.

## How approvals behave

The two tools handle a waiting hook differently. This comes from their source
code; see [verified-behavior.md](verified-behavior.md).

| | Claude Code | Codex |
| --- | --- | --- |
| Its own prompt while the app waits | shown at the same time; the first answer wins | shown only after the hook gives up |
| The app says | "also waiting in the terminal" | "terminal prompt in 42s" |
| How long the app waits | up to an hour | 60 seconds |
| **answer in terminal** | drops the request from the app | shows the terminal prompt right away |

- **Answered in the terminal:** Claude Code doesn't stop the hook when you
  answer there. The app notices the tool's result in the session transcript
  and drops the request within a second or two.
- **Headless runs** (`claude -p`, scripts) have no prompt at all, so they
  wait at most 60 seconds and then get Claude Code's normal "denied".
- **Deny** tells the agent that you declined in the app, so it can adjust.
- **Audit log:** every answered request goes into
  `~/.claude-codex-cockpit/approvals.log`.

## Safety

Whenever something goes wrong, the hook makes **no decision**. It exits
quietly, and the tool shows its normal prompt. Only an explicit click on
**Approve** can allow anything.

| Situation | What happens |
| --- | --- |
| The app isn't running | the hook steps aside in about 90 ms, without any network call |
| The app crashed and left its state file | same, because the hook checks that the recorded process is alive |
| The server doesn't answer | the hook gives up after 500 ms |
| Nobody answers in time | no decision, just before the tool's own timeout |
| The session or tool went away | the hook notices within 2 seconds |
| A web page tries to answer | refused |

- **Localhost only.** The server listens on 127.0.0.1.
- **Web pages can't answer.** Answers need a per-run token that only the hook's
  state file and the app's own page carry, and cross-site or DNS-rebinding
  requests are refused.
- **No accidental clicks.** Buttons ignore clicks for their first 0.7
  seconds, so a request that pops up under your pointer can't be clicked by
  accident.
- **Exit code 2 is never used,** because Codex reads it as a deny.

## Usage and pace

- **Claude Code** reports its limits to the status line after a session's
  first response, on Pro and Max plans. Numbers from several sessions are
  merged: the newest window wins, and within one window the highest reading
  wins.
- **Codex** logs its limits after every turn in `~/.codex/sessions`. Those logs
  mix several limit buckets; the bars show the main `codex` one.
- **Pace** compares how much you've used with how much of the window has
  passed. At or under pace the bar is green. Up to 30% ahead it turns amber,
  and beyond that red.
- **The "out in …" note** uses your last 30 minutes for the 5-hour window, and
  the whole-window average for the week, because nights are part of a normal
  week.

## Settings

Optional file: `~/.claude-codex-cockpit/config.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `47821` | local port (also `CLAUDE_CODEX_COCKPIT_PORT`) |
| `approvals.enabled` | `true` | `false` turns approvals off for both tools |
| `approvals.claude` / `approvals.codex` | `true` | `false` for just one tool |
| `approvals.unattendedWaitSec` | `60` | longest wait for headless Claude runs |
| `approvals.log` | `true` | write `approvals.log` |

`CLAUDE_CODEX_COCKPIT_HOME` moves the data folder. `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` work the same way they do for the tools themselves.

## Troubleshooting

- **The status line is blank or odd:** `claude --debug` shows its errors.
- **The port is taken or refused:** set `port` in `config.json`. On Windows,
  `netsh interface ipv4 show excludedportrange protocol=tcp` lists ports that
  Hyper-V or WSL reserve.
- **Raw state:** `http://127.0.0.1:47821/debug` shows what the server sees.

## Development

```
npm test              # the tests, on node:test, with no test dependencies
npm start             # the app, from source
npm run server        # just the server (the app reuses a running one)
npm run icons         # rebuild build/icon.* from build/icon.svg
npm run dist:win      # Windows installer and zip in dist/
npm run dist:mac      # macOS universal build (on a Mac)
node scripts/screenshots.js   # README screenshots, from made-up data
```

- **Tests** use temp folders and never touch your real settings. On Windows
  they also run the generated setup commands in Git Bash, cmd.exe and
  PowerShell.
- **The server** is plain Node with no dependencies. The Electron window
  starts it as a child process.
- **CI:** [`.github/workflows/build.yml`](../.github/workflows/build.yml) runs
  the tests on Windows, macOS and Linux. It then builds the Windows installer
  and the macOS universal app, starts both as a smoke test, and drafts a
  release when a `v*` tag is pushed.
- **Local Windows installer builds** fail while Smart App Control is on,
  because electron-builder runs a freshly built helper that SAC blocks. The
  zip target still builds (`npx electron-builder --win zip`).

## Known limitations

- **Codex auto-review:** if Guardian is on, the hook still runs before it,
  because Codex doesn't tell hooks who the reviewer is
  ([openai/codex#23465](https://github.com/openai/codex/issues/23465)). If
  you rely on auto-review, set `"approvals": { "codex": false }`.
- **Codex sessions** have no registry, so a session counts as open while its
  log has been written in the last 8 hours.
- **Unsigned builds:** Windows Smart App Control can block the app, and macOS
  asks for an explicit first launch.
- **Linux** isn't packaged. Running from source might work, but it's
  untested.
