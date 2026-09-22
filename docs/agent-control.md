# Agent control: `bmn`

Every session BMN starts can talk back to the app through the `bmn` command. An agent,
a script or you can use it to publish files, report progress, ask for attention and send text to a
session.

`bmn` is a small Node.js client (`apps/desktop/bin/bmn`). Each call opens one connection to
the app's control socket, sends its JSON-RPC requests and exits. Packaged builds run it on BMN's own
runtime from `resources/bin`, so sessions need no Node.js install; BMN puts that folder on `PATH`.

## How a session finds the app

BMN sets these variables in every session it starts:

| Variable | Meaning |
| --- | --- |
| `BMN_CONTROL_SOCKET` | Path of the control socket |
| `BMN_TOKEN` | A credential that only works for this session and this run of its process |
| `BMN_SESSION_ID` | The session's ID |

The socket lives in `$XDG_RUNTIME_DIR/bmn/control/`, a folder only your user can open.
There is no network listener.

Session tokens are HMAC-signed for one session and one process incarnation. Starting the session
again issues a new token; the old one stops working. The owner token, `owner.token` next to the
socket, can address any session and requires `--session`.

## Commands

```text
bmn snapshot                                   Show the current state snapshot
bmn list                                       List sessions
bmn publish <file> [--name N] [--key K]        Publish a file to the Files panel
bmn progress <state> <label> [--source S] [--detail D] [--evidence-id ID ...]
bmn ask <request-key> <title> [--kind K] [--body B] [--expires ISO]
bmn withdraw <request-key>                     Withdraw your request
bmn resolve <request-key> <resolution>         Mark a request resolved
bmn send <text> [--submit] [--key K]           Paste text into the session; --submit presses Enter
bmn hook <agent>                               Turn an agent hook event on stdin into Needs you requests
bmn hooks check [agent] [--file PATH]          Say which of BMN's hook entries each hook file carries
bmn hooks install <agent> [--file PATH]        Add the missing entries, after backing the file up
bmn help [agents]                              Show usage; `help agents` prints the agent brief
```

Options:

| Option | Meaning |
| --- | --- |
| `--session ID` | Target session (defaults to your own; required with the owner token) |
| `--json` | Print the raw result as JSON |
| `--owner` | Use `owner.token` next to the socket instead of `BMN_TOKEN` |
| `--token-file PATH` | Read the token from a file |
| `--socket PATH` | Use another socket path |
| `--` | Treat every following argument as text |

Progress states: `running`, `waiting`, `blocked`, `claimed-done`, `verified`, `failed`, `unknown`.
Request kinds: `question` (default), `permission`, `review`, `notice`.

Exit status: `0` success, `1` remote or connection error, `2` usage error. `bmn hooks` uses `1` for
"something is missing or unreadable": it reads and writes files instead of talking to the socket.

## Examples

Publish a screenshot an agent produced:

```bash
bmn publish ./out/screenshot.png --name "Login page after the fix"
```

Report progress from a long script:

```bash
bmn progress running "Migrating 1,200 records" --source migrate.sh
# ...
bmn progress claimed-done "Migration finished" --detail "1,200 of 1,200 rows"
```

Point a report at files you already published. Publish first with `--key`, keep the artifact ID it
returns, then name it; a repeated publish with the same key returns the same ID, so the reference
stays valid:

```bash
id=$(bmn publish ./out/checks.log --key migrate-checks --json | sed -n 's/.*"artifactId": "\([^"]*\)".*/\1/p')
bmn progress claimed-done "Migration finished" --evidence-id "$id"
```

Up to ten distinct IDs, on any state. Each must be a file **this** session published: a file the
owner or Telegram handed to the session is not evidence that the session did the work. Leaving
`--evidence-id` out means this report has no evidence, not that it keeps the last one's files.

BMN stores the reference and its filename, shows them beside the report, and lets the owner open
them. **It does not read the files, run anything, or judge the claim.** Evidence being present,
and its stored bytes passing their integrity check, says nothing about whether the work succeeded
or whether those files are the relevant ones. A file that is later deleted stays visible as a named,
unavailable reference rather than quietly disappearing from the report.

