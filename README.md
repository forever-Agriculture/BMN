# BMN

*Be a man: use a proper terminal.*

A desktop terminal for working with coding agents on Linux. It runs your shells and your
installed agent CLIs (Claude Code, Codex, OpenCode, or any other command) in real terminals, keeps
them organized in workspaces, and gives the agents a small local API for sharing files, reporting
progress and asking for your attention.

Everything runs on your computer. There is no account, cloud backend or telemetry.

> Status: early and personal. It is built and used on Ubuntu 24.04 (x64). Other Linux distributions
> may work; macOS and Windows are not supported. There are no distribution packages: the build is an
> unpacked folder for the computer that made it.

New here? The [feature guide](docs/features.md) walks through the main workflows — launching
and resuming sessions, answering agents, files, voice, Telegram, backups — and says where each
feature stops. This page sums up the product and how to install it.

## What it does

- **Workspaces and sessions.** Named workspaces hold independent sessions. A session is a shell,
  Claude Code, Codex, OpenCode, or any command, with its own working directory. Launch templates,
  rename, archive and edit launch settings. Save a workspace launch set of up to eight copied
  commands, review its one directory and repository identity, then start fresh sessions explicitly.
  Session details also shows the saved directory's read-only Git identity. Layout, order and selection survive a restart, but
  nothing starts automatically; after an update or a quit, BMN offers to resume what the stop
  interrupted, in one dialog that shows each command and starts nothing until you press the button.
  ([Workspaces and sessions](docs/features.md#workspaces-and-sessions))
- **Real terminals.** Each session is a real PTY rendered by one live
  [xterm.js](https://xtermjs.org/) view. There is no tmux layer and no replayed output, so key
  encodings, colors, bell and OSC notifications reach the program unchanged. Your CLIs keep their
  own configuration, authentication, hooks and permissions.
  ([The terminal and panes](docs/features.md#the-terminal-and-panes))
- **Process control and resume.** Stop a process and keep its last screen as saved output. Start it
  again, or resume the stored Claude Code / Codex / OpenCode conversation through the CLI's own
  resume. When you close the window, BMN asks about sessions set to **Ask** and applies saved
  keep-running or stop choices for the others.
  [What survives](docs/architecture.md#what-survives) says what each ending keeps.
  ([Process lifecycle and resume](docs/features.md#process-lifecycle-and-resume))
- **Agent control (`bmn`).** Every session gets the `bmn` command. An agent can list sessions,
  publish a file, report progress, ask you a question, prepare an owner-delivered handoff, or send
  text to its own session. Each session gets a token scoped to that session. `bmn hooks check` says
  which of BMN's hook entries each harness's own settings file carries, and
  `bmn hooks install <agent>` adds the missing ones without touching anything else.
  ([Agent attention](docs/features.md#agent-attention-needs-you-progress-and-handoffs),
  [docs/agent-control.md](docs/agent-control.md))
- **Needs you.** Agent questions stay open until you answer them or the agent withdraws them. A
  header count, a dot on each workspace that has a waiting session or open update, and
  `Ctrl+Shift+U` take you to the right one. OpenCode subagent requests appear here too. Repeated
  Claude Code or Codex tool calls can open one informational notice; BMN never stops the agent.
  Progress reports are shown as the agent's claims, with any files it published as evidence.
  A workspace's **Review results…** view groups those reports and pending handoffs; Session
  details distinguishes hook entries **Configured** in Preferences from events **Observed by BMN**.
- **Files.** Published files, attachments and pasted images are stored as immutable originals with
  a hash. The Files panel previews them and offers Open, Save As, Show in Folder and Deliver to
  session. ([Files and file references](docs/features.md#files-and-file-references))
- **File references.** `Ctrl+click` a path an agent printed, such as `src/parser.ts:42:7`, or use
  **Open file reference…** in the palette, to see a read-only snapshot of that file at the line,
  with Copy reference and Show in Folder. Relative paths resolve from the session's launch
  directory, which the preview names; you can pick another folder for one opening. Nothing is
  edited, run or stored.
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
- **Keyboard first.** `Ctrl+Shift+P` opens the command palette to search commands, workspaces and
  sessions. Shortcuts handle navigation and common terminal actions.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Search in the terminal output |
| `Ctrl+Shift+Enter` | Split the view (asks which session opens beside) or close the split |
| `Ctrl+Tab` | Switch to the other pane |
| `Ctrl+Shift+Z` | Focus mode |
| `Ctrl+Shift+↑` / `↓` | Previous / next session |
| `Ctrl+Shift+←` / `→` | Previous / next workspace |
| `Ctrl+Shift+U` | Next open request from an agent |
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert`, right-click | Paste |
| `Ctrl+Shift+A` | Select all |
| `Ctrl+Shift+\` | Send the next key straight to the terminal |
| Hold `Space`, or `Ctrl+Shift+Space` | Dictate |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Font size |
| `Ctrl+click` a printed file path | Open a read-only preview of the file |

Selecting text with the mouse copies it. Right-click goes to programs that read the mouse, such as
vim, unless you hold Shift. While such a program reads the mouse, `Ctrl+click` belongs to it too;
use **Open file reference…** in the palette instead. Send a literal `Ctrl+V` with `Ctrl+Shift+\`
first.

## Documentation

- [Features](docs/features.md): a user guide to the main workflows and their limits
- [Architecture](docs/architecture.md): processes, data flow and the rules they follow
- [Agent control](docs/agent-control.md): the `bmn` command and its local API
- [Voice dictation](docs/voice.md): engine, models, speed and privacy
- [Telegram](docs/telegram.md): connecting your own bot
- [Development](docs/development.md): building, testing, packaging and troubleshooting

## Install from source

Requirements (Linux x64, tested on Ubuntu 24.04):

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
[docs/development.md](docs/development.md#ubuntu-2404-apparmor). The app never turns the sandbox
off.

To try it without touching your real data, run the development build. It uses a throwaway
temporary folder:

```bash
pnpm --filter @bmn/desktop run dev
```

## Your first session

1. Press `Ctrl+Shift+P`, choose **New workspace…**, and name a project. You can give it a default
   directory.
2. Choose **New session…** in that workspace. Pick a launch template or enter a command and working
   directory. A shell works without agent integration; an agent CLI uses its own existing settings
   and authentication.
3. Use the terminal normally. `Ctrl+Shift+Enter` opens a second session beside it; the Files panel
   accepts attachments and shows agent-published output.
4. If you use Claude Code, Codex or OpenCode, run `bmn hooks check` inside its session to see
   whether its questions can appear in **Needs you**. `bmn hooks install <agent>` adds missing BMN
   entries after backing up the harness settings file.
5. Stop a session to keep its saved screen. **Start again** runs a fresh process; **Resume** reopens
   a conversation BMN knows, after showing the command it will run.

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
