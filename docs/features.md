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
Archive refuses work that is running, starting, or awaiting a confirmed process exit, and names
the sessions to stop. A successful archive offers **Undo** for six seconds (longer while its button
has keyboard focus). Undo restores list visibility only; it opens no pane and starts no process.
New feedback replaces the action; a changed record or archived parent requires the ordinary Restore path.
The workspace row shows an attention dot when any session in it, even an archived one, has an open
request or update. Finished session names read more quietly; row action buttons appear on hover or
keyboard focus and remain available to the keyboard and screen readers.

A session is one command in one working directory: a shell, Claude Code, Codex, OpenCode, or
anything else installed. **New session…** opens the launcher beside the terminal:

- **Terminal, Claude Code, Codex, OpenCode, Cursor** — one click picks what runs. An agent starts inside an
  interactive bash (`bash -ic 'claude; exec bash -i'`), so your shell stays open when the agent
  exits. Saved templates appear as further cards; a template whose command is missing is marked
  unavailable and cannot be picked.
- **Name, Directory** — the name follows the pick until you type your own.
- **Advanced** — Template, Command, Arguments, when windows close (ask, keep running, or stop; a
  close prompt can remember your answer) and terminal images. The summary line always shows the
  exact command that will run. Arguments use shell quoting, so `'a b'` stays one argument.