Ask the owner a question and clear it later:

```bash
bmn ask deploy-approval "Deploy build 142 to staging?" --kind permission
# after the answer arrives, or if it is no longer needed:
bmn withdraw deploy-approval
```

Send a command to another session as the owner:

```bash
bmn send --owner --session <session-id> --submit -- "git status"
```

`--key` makes a publish or send idempotent: repeating the same call with the same key does not
publish or send twice.

## Agent hooks: Needs you for Claude Code and Codex

`bmn hook claude` and `bmn hook codex` read one hook event as JSON on stdin and keep **Needs
you** in step with the agent. They print nothing and always exit 0, so a hook can never disturb the
agent, and they do nothing outside BMN.

| Event | Effect |
| --- | --- |
| Claude `Notification` (permission prompt) or `PermissionRequest` | Opens a `permission` request |
| Claude `Notification` (question dialog) | Opens a `question` request |
| Codex `PreToolUse` for `request_user_input` or `request_user_input_async` | Opens a `question` request with the question text and choices |
| `PostToolUse`, `UserPromptSubmit` | Clears the turn notice. Claude resolves open prompts after a tool completes. Codex resolves permission after any tool and resolves a question only after synchronous `request_user_input` or `UserPromptSubmit`; an async question stays open while later tools run |
| `Stop` | Withdraws open prompts and opens a `notice` that the turn finished, with the last message. Codex keeps a queued async question open until the owner submits input. When Claude still has background tasks or a scheduled wake-up, it opens nothing: the agent resumes without you |
| `SessionStart` (not after compaction), `SessionEnd` | Withdraws everything the hook opened |
| `SessionStart` with `startup`, `resume`, `clear` or `fork` | Also reports the conversation the process is now in, so Resume reopens that one |
| Codex `Interrupt` | Withdraws open prompts |

### Notifications from any program

A harness with no BMN hook still speaks the terminal's own notification language, and BMN reads it.
A program that writes **OSC 9** (`ESC ] 9 ; text BEL`, iTerm2), **OSC 777**
(`ESC ] 777 ; notify ; title ; body BEL`, urxvt) or **OSC 99** (`ESC ] 99 ; metadata ; text BEL`,
kitty) into its session opens one `notice` in **Needs you**, which pages you like a finished turn
and clears when you type into that session. The row says it came "from the terminal (OSC 9)".

The rules are deliberately narrow. It is always a `notice`: a program's own message can never open a
question or a permission, ask for a decision or change the session's working/idle word. The sequence
is consumed instead of printed, nothing is written back to the program, and the terminal is never
resized or redrawn for it. Several notifications within two seconds become more lines on the one
row rather than a queue of them. A session whose harness already reports through its own `bmn hook`
is left to that hook for as long as that process runs — two routes for one turn would mean two rows
— and the suppressed notification is still listed under **Hook events…** so the absence of a request
has an answer.

