# Details

The README covers everyday use. This page is for when you want to know
exactly what happens under the hood.

## Connecting

The gear screen, or `node bin/setup.js`, manages four things:

| Row | What it writes | What you get |
| --- | --- | --- |
| Claude Code · usage bars | `statusLine` in `~/.claude/settings.json` | the Claude bars (Pro and Max only) |
| Claude Code · approvals | a `PermissionRequest` hook in `~/.claude/settings.json` | Approve, Always and Deny for Claude Code |
| Codex · approvals | a `PermissionRequest` hook in `~/.codex/hooks.json` | Approve, Always and Deny for Codex |
| Stream Deck · keys | a link to `streamdeck/` in Stream Deck's `Plugins` folder | the six keys; see [Stream Deck](#stream-deck) |

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
node bin/setup.js connect      [claude-usage] [claude-approvals] [codex-approvals] [streamdeck]
node bin/setup.js disconnect   [claude-usage] [claude-approvals] [codex-approvals] [streamdeck]
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

### Always

**Always** approves and stops asking. It shows only when there is something
to remember, and says what that is.

| | Claude Code | Codex |
| --- | --- | --- |
| What is remembered | what Claude Code suggests: the same thing its own "don't ask again" applies | the exact command, in that folder |
| Where | Claude Code's settings: usually `.claude/settings.local.json` in the project, sometimes only the session | `~/.claude-codex-cockpit/saved-rules.json` |
| For | any request Claude Code makes a suggestion for | shell commands only |
| Undo | remove the rule with `/permissions` in Claude Code | delete its entry from the file; it counts at once |

- **Claude Code** sends its suggestions with each request, and the hook hands
  them back. A command like `git init` becomes the rule `Bash(git init *)` in
  that project. A file edit only switches the session to accepting edits, the
  same as Claude Code's own dialog, and the button says "session".
- **Codex** doesn't let a hook save rules yet, and a running Codex reads its
  own `~/.codex/rules` only when a session starts. So the cockpit answers a
  matching request itself, at once, while it runs. With the cockpit closed,
  Codex asks as usual.

## Safety

Whenever something goes wrong, the hook makes **no decision**. It exits
quietly, and the tool shows its normal prompt. Only a press of **Approve** or
**Always**, in the panel or on a Stream Deck, can allow anything. The one
exception is a Codex command you saved with **Always** earlier.

| Situation | What happens |
| --- | --- |
| The app isn't running | the hook steps aside in about 90 ms, without any network call |
| Nobody is watching: no window open and no cockpit keys in view on a Stream Deck | the server answers "no decision" at once, so Codex doesn't sit out its 60 seconds |
| The app crashed and left its state file | same, because the hook checks that the recorded process is alive |
| The server doesn't answer | the hook gives up after 500 ms |
| Nobody answers in time | no decision, just before the tool's own timeout |
| The session or tool went away | the hook notices within 2 seconds |
| A web page tries to answer | refused |

- **Localhost only.** The server listens on 127.0.0.1.
- **Web pages can't answer.** Answers need a per-run token that only the
  state file (read by the hook and the Stream Deck plugin) and the app's own
  page carry, and cross-site or DNS-rebinding requests are refused.
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

## Stream Deck

The plugin in `streamdeck/` runs inside the Stream Deck app (7.1 or newer) on
the Node 24 that Stream Deck brings, and talks to the cockpit the way the hook
does. It has no settings; each key does one thing:

| Key | Shows | Press |
| --- | --- | --- |
| Claude usage, Codex usage | the 5-hour and weekly bars with the time to each reset, colored by pace | nothing |
| Waiting request | the request that has waited longest: tool, command, project, `1/2` when more wait. With none, your sessions | answer in terminal |
| Allow once, Allow always, Deny | dark until a request waits, then lit; Always says what it would remember and where | answers the request shown |
| Claude usage, press to allow; Codex usage, press to allow | the usage bars; a pulsing yellow border while that tool's request is next in line | allows that request once |

Two profiles ship for the Mini: all six keys, or the top row only (the two
"press to allow" usage keys and the waiting request), which leaves the bottom
row for your own keys. Requests form one line, oldest first, so only one key
glows at a time and the waiting-request key always shows what a press would
allow.

- **Connecting** links `streamdeck/` into Stream Deck's `Plugins` folder (a
  junction on Windows), so the plugin runs the app's own code and gets each
  update with it. Stream Deck loads new plugins when it starts, so restart it.
- **The Mini layouts** ship as profiles. The first time the plugin sees a
  Stream Deck Mini, Stream Deck asks to install the six-key one and switches
  to it, once. The top-row one appears in Stream Deck's profile list, or opens
  from `profiles/` in the plugin folder. After that the profiles are yours to
  change.
- **The same guard as the panel:** a key pressed within 0.7 seconds of a
  request appearing does nothing; the lit keys stay faded until then. A key
  that can't act flashes Stream Deck's warning sign.
- **Without the app:** when its keys are in view and no cockpit is running,
  the plugin starts the cockpit's server itself, on Stream Deck's Node; the
  keys say "starting…" for a moment. That server stops within 2 seconds of
  Stream Deck quitting. Opening the app reuses it, and if it goes away while
  the app is open, the app starts its own within 5 seconds and the panel
  reloads.
- **A Stream Deck start-up race:** if Stream Deck starts and the device
  attaches at the same moment, Stream Deck sometimes never tells the plugin
  which keys are showing. If no key shows up within 5 seconds, the plugin
  restarts itself once (at most every 5 minutes), and Stream Deck starts it
  again with the keys.
- **Logs:** `~/.claude-codex-cockpit/streamdeck.log`, and `server.log` for a
  server the plugin started.

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
npm run streamdeck    # rebuild the Stream Deck key images and Mini profiles
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
