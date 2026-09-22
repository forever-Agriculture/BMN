# BMN

*Be a man: use a proper terminal.*

A desktop terminal for working with coding agents on Linux and macOS. It runs your shells and your
installed agent CLIs (Claude Code, Codex, or any other command) in real terminals, keeps them
organized in workspaces, and gives the agents a small local API for sharing files, reporting
progress and asking for your attention.

Everything runs on your computer. There is no account, cloud backend or telemetry.

> Status: early and personal. It is built and used on Ubuntu 24.04 (x64), and builds and runs on
> macOS (Apple Silicon). Other Linux distributions may work; Windows is not supported.

## What it does

- **Workspaces and sessions.** Named workspaces hold independent sessions. A session is a shell,
  Claude Code, Codex, OpenCode, or any command, with its own working directory. Launch templates, rename,
  archive and edit launch settings. Layout, order and selection survive a restart, but nothing
  starts automatically; after an update or a quit, BMN offers to resume what the stop interrupted,
  in one dialog that shows each command and starts nothing until you press the button.
- **Real terminals.** Each session is a real PTY rendered by one live [xterm.js](https://xtermjs.org/)
  view. There is no tmux layer and no replayed output, so key encodings, colors, bell and OSC
  notifications reach the program unchanged. Your CLIs keep their own configuration,
  authentication, hooks and permissions.
- **Process control.** Stop a process and keep its last screen as saved output. Start it again, or
  resume the stored Claude Code / Codex / OpenCode conversation through the CLI's own resume.
  Closing the window with sessions running asks whether to keep them running or stop them.
  [What survives](docs/architecture.md#what-survives) says what each ending keeps.
- **Agent control (`bmn`).** Every session gets the `bmn` command. An agent can list sessions,
  publish a file, report progress, ask you a question, prepare an owner-delivered handoff, or send text to its own session. Each session
  gets a token scoped to that session. `bmn hooks check` says which of BMN's hook entries each
  harness's own settings file carries, and `bmn hooks install <agent>` adds the missing ones without
  touching anything else. See [docs/agent-control.md](docs/agent-control.md).
- **Files.** Published files, attachments and pasted images are stored as immutable originals with
  a hash. The Files panel previews them and offers Open, Save As, Show in Folder and Deliver to
  session.
- **File references.** `Ctrl+click` a path an agent printed, such as `src/parser.ts:42:7`, or use
  **Open file reference…** in the palette, to see a read-only snapshot of that file at the line, with
  Copy reference and Show in Folder. Relative paths resolve from the session's launch directory, which
  the preview names; you can pick another folder for one opening. Nothing is edited, run or stored.
- **Needs you.** Agent questions stay open until you answer them or the agent withdraws them. A
  header count and `Ctrl+Shift+U` take you to the next one.
- **Local voice dictation.** Hold Space in any terminal to talk; release to paste the text into
  the session, without pressing Enter. Transcription runs on your CPU with
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves the computer. Approve
  suggested project names and identifiers once, and Whisper gets them as a hint. See
  [docs/voice.md](docs/voice.md).
- **Optional Telegram.** Connect your own bot to get a message when a session needs you, and reply
  to that message to answer the session. See [docs/telegram.md](docs/telegram.md).
- **Backups.** Export a consistent snapshot of the database and stored files with a hash
  manifest, and verify it later.
- **Appearance.** Four color palettes for the app and the terminal: near-black Black (default), Steel,
  Brown and Dark, plus a Knight, Cross or Boss header.
- **Keyboard first.** `Ctrl+Shift+P` opens the command palette, and every action is reachable
  from the keyboard.

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
use **Open file reference…** in the palette instead. Send a literal `Ctrl+V` with `Ctrl+Shift+\` first. The shortcuts are
the same on macOS: they use `Ctrl`, not `Cmd`, so the keys a terminal program expects reach it.

## Install from source

Requirements everywhere:

- Node.js 24 and pnpm 12.3.4 (`corepack enable` picks the pinned pnpm)
- `node-gyp` on your `PATH` (`npm install -g node-gyp`); pnpm builds the native modules with it
- `cmake`, or [uv](https://docs.astral.sh/uv/), to build the voice engine

On Linux (x64, tested on Ubuntu 24.04), also install a C/C++ toolchain and Python 3:
`sudo apt install build-essential python3`.

On macOS, the C/C++ toolchain and Python 3 come from the Xcode command line tools:
`xcode-select --install`.

```bash
git clone https://github.com/forever-Agriculture/BMN.git
cd BMN
pnpm install
pnpm run package    # builds whisper.cpp, the app and a folder build for this computer
```

`pnpm run package` writes the build under `apps/desktop/release/`. Start it, and install it where
your desktop looks for applications:

```bash
# Linux
apps/desktop/release/linux-unpacked/bmn
pnpm run install:desktop -- --pin     # launcher and icons; --pin adds it to the GNOME dock
pnpm run update:desktop               # later: wait for BMN to close, then rebuild and install

# macOS
open apps/desktop/release/mac-arm64/BMN.app
pnpm run install:desktop              # copies BMN.app into ~/Applications
```

On Ubuntu 24.04 and later, AppArmor blocks the user namespaces that Chromium's sandbox needs. If
the app exits immediately with `SIGTRAP`, install the AppArmor profile described in
[docs/development.md](docs/development.md#ubuntu-2404-apparmor). The app never turns the sandbox off.

To try it without touching your real data, run the development build. It uses a throwaway
temporary folder:

```bash
pnpm --filter @bmn/desktop run dev
```

## Where data lives

| What | Where |
| --- | --- |
| Settings, bot token | `~/.config/bmn/` |
| Database, stored files, voice models | `~/.local/share/bmn/` |
| Saved output, file staging | `~/.local/state/bmn/` |
| Control socket | `$XDG_RUNTIME_DIR/bmn/control/` |

The `XDG_*` variables are respected. Folders are created owner-only. macOS sets no
`XDG_RUNTIME_DIR`, so the control socket goes under the per-user temporary folder instead; the
other three folders are the same as on Linux. Existing installations continue using legacy
`ai-terminal` config, data and state folders when those already exist; BMN leaves them in place
rather than risking an automatic move.

## Documentation

- [Architecture](docs/architecture.md): processes, data flow and the rules they follow
- [Agent control](docs/agent-control.md): the `bmn` command and its local API
- [Voice dictation](docs/voice.md): engine, models, speed and privacy
- [Telegram](docs/telegram.md): connecting your own bot
- [Development](docs/development.md): building, testing, packaging and troubleshooting

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
