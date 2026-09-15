# AI Terminal

A desktop terminal for working with coding agents on Linux. It runs your shells and your installed
agent CLIs (Claude Code, Codex, or any other command) in real terminals, keeps them organized in
workspaces, and gives the agents a small local API for sharing files, reporting progress and asking
for your attention.

Everything runs on your computer. There is no account, cloud backend or telemetry.

> Status: early and personal. It is built and used on Ubuntu 24.04 (x64). Other Linux distributions
> may work; macOS and Windows are not supported.

## What it does

- **Workspaces and sessions.** Named workspaces hold independent sessions. A session is a shell,
  Claude Code, Codex, or any command, with its own working directory. Launch templates, rename,
  archive and edit launch settings. Layout, order and selection survive a restart, but nothing
  starts automatically.
- **Real terminals.** Each session is a real PTY rendered by one live [xterm.js](https://xtermjs.org/)
  view. There is no tmux layer and no replayed output, so key encodings, colors, bell and OSC
  notifications reach the program unchanged. Your CLIs keep their own configuration,
  authentication, hooks and permissions.
- **Process control.** Stop a process and keep its last screen as saved output. Start it again, or
  resume the stored Claude Code / Codex conversation through the CLI's own resume.
  Closing the window with sessions running asks whether to keep them running or stop them.
- **Agent control (`aiterm`).** Every session gets the `aiterm` command. An agent can list sessions,
  publish a file, report progress, ask you a question, or send text to its own session. Each session
  gets a token scoped to that session. See [docs/agent-control.md](docs/agent-control.md).
- **Files.** Published files, attachments and pasted images are stored as immutable originals with
  a hash. The Files panel previews them and offers Open, Save As, Show in Folder and Deliver to
  session.
- **Needs you.** Agent questions stay open until you answer them or the agent withdraws them. A
  header count and `Ctrl+Shift+U` take you to the next one.
- **Local voice dictation.** Hold Space in any terminal to talk; release to paste the text into
  the session, without pressing Enter. Transcription runs on your CPU with
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves the computer. See
  [docs/voice.md](docs/voice.md).
- **Optional Telegram.** Connect your own bot to get a message when a session needs you, and reply
  to that message to answer the session. See [docs/telegram.md](docs/telegram.md).
- **Backups.** Export a consistent snapshot of the database and stored files with a hash
  manifest, and verify it later.
- **Appearance.** Four color palettes for the app and the terminal: Steel (default), Brown, Dark and
  near-black Black, plus a Knight or Cross header.
- **Keyboard first.** `Ctrl+Shift+P` opens the command palette, and every action is reachable
  from the keyboard.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Search in the terminal output |
| `Ctrl+Shift+Enter` | Split the view |
| `Ctrl+Shift+Z` | Focus mode |
| `Ctrl+Shift+↑` / `↓` | Previous / next session |
| `Ctrl+Shift+←` / `→` | Previous / next workspace |
| `Ctrl+Shift+U` | Next open request from an agent |
| `Ctrl+Shift+C` / `V` | Copy / paste |
| `Ctrl+Shift+\` | Send the next key straight to the terminal |
| Hold `Space`, or `Ctrl+Shift+Space` | Dictate |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Font size |

## Install from source

Requirements:

- Linux x64 (tested on Ubuntu 24.04)
- Node.js 24 and pnpm 12.3.4 (`corepack enable` picks the pinned pnpm)
- A C/C++ toolchain and Python 3 for the native modules (`sudo apt install build-essential python3`)
- `cmake`, or [uv](https://docs.astral.sh/uv/), to build the voice engine

```bash
git clone https://github.com/forever-Agriculture/AI-Terminal.git
cd AI-Terminal
pnpm install
pnpm run package                       # builds whisper.cpp, the app and a Linux folder build
apps/desktop/release/linux-unpacked/ai-terminal
```

Add a launcher and icon to your desktop (optionally pinned to the GNOME dock):

```bash
pnpm run install:desktop -- --pin
```

On Ubuntu 24.04 and later, AppArmor blocks the user namespaces that Chromium's sandbox needs. If
the app exits immediately with `SIGTRAP`, install the AppArmor profile described in
[docs/development.md](docs/development.md#ubuntu-2404-apparmor). The app never turns the sandbox off.

To try it without touching your real data, run the development build. It uses a throwaway
temporary folder:

```bash
pnpm --filter @ai-terminal/desktop run dev
```

## Where data lives

| What | Where |
| --- | --- |
| Settings, bot token | `~/.config/ai-terminal/` |
| Database, stored files, voice models | `~/.local/share/ai-terminal/` |
| Saved output, file staging | `~/.local/state/ai-terminal/` |
| Control socket | `$XDG_RUNTIME_DIR/ai-terminal/control/` |

The `XDG_*` variables are respected. Folders are created owner-only.

## Documentation

- [Architecture](docs/architecture.md): processes, data flow and the rules they follow
- [Agent control](docs/agent-control.md): the `aiterm` command and its local API
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

[MIT](LICENSE). whisper.cpp is MIT-licensed; its license is copied next to the built engine.
