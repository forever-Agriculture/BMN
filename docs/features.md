# BMN features

This page walks through what you can do with BMN, workflow by workflow, and says plainly where each
feature stops. The keyboard shortcuts are collected in the [README](../README.md#keyboard); the
specialist pages carry the detail this page links to.

- [Architecture](architecture.md): processes, data flow, and what each way of ending keeps
- [Agent control](agent-control.md): the `bmn` command, its local API and the agent hooks
- [Voice dictation](voice.md): engine, models, speed and privacy
- [Telegram](telegram.md): connecting your own bot
- [Development](development.md): building, testing, packaging and troubleshooting

Install BMN from source as described in the [README](../README.md#install-from-source), then start
it like any desktop application.

## Workspaces and sessions

The sidebar groups sessions into workspaces. A workspace is a named group of sessions with its own
layout. Create more with **New workspace…** (the palette or the workspace menu), rename them,
reorder them, give each one a marker so its panes are easy to tell apart, and archive a workspace
when you are done with it. Archived items can be restored until the retention setting deletes them.
The workspace row shows an attention dot when any session in it, even an archived one, has an open
request or update. Finished session names read more quietly; row action buttons appear on hover or
keyboard focus and remain available to the keyboard and screen readers.

A session is one command in one working directory: a shell, Claude Code, Codex, OpenCode, or
anything else installed. **New session…** opens a form:

- **Template** — a saved launch (name, command, arguments, working directory, close behaviour) that
  fills the form. A template whose command is missing is marked unavailable and cannot be picked.
- **Name, Command, Arguments, Working directory** — what runs, and where.
- **When windows close** — ask, keep the session running, or stop it. A close prompt can remember
  your answer for the next time.

Edit launch settings later from the session's or pane's menu. Sessions can be moved up and down, and
archived once stopped; **Restore session** brings an archived one back.

**Launch sets** in a workspace menu or the palette save 1–8 ordered command definitions. You can
copy an existing template into a set; later edits to either one do not change the other. The set
editor stores arguments as an exact JSON array, so an argument containing spaces stays one
argument. Saving, reordering or deleting a set starts and stops nothing. **Launch set…** shows
every command and one directory for the whole set. It warns about matching live sessions and
starts fresh sessions only after **Start N new sessions**. Entries start in order; a failure stops
later entries, while already started sessions stay available. The result names each started,
failed or not-started entry and links to saved sessions where BMN has one. A new deliberate launch
uses a new preview.

**Repository identity** in Session details reads the session's saved launch directory and shows
its Git root, branch or detached/unborn state, linked worktree status and read time. The New
session form and launch-set preview show the same read-only check beside their selected directory.
BMN checks again when you press Create or Start; if a known identity changed, it shows the new
value for review before another press. A non-repository or unavailable Git result is named and
does not by itself block an otherwise valid launch. This describes the selected directory at the
time shown, not where a running shell may have moved later. BMN never checks out a branch or
creates a worktree for this feature.

Sessions are independent: each has its own process, its own terminal, and a token that reaches only
itself. A session launched from inside an agent does not inherit that agent's session identity
either: BMN strips agent session variables such as `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID`
from the environment the command runs in, so the new session starts clean. BMN tags common
commands — Claude, Codex, OpenCode, Gemini, Aider, Shell — but the deeper
integration (attention hooks and conversation resume) is built for Claude Code, Codex and OpenCode.
Any other CLI still runs as a normal terminal session, without those.

**Archive retention.** Preferences → Archive sets how long archived sessions and workspaces are
kept: a number of days, or forever. The check runs when BMN starts. Deletion is permanent and takes
the saved output, requests and Telegram history with it; published files are kept.

## The terminal and panes

Each session is a real terminal — a PTY rendered by one live [xterm.js](https://xtermjs.org/) view.
There is no tmux layer and no replayed output, so key encodings, colors, bell and OSC notifications
reach the program unchanged, and your CLIs keep their own configuration, authentication, hooks and
permissions.

- **Split.** `Ctrl+Shift+Enter` opens a second pane beside the current one (it asks which session)
  or closes the split. `Ctrl+Tab` switches panes; the pane menu arranges them side by side or
  stacked.
- **Focus mode** (`Ctrl+Shift+Z`, or the Focus button in the pane header).
- **Search** (`Ctrl+Shift+F`) searches the terminal's output; `Enter` finds the next match,
  `Shift+Enter` the previous one.
- **Copy and paste.** Selecting with the mouse copies. `Ctrl+Shift+C` copies the selection; paste
  with `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` or right-click. `Ctrl+Shift+A` selects all.
- **Keys that belong to the program.** `Ctrl+Shift+\` sends the next key straight to the terminal —
  use it first for a literal `Ctrl+V`. Programs that read the mouse, such as vim, get right-click
  and `Ctrl+click` too; hold `Shift` for BMN's right-click, and use **Open file reference…** in the
  palette while the mouse is captured.
- **Font size** with `Ctrl +`, `Ctrl −`, `Ctrl 0`.

Every pane header shows a status dot and a word: *Running*, *Waiting for your response*,
*Update available*, *Process exited*, *Interrupted*, *Not started*. An open request for your
attention outranks the process state. The footer shows what typing will do and holds **Speak**,
**Attach** and **Paste image**; dragging files onto a pane attaches them to the session.

When a process ends, its pane stays so you can read what it printed; the footer reads *Process
ended · input closed*.

## Process lifecycle and resume

Stopping a session ends its process but keeps the session, its place in the layout, and its last
screen as **saved output** — a plain-text snapshot taken periodically, on stop and on quit. It is
never replayed into a terminal. **Start again** runs the stored command fresh. Output written just
before a crash, after the last snapshot, can be lost; BMN says so when it recovers.

**Resume** reopens the conversation a stopped agent was in. For Claude Code and Codex it goes
through each CLI's own resume; for OpenCode through `opencode --session <id>`. It works only for a
session whose conversation BMN knows: one pinned at launch, one you located by hand, or one the
harness reported. Anything else says so and offers **Start again** instead. The Resume dialog shows
the exact command before anything runs, and names any stored argument the CLI's resume will not
take.

Windows and processes end separately:

- **Close** asks about running sessions set to *Ask*; saved *keep running* or *stop* choices apply
  automatically to the others. Keeping a session running minimizes the window.
- **Quit** lists the running sessions and asks first.
- A renderer crash keeps every process running; a fresh view is created and the program is asked to
  repaint.
- After an app crash or a reboot, the earlier processes are marked *interrupted* and nothing
  restarts on its own.

When Quit stopped sessions, the next start offers them back in one dialog. A queued source desktop
update waits for BMN to exit; it does not stop sessions itself. Quit to get the offer after the
update. Closing the last window and choosing Stop records *last window close* instead, so those
sessions remain individually resumable without a resume-all offer.
Each row shows the exact command — *Resume*, or *Start again* for a session without a bound
conversation. Resume rows are pre-checked; the rows start in order, one at a time, and stop after
the first failure, so every row ends up reading *started*, *failed* with the reason, or *not
started*. Nothing begins until you press the button, the offer is made once per stop, and
**Resume interrupted sessions…** in the palette reopens it afterwards.

The [what survives table](architecture.md#what-survives) says exactly what each of the seven endings
keeps.

## Agent attention: Needs you, progress and handoffs

**Needs you** is the queue of open requests across your sessions, counted in the header;
`Ctrl+Shift+U` jumps to the next one. A request can be a *question*, *permission*, *review*,
*notice* or *handoff*. Each row says what opened it and what closed it — "from Claude Notification",
"withdrawn by Claude Stop", "resolved by typing", "expired". A request stays open until you answer
it, the agent withdraws it or it expires. Typing, pasting or dictating into a session also resolves
its open prompts and notices, the way answering in the terminal does. Typing does not close review
or handoff requests. The popover offers **Open session**, **Acknowledge**, and
**Mark answered** once you have dealt with it in the terminal.

When desktop notifications are enabled, BMN shows one for a new request unless you are already
looking at that session.

**Progress.** An agent can report running, waiting, blocked, done or failed, shown on a strip under
the pane header. **Progress details** opens a read-only view of the report: who reported it, when,
and any files the session published as evidence. Read it by one rule: *done* is the agent's claim,
shown as "Agent reports done", never BMN's verdict. A file the agent deleted later stays in the
report as a named, unavailable reference.
From a workspace's ⋯ menu, **Review results…** groups each session's latest report per named
source, with observation time, current or previous run, ten-minute freshness and evidence
availability. It names sessions with no report. This view reads current records; it does not
judge whether an agent succeeded or promise a report history.

**Handoffs.** An agent can prepare a package for another session — text plus up to ten of its
published files — but cannot deliver it. The handoff opens in the source session's Needs you queue;
you open the Files panel, check or edit the text and files, and press **Paste handoff** in the
destination. Pasting appends the package to that session's input without pressing Enter, so you
submit it yourself. A handoff reads *prepared*, *pasted (not submitted)*, *pasted, outcome
uncertain* or *discarded*; after an uncertain paste you can create a separate retry draft. A
handoff you receive conveys context, not authority.
The same workspace results view lists pending and uncertain handoffs for either the source or
destination workspace, with both names and a route to review the exact draft in Files. Opening
that view never pastes or submits a handoff. Its draft list is bounded, not a complete history.

### How agents reach the app

Every session gets the `bmn` command and a token scoped to that session and run. An agent can list
sessions, publish a file, report progress, ask you a question, prepare a handoff, or send text to
its own terminal. `bmn help agents` prints the etiquette page agents can read. Preferences →
**Local agent control** shows whether the control socket is listening, with its path; a runtime
path that is too long disables the socket, and Preferences says so. **Check configured hooks**
reads BMN's existing checker report for Claude Code, Codex and OpenCode, including missing
entries and a check time. It changes no harness file. **Configured** describes entries in a
file; it does not prove a hook fired.

For Claude Code, Codex and OpenCode, `bmn hooks check` reports which of BMN's entries each
harness's own settings file carries, and `bmn hooks install claude` (or `codex`, `opencode`) adds
the missing ones after backing the file up. A harness with no hook can still page you by writing
the terminal's own OSC 9, 777 or 99 notification. BMN presents it as a notice, which clears when
you type into the session. The session's ⋯ menu has **Hook events…**, a short in-memory list of
what the harness actually reported, which answers "why is there no request for this?".
Session details shows the latest harness event **Observed by BMN** for that session's current
process run, with its receipt time and a link to Hook events. **Not observed in this run**
can simply mean no relevant event happened. The observation is in memory and disappears
after BMN restarts; the recent event list can lose older detail.
OpenCode subagent permissions and questions use their own requests, so they do not replace the
main session's prompt. For Claude Code and Codex, eight identical tool calls (failed ones count too) among the
last 20 since your last message open one notice; the hook event list shows the repeat count. BMN
only tells you and leaves the agent running.

The full command reference, the hook contract and the security model are in
[agent-control.md](agent-control.md). Two limits matter here: everything an agent reports is its
claim, not a verified fact, and the control API keeps sessions apart but is not a sandbox against a
program that already runs as your user.

## Files and file references

The **Files** panel, per session, holds everything that moved through that session: files agents
published, files you attached, images you pasted. Each is stored as an immutable original with a
hash. The panel previews it and offers **Open**, **Save As** (the copy is checked against the hash
first), **Show in Folder**, and **Deliver to session**, which pastes the file's path into the
session without pressing Enter. Imports are bounded: 250 MiB per file, 10 GiB in total.

Agents can publish only regular files under their session's working directory or the system
temporary folder; a symlink that escapes those is refused.

**File references.** `Ctrl+click` a path an agent printed, such as `src/parser.ts:42:7`, or use
**Open file reference…** in the palette, to see a read-only snapshot of that file at the line and
column, with **Copy reference** and **Show in Folder**. Relative paths resolve from the session's
launch directory, which the dialog names; you can pick another folder for one opening. The preview
reads regular UTF-8 text files of at most 1 MiB, refreshes only when you ask, and edits, runs and
stores nothing.

To put a reference into another session, open its preview and choose **Send to session**. The
chooser lists unarchived sessions across visible workspaces and starts with no destination selected.
**Review send…** shows the exact absolute path and line to append, plus the destination's workspace,
name and current process. **Paste reference** appends that text to the chosen session's input without
pressing Enter; BMN reports it as pasted, not submitted. If the window loses focus or the destination
stops, restarts or is archived, choose it again. A path the reference grammar cannot represent
cannot be sent.

In the command palette (`Ctrl+Shift+P`), typing a query also searches filenames and paths in a
labelled **Files** group. With a selected session, the root is that process's launch directory while
it runs, or the session's stored directory after it stops. With no selected session, the root is the
workspace's default directory; opening a match then asks you to select a session for the preview.
The read is on demand and stops at six directory levels, 20,000 entries scanned or 50 matching files;
the palette labels a cap. It skips `.git` and `node_modules`, does not follow symbolic links, and
new typing supersedes an older search. An unavailable directory shows no files. There is no index,
content search or watcher.

## Voice dictation

Hold **Space** in any terminal to talk; recording starts after 0.3 seconds, and releasing pastes the
transcript into the session without pressing Enter, so you can review it first. A quick tap still
types a space. You can also press **Speak** in the pane footer or `Ctrl+Shift+Space`. Transcription
runs on your CPU with [whisper.cpp](https://github.com/ggml-org/whisper.cpp); no audio or text
leaves the computer.

Setup, once: `pnpm run package` builds the voice engine (`pnpm run voice:build` does it alone),
then Preferences → **Voice** downloads a model — Base (148 MB, faster) or Small (488 MB, better for
mixed or non-English speech) — and you pick a language or leave detection on; nine languages are
offered. **Vocabulary** holds project names and identifiers Whisper should expect: press **Suggest
from current session**, edit and approve what looks right, and they are passed as a hint on every
recording, at most 30 words and 223 bytes in total. A recording with no speech pastes nothing.

Limits: the vocabulary is a hint, not a rule, and the benefit depends on your voice and microphone.
If **Speak** opens Preferences, no model is installed or the engine is not built yet. If
transcription is slow, use Base or choose your language. [voice.md](voice.md) has the details.

## Telegram

BMN can page you on Telegram when a session needs you, and take your reply back to that exact
session. It is off by default and uses a bot you create and own. BMN normally pages while you are
away from the desk (about a minute without keyboard or mouse), after checking that the request is
still open and unseen. It sends each request once; optionally it also tells you when a session's
process exits while you are away. If BMN cannot read idle time, it treats you as away. A Claude Code
session connected to Remote Control is left to the Claude app.

By default a reply is saved as a **draft** for that session, which you send from the Files panel;
if you turn on direct typing, the reply is typed into the session and Enter is pressed. Replies to
handoff pages always stay drafts. Anything that is not a reply gets a short pointer back — text
never lands in whichever session happens to be focused. Telegram cannot approve permission prompts,
deliver handoffs or manage sessions.

Setup: create a bot with [@BotFather](https://t.me/BotFather), read your chat ID from `getUpdates`,
then Preferences → **Telegram**: paste the token, set the allowed chat (and user, for a group
chat), choose what to notify about, enable, and send a test message. The token is stored with
owner-only permissions and never shown again. Use a bot that no other program polls. Details in
[telegram.md](telegram.md).

## Backups

Preferences → **Backup** has two actions. **Export backup…** writes a consistent snapshot — the
database plus the stored files it references — with a hash manifest, and lists what it excluded.
**Verify a backup…** later checks the files against the manifest and against the backup's own
database. Exports are manual: there is no schedule and no built-in restore step.

## Customization

Preferences → **Appearance**: an identity for the header (Knight, Cross or Boss), a color mode for
the app and the terminal — Black (default), Steel, Brown, Dark — and the terminal font size, which
`Ctrl +` / `Ctrl −` / `Ctrl 0` also change. Identity and colors are switchable from the palette
too. The session launch form offers templates and a close-behaviour choice; **Edit launch
settings** lets you change the saved command and close behaviour. Elsewhere in Preferences are
archive retention, the Hold Space toggle and voice settings, and the Telegram connection.

`Ctrl+Shift+P` opens the command palette to search common actions, workspaces, sessions and files. The
full shortcut table is in the [README](../README.md#keyboard).

## Privacy and where data lives

- No account, no cloud backend, no telemetry, analytics or update checks. Everything runs on your
  computer.
- The interface runs in a sandboxed renderer with context isolation and no Node.js access; it
  reaches the rest of the app only through a narrow preload API.
- The agent control API is a Unix socket in an owner-only folder, with no TCP listener; each
  session's token works only for that session.
- Voice audio is transcribed locally; the microphone is open only while recording; model downloads
  are pinned by size and SHA-256.
- Telegram is off by default and answers only the chat (and optionally the user) you allow.

These protections separate the app's parts from each other. They do not protect you from a
malicious program already running as your user.

| What | Where |
| --- | --- |
| Settings, bot token | `~/.config/bmn/` |
| Database, stored files, voice models | `~/.local/share/bmn/` |
| Saved output, file staging | `~/.local/state/bmn/` |
| Control socket | `$XDG_RUNTIME_DIR/bmn/control/` |

The `XDG_*` variables are respected and each folder can be overridden. Folders are created
owner-only. [development.md](development.md) lists the override variables.