Every one of these calls carries the event that made it, so a request in **Needs you** says where it
came from ("from Claude Notification") and a closed one says what closed it ("withdrawn by Claude
Stop", "resolved by typing", "expired"). A request opened before this existed reads "from unknown".

Each hook event also records itself, whether or not it changed anything: the session's ⋯ menu has
**Hook events…**, a read-only list of what the harness reported, with the event, the tool it ran and
what it changed. That list is the answer to "why is there no request for this?". It is kept in
memory only, at most 30 events per session, is never shown to another session, and starts empty
again after BMN restarts.

An agent passes its environment to agents it starts from a tool call (`claude -p`), so the hook
also checks that the agent above it holds the terminal; nested, non-interactive agents are ignored.

Typing, pasting or dictating into a session answers its open prompts and notices, the way agterm
clears a session's status on a keystroke, so they leave **Needs you** as soon as you respond, even
when the agent sends no hook for it (a denied permission, or Esc). Review requests stay open.

### Wiring the hooks

Two commands do it, and neither needs BMN to be running:

```bash
bmn hooks check              # what each agent's own hook file carries, for every event BMN expects
bmn hooks install claude     # add only the missing entries, after backing the file up
bmn hooks install codex
```

`check` prints one line per event: `wired` for the documented command, `wired (older wording)` for
the two other entries BMN recognises (see below), or `missing`. It exits `0` when nothing is missing
and `1` otherwise, and `--json` prints the same report as one object. Run it after a Claude Code or
Codex update rewrites your settings file.

`install` copies the file to `<file>.bmn-backup-<timestamp>`, adds the missing entries next to the
hooks already registered for that event, writes the file atomically and prints a unified diff. It
never removes, reorders or rewrites an entry, including one with the older wording, and writes
nothing when nothing is missing. A file that is not valid JSON is reported and left untouched, as is
one whose `hooks` is not an object or whose event is not a list: BMN says what it cannot add to
rather than replacing somebody's configuration. If the file changed while `install` was reading it,
nothing is written and it says so; run it again.

That check closes the window it can. If your harness writes the same file in the instant between
that check and the rename, **its change is lost and the backup does not contain it** — the backup is
taken before the check, so it holds the configuration as it was before `install` started, not the
edit that raced it. No program can close that window without the other writer agreeing to a lock,
and neither harness offers one. So: close the harness, or at least do not let it rewrite its
settings, while `install` runs.

One more limit worth knowing: the file is rewritten by a JSON writer, so your indent, key order and
values survive, but an escape does not stay an escape — `"\u0061"` comes back as `"a"`. It is the
same string; it is not the same bytes.

Both commands read the file each harness actually reads: `~/.claude/settings.json` and
`~/.codex/hooks.json`, or the same file under `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when you have
moved that directory. `--file PATH` replaces it, for tests.

Both commands say what is **configured**. Neither says that a hook has ever fired; the session's
**Hook events…** list is what shows that. Nor does either say the command *will* run: the documented
entry is guarded and does nothing while BMN is not running, which is the point of the guard.

BMN recognises its own entry by what it is, not by reading the shell it is written in. Exactly three
commands count, compared whole after trimming and never parsed:

```bash
[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0   # wired
[ -n "$AITERM_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0  # older wording
bmn hook claude                                                                        # older wording
```

The second is the wording from before BMN was renamed, which `bmn hook` still reads. The third is the
call with nothing around it. **Everything else reads as `missing`** — a wrapper, a redirection, a
condition, a group, your own variant with one extra space. When such an entry mentions
`bmn hook <agent>`, `check` prints it under the event, so you can see what it declined to read:

```
  Stop              missing
    an entry here names bmn hook claude but is not one BMN recognises:
      timeout 5 bmn hook claude
```

`install` then adds BMN's own entry beside yours, and the hook fires twice rather than not at all.
If you see a duplicate, that is why, and **either entry may be removed**: yours is the one BMN did
not read, not one it judged broken.

That is the whole rule, and it is deliberate. Earlier versions of this command read the shell around
the call and tried to say whether it would deliver the event. Seven rounds of review each found a
command it called `wired` that could not report — a group carrying a redirection, a substitution that
consumed the event first, a construct that balanced but that bash refuses to parse. Every one of them
left the owner with no hook and no warning, which is the one outcome this command exists to prevent.
A duplicate entry is visible and harmless; a silent gap is neither. So BMN stopped reading shell.

The consequence to be clear about: `check` tells you what is **configured**, and now makes no claim
at all about a command it does not recognise. A hand-written entry that works perfectly still reads
`missing`. Run `bmn hooks install <agent>` and let BMN write its own, or paste the documented entry
exactly, and `check` will answer for it.

The entries themselves, for wiring them by hand. `~/.claude/settings.json` needs `Notification`,
`PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart` and `SessionEnd`, next to any hooks
already there:

```json
{ "hooks": [{ "type": "command", "timeout": 5,
  "command": "[ -n \"$BMN_CONTROL_SOCKET\" ] && command -v bmn >/dev/null && bmn hook claude; exit 0" }] }
```

For Codex, the same entries with `bmn hook codex` go in `~/.codex/hooks.json` for `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd` and `Interrupt`. Codex must
then trust them once with `/hooks`, which no command can do for you. `PreToolUse` is required for
queued `request_user_input_async` questions because Codex has no `Notification` hook event. Add
`PermissionRequest` only without Auto Review: Codex fires it before Auto Review decides whether you
must approve, so it would flag tools that never need you, and `install` therefore never adds it.

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

## A brief for agents

`bmn help agents` prints this page from the binary, so an agent can read it without leaving its
session. The block below is the same text; a unit test fails when the two differ.

```text
bmn: how to behave as an agent inside a BMN session.

Are you inside BMN?
  If BMN_CONTROL_SOCKET is unset you are not in a BMN session: use none of this.
  Run `bmn help` for the exact syntax. This page is etiquette, not a command reference.

What to send, and when
  publish <file>          a file the owner should be able to open: a report, a diff, an image.
  progress <state> <label>  a real change of state, not a running commentary.
  ask <key> <title>       a decision only the owner can make; go on with what does not need it.
  withdraw <key>          the moment the answer arrives or the question stops mattering.

Your states are claims, not verdicts
  claimed-done says you believe the work is finished. The owner sees it as your claim.
  verified is the owner's judgement. Never report it: that would launder your claim as proof.
  failed and blocked are honest. Prefer either to a hopeful running.
  --evidence-id <id> attaches a file you already published. BMN shows it; it checks nothing.

Whose screen this is
  Needs you is the owner's queue, and the other sessions are the owner's. Neither is yours to tidy.
  Your token reaches your own session only; a call naming another session is refused by design.
  Resolve or withdraw only the requests you opened yourself.

send is not a message channel
  send types into your own terminal and nowhere else.
  It never reaches the owner or another session, and there is no agent-to-agent channel here.
  If someone else must know something, ask or publish it.

Submission is not delivery
  A call that returns proves it was submitted. It does not prove anything was read or acted on.
  --key makes publish and send idempotent, and it is the only retry contract there is.
  When an outcome is uncertain, do not resend: a repeat without that key does the work twice.

bmn hook is not yours
  bmn hook <agent> is how BMN reads your harness's own hook events. Never run it by hand.
```

## What the app enforces

- Requests are validated for schema and size before anything runs.
- A session token can only publish, report and send for its own session, and only while that
  process incarnation is current.
- A conversation reported by `SessionStart` is accepted only from the session's own live process,
  only when the agent it names matches the command the session was launched with, and only as a
  UUID. Two live sessions can never bind one conversation: the second report is refused and the
  first session keeps it. The owner token cannot report a conversation. A hook prints nothing and
  throws away what the app answers, so every refusal is written with its reason to
  `refused-requests.log` in BMN's state folder (`$XDG_STATE_HOME/bmn/`), newest last and owner-only.
  The file is trimmed back to its newest half as soon as an append carries it past 256 KiB.
- `bmn list` and `bmn snapshot` carry each session's conversation route beside the fields they
  already had, as `conversation: { status, captureRoute }`, or `null` for a session with no
  binding. The reference itself is never listed, and a session sees only its own.
- An agent can publish only regular files inside its session's working directory or the system
  temporary folder; symlinks that escape those folders are refused. The app copies the file into
  its own store, hashes it, and never serves it back by path.
- `claimed-done` and `verified` are both shown as the reporter's words, with source and age —
  "Agent reports done", "Reported verified" — and never as BMN's own judgement.
- Evidence must be a file **this session** published. A restarted session can still name a file
  its previous process published: the rule is about the session, not the process.
- A request stays open in **Needs you** until it is resolved or withdrawn; reading it only clears
  the unread mark. Typing into its session resolves it, except a review.

These checks separate sessions from each other inside the app. They are not a sandbox against a
malicious program that already runs as your user and can read your files.
