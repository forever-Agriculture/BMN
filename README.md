<!-- MODULE: README.md - Build BMN and start a first session. -->
# BMN

*Use a proper terminal.*

A Linux desktop terminal for running a team of coding agents. It runs your shells and your
installed agent CLIs (Claude Code, Codex, OpenCode, or any other command) in real terminals and
keeps them organized in workspaces. Each session gets the `bmn` command, so its agent can share
files, report progress, ask you a question, message another session, read the project's plan and
get a read-only second opinion from a teammate on the team you approved.

BMN runs on your computer: it has no account, cloud backend or telemetry. Your agent CLIs still
talk to their own providers.

> Status: early and personal. It is built and used on Ubuntu 26.04 (x64). Other Linux distributions
> may work; macOS and Windows are not supported. There are no distribution packages: the build is an
> unpacked folder for the computer that made it.

BMN's author usually runs it with [dev-auto](https://github.com/forever-Agriculture/dev-auto), a
skill for Codex and Claude Code that implements planned epics and keeps going until they pass
acceptance. BMN shows those runs under **dev-auto runs…** ([dev-auto runs](docs/dev-auto.md)). BMN
works without it.

New here? The [feature guide](docs/features.md) walks through the main workflows — launching
and resuming sessions, answering agents, the team, files, voice, Telegram, backups — and says where each
feature stops. This page sums up the product and how to install it.

## What it does