Edit launch settings later from the session's or pane's menu, or search **Edit launch settings**
in the command palette for the selected pane. This edits the next launch, preserving the running
process and split layout. Sessions can be moved up and down, and
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
session launcher shows the same read-only check as one line under its directory, and the launch-set
preview shows it beside its selected directory.
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
Cursor's terminal agent (`cursor-agent`) gets its finished-turn notice, its agent name and Resume through
its hooks (`bmn hooks install cursor`); it reports no question or permission prompt, so those stay in
its terminal ([Agent control](agent-control.md#cursors-terminal-agent)).
Any other CLI still runs as a normal terminal session, without those.

**Model origin flag.** While a Claude Code, Codex, OpenCode or Cursor run reports through its own hooks,
its sidebar row, pane heading and Session details show the agent it really is (not "Shell") and
a small flag for the country of the company that made its model — 🇺🇸 for Anthropic, OpenAI and
other US labs, 🇨🇳 for GLM, Kimi, Qwen, DeepSeek, MiniMax or Xiaomi MiMo, and the flag of the main
French, German, Canadian, Korean and Japanese makers. The flag names the maker, not where the
model is hosted; Session details adds a Model row with the model name and API host. An
unrecognised model shows no flag rather than a guess. How it is decided:
[Agent control](agent-control.md#model-origin-flag).

**Agent history.** Preferences → History → Keep agent history (10, 30 or 90 days, or Never; default
30) is one limit for every agent: Claude Code and `claude glm` get it as their own
`cleanupPeriodDays`, and BMN deletes Codex and OpenCode sessions untouched for longer through their
own delete commands, at most 200 per agent per daily run. Cursor has no delete command, so its row
reads "keeps its own history · not managed by BMN". Nothing is written or deleted until you
press Start cleanup once; the Preferences button shows the attention dot while it waits. Sessions in
use are never deleted. See [Agent history](agent-history.md).

**Archive retention.** Preferences → History → Delete archived sessions and workspaces sets how long
archived sessions and workspaces are kept: a number of days, or forever. The check runs when BMN
starts. Deletion is permanent and takes the saved output, requests and Telegram history with it;
published files are kept.

## The terminal and panes

Each session is a real terminal — a PTY rendered by one live [xterm.js](https://xtermjs.org/) view.
There is no tmux layer and no replayed output, so key encodings, colors, bell and OSC notifications
reach the program unchanged, and your CLIs keep their own configuration, authentication, hooks and
permissions.

Live panes display Sixel images. Every session has **Terminal images (Sixel)** on by default,
whether it runs a shell, Codex, Claude Code, OpenCode or another agent, so Codex can use `/pets`
however you start it. **Off** in the New session form opts a session out and keeps
`TERM=xterm-256color`. Graphics sessions use BMN's `xterm-sixel-256color` terminfo entry. On SSH
hosts, under `sudo`, or inside containers without that entry, run the remote or privileged command
with `TERM=xterm-256color`, or set that session to Off. A Codex process inside tmux or Zellij follows
that multiplexer and may reject pets. Saved output is text only; pet pixels are not saved.

- **Split.** `Ctrl+Shift+Enter` opens a second pane beside the current one (it asks which session)
  or closes the split. `Ctrl+Tab` switches panes; the pane menu arranges them side by side or
  stacked.
- **Focus mode** (`Ctrl+Shift+Z`, or the Focus button in the pane header).
- **Search** (`Ctrl+Shift+F`) searches the terminal's output; `Enter` finds the next match,
  `Shift+Enter` the previous one, `Escape` closes it. The search bar floats over the top-right of
  the terminal, so opening, using and closing it never resizes the terminal or makes the program
  redraw. Use **Bottom**/**Top** to move Find away from a hidden match. Its query,
  selected match and position stay with this mounted session view.
- **Copy and paste.** Selecting with the mouse copies. `Ctrl+Shift+C` copies the selection; paste
  with `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` or right-click. Dragging across text also copies when
  a program enables mouse reporting, as Codex does. `Ctrl+Shift+A` selects all.
- **Programs that copy.** tmux with `set-clipboard on`, Neovim's OSC 52 clipboard provider and
  anything over SSH copy with the standard OSC 52 sequence; BMN puts that text on your clipboard
  (or the primary selection, on Linux) as plain text, up to 192 KiB, and says "Copied from
  *session* (*N* characters)". No program can read the clipboard: a read request gets no answer.
  Only output that arrives live, while BMN's window is open, copies; reopening the window or
  rebuilding a view never copies again. Preferences → Terminal → **Let programs copy to the clipboard** turns it
  off.
- **Keys that belong to the program.** `Ctrl+Shift+\` sends the next key straight to the terminal —
  use it first for a literal `Ctrl+V`. Right-click pastes even while a program reads mouse input;
  `Ctrl+click` remains available to that program. Use **Open file reference…** in the
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
through each CLI's own resume; for OpenCode through `opencode --session <id>`; for Cursor through
`cursor-agent --resume=<id>`. It works only for a
session whose conversation BMN knows: one pinned at launch, one you located by hand, or one the
harness reported. Any other program can report its own resume command with `bmn resume-command`
([agent-control.md](agent-control.md#resume-for-any-program)); where BMN has no conversation of its
own, Resume offers that command, shown exactly with the folder and the time the program reported
it. Anything else says so and offers **Start again** instead. The Resume dialog shows the exact
command before anything runs, and names any stored argument the CLI's resume will not take.

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
conversation. Resume rows are pre-checked, except a Resume that runs a command a program reported,
which you tick yourself; the rows start in order, one at a time, and stop after
the first failure, so every row ends up reading *started*, *failed* with the reason, or *not
started*. Nothing begins until you press the button, the offer is made once per stop, and
**Resume interrupted sessions…** in the palette reopens it afterwards.

The [what survives table](architecture.md#what-survives) says exactly what each of the seven endings
keeps.

## Agent attention: Needs you, progress and handoffs

**Needs you** is the set of open requests across your sessions, shown by session and workspace dots;
`Ctrl+Shift+U` jumps to the next one. A request can be a *question*, *permission*, *review*,
*notice* or *handoff*. Each row says what opened it and what closed it — "from Claude Notification",
"withdrawn by Claude Stop", "resolved by typing", "expired". Going to a session clears its notices, retaining their details in that session’s request card until you navigate elsewhere.
Blocking requests stay open until answered, explicitly dismissed, withdrawn by the agent or expired. Typing, pasting or dictating into a session also resolves
its open prompts and notices, the way answering in the terminal does. Typing does not close review
or handoff requests. Click the session’s status word to open its request card, including for stopped or archived sessions.
It offers **Open handoff**, **Dismiss**, and **Mark answered** once you have dealt with it in the terminal.

Questions and choices are read-only in the card; answer in the terminal or on Telegram.
`Ctrl+Shift+U` cycles sessions in the highest waiting tier, opens a review’s card or a handoff in Files,
and focuses the terminal for questions and permissions. A gold dot on Focus signals requests in other sessions.
Incoming requests leave your focus in place; cards overlay the pane without resizing its terminal.

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
**Local control** shows whether the control socket is listening, with its path; a runtime
path that is too long disables the socket, and Preferences says so. **Check configured hooks**
reads BMN's existing checker report for Claude Code, Codex and OpenCode, including missing
entries and a check time. It changes no harness file. **Configured** describes entries in a
file; it does not prove a hook fired.

For Claude Code, Codex and OpenCode, `bmn hooks check` reports which of BMN's entries each
harness's own settings file carries, and `bmn hooks install claude` (or `codex`, `opencode`) adds
the missing ones after backing the file up. A harness with no hook can still page you by writing
the terminal's own OSC 9, 777 or 99 notification. OSC 9's leading `4` parameter (`4` or `4;…`)
is reserved for progress and ignored, including malformed forms or prose using that parameter.
Ordinary text such as `4 tests passed` remains a notice. BMN presents a notice, which clears when
you type into the session. The session's ⋯ menu has **Hook events…**, a short list of
what the harness actually reported, which answers "why is there no request for this?".
Session details shows the latest harness event **Observed by BMN** for that session's current
process run, with its receipt time and a link to Hook events. **Not observed in this run**
can simply mean no relevant event happened. The observation is in memory and disappears
after BMN restarts. The dialog also labels **Earlier host run · history**, a metadata-only snapshot
kept in an owner-only state file. It retains up to 30 rows per session, 1,024 globally and 1 MiB;
oldest rows leave first, so some sessions keep fewer. Unknown event/source/tool labels become `other`.
It retains no prompts, answers, payloads, tool input/output, model/API-host details or configuration.
History never recreates requests or current observations. There is no age expiry; deleted sessions
lose their rows, retained archives keep theirs. Coalesced events can be lost before the next atomic
save, including on crash. Unavailable history is explained in the dialog, and backups exclude it.
OpenCode subagent permissions and questions use their own requests, so they do not replace the
main session's prompt. For Claude Code and Codex, eight identical tool calls (failed ones count too) among the
last 20 since your last message open one notice; the hook event list shows the repeat count. BMN
only tells you and leaves the agent running.

The full command reference, the hook contract and the security model are in
[agent-control.md](agent-control.md). Two limits matter here: everything an agent reports is its
claim, not a verified fact, and the control API keeps sessions apart but is not a sandbox against a
program that already runs as your user.

### The team and one rules master

Preferences → **Team** keeps the agents you work with in one file you own: each agent's class
(knight, queen, rook, bishop or pawn), app, model and provider, which roles it may take and in what
order, and whether its provider may see private work. Nothing in that file takes effect until you
approve it there; every approval is a numbered version you can open or restore. Agents read the
approved team with `bmn team`, and a lead runs `bmn roster check` before it hands work to another
agent.

Preferences → **Rules** keeps one rules text and writes it into each agent app's own rules file
(Claude Code, Codex, OpenCode and Cursor), shows each file's difference before it writes, and can
undo an install. An app whose provider may not see private work receives only the sections you
marked public, and so do OpenCode and Cursor, whose requests BMN does not check. Details and limits are in [agent-control.md](agent-control.md#the-team-team-file-check-and-rules).

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
labelled **Files** group. **Commands**, **Sessions** and **Workspaces** also accept label
abbreviations such as `nxt req` or `qat` for Q-Automations. Ordinary literal matches come first
within each group, keeping their existing order and context matching. The highlighted row stays
selected as you type if it still matches. Files use literal words; nothing runs until Enter or a click.
Filename traversal excludes `.git` and `node_modules` by name, and descendant directories named
`dist`, `build`, `out`, `coverage`, `.next` and `.cache`. A selected root with one of those names is
still searched, as are regular files with the six generated names. Genuine source folders with
those names can be hidden: use **Open file reference…** with the exact path or an existing context
rooted there. This fixed policy does not interpret `.gitignore`.

With a selected session, the filename-search root is that process's launch directory while
it runs, or the session's stored directory after it stops. With no selected session, the root is the
workspace's default directory; opening a match then asks you to select a session for the preview.
The read is on demand and stops at six directory levels, 20,000 entries scanned or 50 matching files;
the palette labels a cap. It does not follow symbolic links, and
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
never lands in whichever session happens to be focused.

Pages are cards with buttons: tap an option to answer an agent's question (Claude Code, Codex in Plan
mode, OpenCode; several questions one at a time, with **‹ Back**; multi-select as toggles; **Other…** to
reply in your own words), or **Allow once** / **Deny** a Claude `Bash` or
OpenCode permission once you turn on **Answer permission prompts from Telegram** (never "always
allow"). The card then says what happened: ✓ only when the agent confirmed the answer, ⚠ when it was
sent but not confirmed, or why nothing was sent. Codex permissions, subagent and sandbox prompts still
say to answer at the laptop. Telegram cannot deliver handoffs or
manage sessions.

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
- One exception, only once you keep a team file: when a session opens in a workspace, at most
  once a day, BMN asks GitHub without credentials whether that workspace's `origin` repository is
  public. The request carries the repository's owner and name and nothing else.
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
| Team file, rules master, approved versions | `~/.config/bmn/agents/` |
| Database, stored files, voice models | `~/.local/share/bmn/` |
| Saved output, file staging | `~/.local/state/bmn/` |
| Control socket | `$XDG_RUNTIME_DIR/bmn/control/` |

The `XDG_*` variables are respected and each folder can be overridden. Folders are created
owner-only. [development.md](development.md) lists the override variables.

Recent sessions (`Ctrl+Shift+R`, or **Recent sessions…** in the palette) lists up to
20 sessions you selected or focused, newest first. The order stays fixed while the
chooser is open; archived/deleted sessions disappear. Enter/click navigates only
when you choose, and a session already in the other pane is focused there.

**Pinned files…** in a workspace menu stores up to eight paths you choose. Relative
Add paths resolve once against that workspace’s displayed default folder; without
one, use an absolute path. Open reads the current file through the safe preview,
including fresh symlink checks. Missing/unavailable files remain removable pins.
Pins store paths only, and never send content to an agent.

Collapsed workspace groups retain the selected unarchived session row and hide its
siblings. Counts and Move up/down still refer to the complete group. In Preferences,
the list on the left opens one page at a time; changing page neither saves nor resets edits.
