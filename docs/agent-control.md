# Agent control: `aiterm`

Every session AI Terminal starts can talk back to the app through the `aiterm` command. An agent,
a script or you can use it to publish files, report progress, ask for attention and send text to a
session.

`aiterm` is a small Node.js client (`apps/desktop/bin/aiterm`). Each call opens one connection to
the app's control socket, sends one JSON-RPC request and exits.

## How a session finds the app

AI Terminal sets these variables in every session it starts:

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

## What the app enforces

- Requests are validated for schema and size before anything runs.
- A session token can only publish, report and send for its own session, and only while that
  process incarnation is current.
- An agent can publish only regular files inside its session's working directory or the system
  temporary folder; symlinks that escape those folders are refused. The app copies the file into
  its own store, hashes it, and never serves it back by path.
- `claimed-done` is shown as a claim. Only `verified` is shown as verified.
- A request stays open in **Needs you** until it is resolved or withdrawn; reading it only clears
  the unread mark.

These checks separate sessions from each other inside the app. They are not a sandbox against a
malicious program that already runs as your user and can read your files.