- **Workspaces and sessions.** Named workspaces hold independent sessions. A session is a shell,
  Claude Code, Codex, OpenCode, or any command, with its own working directory. Rename, archive
  and edit launch settings. The New session form shows the directory's repository identity before
  it starts anything. Session details also shows the saved directory's read-only Git identity. Layout, order and selection survive a restart, but
  nothing starts automatically. After Quit, BMN offers to resume what it stopped in one dialog
  that shows each command and starts nothing until you press the button. A queued source update
  waits for BMN to exit; Quit first if you want that resume-all offer after the update.
  ([Workspaces and sessions](docs/features.md#workspaces-and-sessions))
- **Real terminals.** Each session is a real PTY rendered by one live
  [xterm.js](https://xtermjs.org/) view. There is no tmux layer and no replayed output, so key
  encodings, colors, bell and OSC notifications reach the program unchanged. Your CLIs keep their
  own configuration, authentication, hooks and permissions. Live panes support Sixel images and
  every session advertises them by default, so Codex `/pets` works in a direct BMN terminal; Codex
  inside tmux or Zellij may still reject it.
  ([The terminal and panes](docs/features.md#the-terminal-and-panes))
- **Process control and resume.** Stop a process and keep its last screen as saved output. Start it
  again, or resume the stored Claude Code / Codex / OpenCode conversation through the CLI's own
  resume. When you close the window, BMN asks about sessions set to **Ask** and applies saved
  keep-running or stop choices for the others.
  [What survives](docs/architecture.md#what-survives) says what each ending keeps.
  ([Process lifecycle and resume](docs/features.md#process-lifecycle-and-resume))
- **Agent control (`bmn`).** Every session gets the `bmn` command. An agent can list sessions,
  publish a file, report progress, ask you a question, hand a longer package to a working Claude Code
  or Codex session in any unarchived workspace (BMN delivers it itself; OpenCode, shell, stopped and
  archived destinations are refused), leave a peer a short message, or send text to its own session. Each session gets a token scoped to that session. `bmn hooks check` says
  which of BMN's hook entries each harness's own settings file carries, and
  `bmn hooks install <agent>` adds the missing ones without touching anything else.
  ([Agent attention](docs/features.md#agent-attention-needs-you-progress-and-handoffs),
  [docs/agent-control.md](docs/agent-control.md))
- **A team you approve.** One file you own names your agents, their apps, models, roles and whether
  each provider may see private work; nothing takes effect until you approve it. `bmn team ask` puts
  one question to the teammate of a role, in that app's own read-only mode, and the answer is advice.
  ([The team and one rules master](docs/features.md#the-team-and-one-rules-master))
- **One set of rules, skills and tools.** BMN keeps one rules text, one skills folder and one list of
  MCP tools, and writes them into each agent app's own settings, showing or undoing each change.
- **Limits you set.** **Pushes and merges** says what your sessions may push or merge without asking,
  per repository owner and repository. BMN installs deny rules for commands you must never run by
  accident (Docker and Podman prune, `prime-select nvidia`), and Claude Code and Codex hooks hold a
  wider set of critical commands for your review. This guard is not a sandbox.
- **Planning.** A project's plan lives in `plan/`, with one board you read and edit and one command
  (`bmn plan`) that reads, checks and changes it. ([Planning](docs/planning.md))
- **Manual QA.** A `qa` teammate tests a running web app against a curated brief and retains a checked
  report with browser evidence and a GO, GO WITH ISSUES or NO-GO verdict.
- **Away.** Say you are away and BMN shows a read-only **While you were away** summary when you are
  back. In between it may type one fixed reminder every two hours into an idle agent session; it never
  answers a request or resumes a session you stopped.
- **Needs you.** Agent questions stay open until you answer them or the agent withdraws them. Session and workspace dots, plus
  `Ctrl+Shift+U`, take you to the right one. Going to a session clears its notices; blocking
  requests stay until answered or explicitly dismissed. Its status button opens the request card. OpenCode subagent requests appear here too. Repeated
  Claude Code or Codex tool calls can open one informational notice; BMN never stops the agent.
  Progress reports are shown as the agent's claims, with any files it published as evidence.
  A workspace's **Review results…** view groups those reports; Session
  details distinguishes hook entries **Configured** in Preferences from events **Observed by BMN**.
- **Files.** Published files, attachments and pasted images are stored as immutable originals with
  a hash. The Files panel previews them and offers Open, Save As, Show in Folder and Deliver to
  session. ([Files and file references](docs/features.md#files-and-file-references))
- **Quick look.** `Ctrl+Shift+E` opens the project over the window: a file tree, go to a file,
  a search of the contents and Markdown rendered as a page. `.env` and supported config files can be
  edited and saved, with `.env` values masked. `Ctrl+click` a path an agent printed, such as
  `src/parser.ts:42:7`, to open it at that line; relative paths resolve from the session's launch
  directory. **Send to session…** appends a reference to a session's input without pressing Enter.
  ([Files and file references](docs/features.md#files-and-file-references))
- **Local voice dictation.** Hold Space in any terminal to talk; release to paste the text into the
  session, without pressing Enter. Transcription runs on your CPU with
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves the computer. Approve
  suggested project names and identifiers once, and Whisper gets them as a hint.
  ([Voice dictation](docs/features.md#voice-dictation), [docs/voice.md](docs/voice.md))
- **Optional Telegram.** Connect your own bot to get a message when a session needs you, and reply
  to that message to answer the session. ([Telegram](docs/features.md#telegram),
  [docs/telegram.md](docs/telegram.md))
- **Backups.** Export a consistent snapshot of the database and stored files with a hash manifest,
  and verify it later. ([Backups](docs/features.md#backups))
- **Appearance.** Four color modes for the app and the terminal: near-black Black (default), Steel,
  Brown and Dark, plus a Knight, Cross or Boss header identity.
  ([Customization](docs/features.md#customization))
- **Keyboard first.** `Ctrl+Shift+P` opens the command palette to search commands, workspaces,
  sessions and files in the addressed directory. Shortcuts handle navigation and common terminal
  actions.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Search in the terminal output |
| `Ctrl+Shift+E` | Quick look: open the project over the window (a selected file reference opens that file), or close it |
| `Ctrl+Shift+G` | Quick look: search the project's contents |
| `Ctrl+P`, `Ctrl+F`, `Ctrl+G`, `Ctrl+R` | In Quick look: go to a file, find in the file, go to a line, show a hidden value for ten seconds |
| `Ctrl+click` a printed path | Open it in Quick look at its line |
| `Ctrl+Shift+Enter` | Split the view (asks which session opens beside) or close the split |
| `Ctrl+Tab` | Switch to the other pane |
| `Ctrl+Shift+Z` | Focus mode |
| `Ctrl+Shift+↑` / `↓` | Previous / next session |
| `Ctrl+Shift+←` / `→` | Previous / next workspace |
| `Ctrl+Shift+U` | Next open request from an agent |
| `Ctrl+Shift+N` | Now: where every session is, who it waits on, the standup text; again to close |
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert`, right-click | Paste |
| `Ctrl+Shift+A` | Select all |
| `Ctrl+Shift+\` | Send the next key straight to the terminal |
| Hold `Space`, or `Ctrl+Shift+Space` | Dictate |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Font size |

Selecting text with the mouse copies it. Right-click goes to programs that read the mouse, such as
vim, unless you hold Shift. While such a program reads the mouse, `Ctrl+click` belongs to it too;
use **Open file reference…** in the palette instead. Send a literal `Ctrl+V` with `Ctrl+Shift+\`
first.

## Documentation

- [Features](docs/features.md): a user guide to the main workflows and their limits
- [Architecture](docs/architecture.md): processes, data flow and the rules they follow
- [Agent control](docs/agent-control.md): the `bmn` command and its local API
- [Planning](docs/planning.md): the plan format, the board and `bmn plan`
- [dev-auto runs](docs/dev-auto.md): what BMN shows of a dev-auto run
- [Session messages](docs/session-messages.md): how a message reaches another session's agent
- [Voice dictation](docs/voice.md): engine, models, speed and privacy
- [Telegram](docs/telegram.md): connecting your own bot
- [Telegram investigation notes](docs/telegram-investigations.md): open questions, regression checks and test pitfalls
- [Development](docs/development.md): building, testing, packaging and troubleshooting

## Install from source

Requirements (Linux x64, tested on Ubuntu 26.04):

- Node.js 24 and pnpm 12.3.4 (`corepack enable` picks the pinned pnpm)
- `node-gyp` on your `PATH` (`npm install -g node-gyp`); pnpm builds the native modules with it
- `cmake`, or [uv](https://docs.astral.sh/uv/), to build the voice engine
- a C/C++ toolchain and Python 3: `sudo apt install build-essential python3`

```bash
git clone https://github.com/forever-Agriculture/BMN.git
cd BMN
pnpm install
pnpm run package    # builds whisper.cpp, the app and a folder build for this computer
```

`pnpm run package` writes the build under `apps/desktop/release/`. Start it, and install it where
your desktop looks for applications:

```bash
apps/desktop/release/linux-unpacked/bmn
pnpm run install:desktop -- --pin     # launcher and icons; --pin adds it to the GNOME dock
pnpm run update:desktop               # later: wait for BMN to close, then rebuild and install
```

On Ubuntu 24.04 and later, AppArmor blocks the user namespaces that Chromium's sandbox needs. If
the app exits immediately with `SIGTRAP`, install the AppArmor profile described in
[docs/development.md](docs/development.md#ubuntu-apparmor). The app never turns the sandbox
off.

To try it without touching your real data, run the development build. It uses a throwaway
temporary folder:

```bash
pnpm --filter @bmn/desktop run dev
```

## Your first session

1. On a fresh profile, **Setup** finds Claude Code, Codex and OpenCode. **Install…** and
   **Sign in…** show the exact command, then run the app's own flow in a visible session.
   Setup sessions keep no saved output. You can skip setup and use ordinary sessions at any time.
2. **Review team…** proposes the ready apps and their roles. **Choose settings…** asks for a
   model, provider and effort when those settings cannot be read safely. Review and approve the
   team; private work starts off. BMN then installs its default rules, skills, hooks and, for
   Claude Code and Codex, the approved Playwright MCP entry. Setup shows anything that still
   needs attention, including Codex's one-time `/hooks` trust. An existing rules master or
   approved team skips first-run setup.
3. Press `Ctrl+Shift+P`, choose **New workspace…**, and name a project. Choose **New session…**
   there, then pick a launch template or enter a command and working directory. A shell works
   without agent integration; each agent keeps its own settings and authentication.
   Before an agent can read a private project, approve its destination in **Health › Set destination**,
   choose **Allow here**, and resend the first prompt if it was stopped.
4. Use the terminal normally. `Ctrl+Shift+Enter` opens a second session beside it; the Files panel
   accepts attachments and shows agent-published output.
5. Stop an ordinary session to keep its saved screen. **Start again** runs a fresh process;
   **Resume** reopens a conversation BMN knows, after showing the command it will run.

The [feature guide](docs/features.md) follows each workflow in more detail.

## Where data lives

| What | Where |
| --- | --- |
| Settings, bot token | `~/.config/bmn/` |
| Database, stored files, voice models | `~/.local/share/bmn/` |
| Saved output, file staging | `~/.local/state/bmn/` |
| Control socket | `$XDG_RUNTIME_DIR/bmn/control/` |

The `XDG_*` variables are respected. Folders are created owner-only. Existing installations
continue using legacy `ai-terminal` config, data and state folders when those already exist; BMN
leaves them in place rather than risking an automatic move.

## Privacy and security

- No telemetry, analytics or update checks.
- Once you keep a team file (Preferences → Agents), BMN asks GitHub, without credentials and at most
  once a day per workspace, whether the repository a session opens in is public. Nothing else
  leaves the machine unasked.
- The renderer is sandboxed with context isolation and no Node.js access; it reaches the rest of
  the app only through a narrow preload API.
- The control API is a Unix socket in an owner-only folder, with no TCP listener. Agents get tokens
  scoped to their own session.
- Voice audio is transcribed locally. Model downloads are pinned by size and SHA-256.
- Telegram is off by default. When on, it answers only the chat (and optionally the user) you allow.

These protections separate the app's parts from each other. They do not protect you from a
malicious program already running as your user.

## License

[MIT](LICENSE). whisper.cpp is MIT-licensed; its license is copied next to the built engine. The
Silero speech model (MIT, [snakers4/silero-vad](https://github.com/snakers4/silero-vad)) comes from
whisper.cpp's source archive.
