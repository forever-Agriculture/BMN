# Agent control: `aiterm`

Every session BMN starts can talk back to the app through the `aiterm` command. An agent,
a script or you can use it to publish files, report progress, ask for attention and send text to a
session.

`aiterm` is a small Node.js client (`apps/desktop/bin/aiterm`). Each call opens one connection to
the app's control socket, sends its JSON-RPC requests and exits. Packaged builds run it on BMN's own
runtime from `resources/bin`, so sessions need no Node.js install; BMN puts that folder on `PATH`.

## How a session finds the app

BMN sets these variables in every session it starts:

| Variable | Meaning |
| --- | --- |
| `AITERM_CONTROL_SOCKET` | Path of the control socket |
| `AITERM_TOKEN` | A credential that only works for this session and this run of its process |
| `AITERM_SESSION_ID` | The session's ID |

The socket lives in `$XDG_RUNTIME_DIR/ai-terminal/control/`, a folder only your user can open.
There is no network listener.

Session tokens are HMAC-signed for one session and one process incarnation. Starting the session
again issues a new token; the old one stops working. The owner token, `owner.token` next to the
socket, can address any session and requires `--session`.

## Commands

```text
aiterm snapshot                                   Show the current state snapshot
aiterm list                                       List sessions
aiterm publish <file> [--name N] [--key K]        Publish a file to the Files panel
aiterm progress <state> <label> [--source S] [--detail D]
aiterm ask <request-key> <title> [--kind K] [--body B] [--expires ISO]
aiterm withdraw <request-key>                     Withdraw your request
aiterm resolve <request-key> <resolution>         Mark a request resolved
aiterm send <text> [--submit] [--key K]           Paste text into the session; --submit presses Enter
aiterm hook <agent>                               Turn an agent hook event on stdin into Needs you requests
aiterm help
```

Options:

| Option | Meaning |
| --- | --- |
| `--session ID` | Target session (defaults to your own; required with the owner token) |
| `--json` | Print the raw result as JSON |
| `--owner` | Use `owner.token` next to the socket instead of `AITERM_TOKEN` |
| `--token-file PATH` | Read the token from a file |
| `--socket PATH` | Use another socket path |
| `--` | Treat every following argument as text |

Progress states: `running`, `waiting`, `blocked`, `claimed-done`, `verified`, `failed`, `unknown`.
Request kinds: `question` (default), `permission`, `review`, `notice`.

Exit status: `0` success, `1` remote or connection error, `2` usage error.

## Examples

Publish a screenshot an agent produced:

```bash
aiterm publish ./out/screenshot.png --name "Login page after the fix"
```

Report progress from a long script:

```bash
aiterm progress running "Migrating 1,200 records" --source migrate.sh
# ...
aiterm progress claimed-done "Migration finished" --detail "1,200 of 1,200 rows"
```

Ask the owner a question and clear it later:

```bash
aiterm ask deploy-approval "Deploy build 142 to staging?" --kind permission
# after the answer arrives, or if it is no longer needed:
aiterm withdraw deploy-approval
```

Send a command to another session as the owner:

```bash
aiterm send --owner --session <session-id> --submit -- "git status"
```

`--key` makes a publish or send idempotent: repeating the same call with the same key does not
publish or send twice.

## Agent hooks: Needs you for Claude Code and Codex

`aiterm hook claude` and `aiterm hook codex` read one hook event as JSON on stdin and keep **Needs
you** in step with the agent. They print nothing and always exit 0, so a hook can never disturb the
agent, and they do nothing outside BMN.

| Event | Effect |
| --- | --- |
| Claude `Notification` (permission prompt) or `PermissionRequest` | Opens a `permission` request |
| Claude `Notification` (question dialog) | Opens a `question` request |
| `PostToolUse`, `UserPromptSubmit` | Resolves open prompts as answered in the terminal; clears the turn notice |
| `Stop` | Withdraws open prompts; opens a `notice` that the turn finished, with the last message. When Claude still has background tasks or a scheduled wake-up, it opens nothing: the agent resumes without you |
| `SessionStart` (not after compaction), `SessionEnd` | Withdraws everything the hook opened |
| Codex `Interrupt` | Withdraws open prompts |

An agent passes its environment to agents it starts from a tool call (`claude -p`), so the hook
also checks that the agent above it holds the terminal; nested, non-interactive agents are ignored.

Typing, pasting or dictating into a session answers its open prompts and notices, the way agterm
clears a session's status on a keystroke, so they leave **Needs you** as soon as you respond, even
when the agent sends no hook for it (a denied permission, or Esc). Review requests stay open.

Add the hook to `~/.claude/settings.json` for `Notification`, `PostToolUse`, `UserPromptSubmit`,
`Stop`, `SessionStart` and `SessionEnd`, next to any hooks already there:

```json
{ "hooks": [{ "type": "command", "timeout": 5,
  "command": "[ -n \"$AITERM_CONTROL_SOCKET\" ] && command -v aiterm >/dev/null && aiterm hook claude; exit 0" }] }
```

For Codex, add the same entries with `aiterm hook codex` to `~/.codex/hooks.json` for `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd` and `Interrupt`, then trust them once with
`/hooks` in Codex. Add `PermissionRequest` only without Auto Review: Codex fires it before Auto
Review decides whether you must approve, so it would flag tools that never need you.

BMN shows a desktop notification for a new request unless you are looking at that session. Telegram
gets it only while you are away from the desk (a minute without keyboard or mouse input), only if it
is still open and unseen after 15 seconds (a finished-turn notice after 60), and each request only
once however often the agent repeats it. A request that fell due while you were at the desk is still
sent if you leave within 10 minutes of it opening. Session exits, when chosen, are sent only while
you are away. If BMN cannot read idle time, Telegram gets requests as if you were away.

While you are at the desk and looking at the session, BMN tells the agent its terminal has focus;
after a minute without input it reports the focus lost, so Claude Code sends its own mobile
notifications while you are away. A Claude session connected to Remote Control is never sent to
Telegram: the Claude app already notifies your phone. The hook reads that from Claude Code's
`~/.claude/sessions/<pid>.json` (or `$CLAUDE_CONFIG_DIR/sessions`), which needs `/proc`, so on macOS
such sessions are still sent.

## What the app enforces

- Requests are validated for schema and size before anything runs.
- A session token can only publish, report and send for its own session, and only while that
  process incarnation is current.
- An agent can publish only regular files inside its session's working directory or the system
  temporary folder; symlinks that escape those folders are refused. The app copies the file into
  its own store, hashes it, and never serves it back by path.
- `claimed-done` is shown as a claim. Only `verified` is shown as verified.
- A request stays open in **Needs you** until it is resolved or withdrawn; reading it only clears
  the unread mark. Typing into its session resolves it, except a review.

These checks separate sessions from each other inside the app. They are not a sandbox against a
malicious program that already runs as your user and can read your files.
