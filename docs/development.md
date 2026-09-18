# Development

## Prerequisites

- Linux x64, or macOS. Development happens on Ubuntu 24.04; macOS is built and tested on Apple
  Silicon.
- Node.js 24 (`engines` allows `>=24 <25`).
- pnpm 12.3.4. `corepack enable` provides the version pinned in `package.json`.
- `node-gyp` on `PATH` (`npm install -g node-gyp`). pnpm compiles `better-sqlite3` with it during
  install; without it the install stops at `node-gyp: command not found`.
- A C/C++ toolchain and Python 3 to rebuild `node-pty` and `better-sqlite3` for Electron:
  `sudo apt install build-essential python3` on Linux, `xcode-select --install` on macOS.
- `cmake` or [uv](https://docs.astral.sh/uv/) for the voice engine.

```bash
pnpm install
```

`postinstall` downloads Electron and rebuilds the native modules against Electron's Node.js ABI.
If a native module later fails to load, run `pnpm run rebuild:native`.

## Ubuntu 24.04 AppArmor

Ubuntu 24.04 restricts unprivileged user namespaces, which Chromium's sandbox needs. Without an
exception, Electron exits at once with `SIGTRAP`, and the kernel log shows
`apparmor="DENIED" operation="capable" profile="unprivileged_userns"`.

BMN never disables the sandbox. Instead, `scripts/sandbox/bmn-electron` is an
AppArmor profile that grants user namespaces to exactly two binaries in your checkout: the
development Electron and the packaged `bmn`. Install it with your checkout's absolute path:

```bash
sed "s|@REPO_ROOT@|$PWD|g" scripts/sandbox/bmn-electron \
  | sudo tee /etc/apparmor.d/bmn-electron >/dev/null
sudo apparmor_parser -r /etc/apparmor.d/bmn-electron
```

Run it from the repository root. The profile is tied to those paths; if you move the checkout,
install it again.

## Commands

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm --filter @bmn/desktop run dev` | Development app with hot reload, in a throwaway data folder |
| `pnpm run build` | Build the protocol package and the app into `apps/desktop/out` |
| `pnpm run lint` | ESLint over `apps`, `shared` and `scripts` |
| `pnpm run typecheck` | TypeScript project build of the protocol, main/preload and renderer |
| `pnpm run test:unit` | Vitest unit and integration tests |
| `pnpm run test:electron` | Build, then start the real Electron app in self-test mode |
| `pnpm run test:run` | Unit tests, then the Electron self-test |
| `pnpm run voice:build` | Build the pinned whisper.cpp engine (`node scripts/voice/build-whisper.mjs --force` rebuilds) |
| `pnpm run package` | Voice engine, app build and an unpacked build for this platform in `apps/desktop/release` |
| `pnpm run smoke:packaged` | Start the packaged build against a temporary data folder and check it |
| `pnpm run install:desktop [-- --pin]` | Linux: install the launcher and icons, `--pin` adds it to the GNOME dock. macOS: copy `BMN.app` into `~/Applications` |

`make test`, `make lint`, `make typecheck` and `make build` wrap the same commands.

### Notes on the tests

- `scripts/tests/packaged-native-modules.test.mjs` inspects the packaged build. It is skipped until
  `pnpm run package` has produced one, and it checks the native binaries for the platform you are
  on: `scripts/lib/packaged-app.mjs` is the single place that knows where a packaged build lands.
- The Electron self-test and the packaged smoke test run with temporary `XDG_*` folders. Your real
  BMN data is not touched.
- Close a running BMN before `pnpm run package`, since packaging replaces the binary it
  runs from.
- `scripts/lib/sandbox-flag-audit.mjs` fails the tests if a flag that disables Chromium's sandbox
  appears anywhere in `apps`, `shared` or `scripts`.

## Data folders

The app resolves its folders from the XDG variables, and each can be overridden directly:

| Variable | Default |
| --- | --- |
| `BMN_CONFIG_HOME` | `$XDG_CONFIG_HOME/bmn` (`~/.config/bmn`) |
| `BMN_DATA_HOME` | `$XDG_DATA_HOME/bmn` (`~/.local/share/bmn`) |
| `BMN_STATE_HOME` | `$XDG_STATE_HOME/bmn` (`~/.local/state/bmn`) |
| `BMN_RUNTIME_HOME` | `$XDG_RUNTIME_DIR/bmn` |

macOS sets no `XDG_RUNTIME_DIR`, so the runtime root falls back to `$TMPDIR/bmn-<uid>`.
That path is already about 80 bytes, so a longer `TMPDIR` can push the control socket over the
limit below.

The development launcher (`scripts/test/electron-dev.mjs`) points all of them at a new temporary
folder and removes it on exit.

## Code map

See [architecture.md](architecture.md) for processes and rules. Useful entry points:

| Area | File |
| --- | --- |
| App startup, windows, quit | `apps/desktop/src/main/index.ts`, `app-lifecycle.ts` |
| Process tracking for Quit and Close | `apps/desktop/src/main/process-tracking.ts` |
| Voice engine | `apps/desktop/src/main/voice-engine.ts`, `voice-ipc.ts` |
| Renderer shell | `apps/desktop/src/renderer/src/main.tsx` |
| Terminal view | `apps/desktop/src/renderer/src/session-terminal.tsx`, `terminal-view.ts` |
| Hold Space to talk | `apps/desktop/src/renderer/src/space-hold.ts` |
| PTY sessions | `apps/desktop/src/utility/session-manager.ts` |
| Files, requests, control socket, Telegram, backups | `apps/desktop/src/utility/companion-service.ts` |
| Database | `apps/desktop/src/utility/database-*.ts` |
| Shared message types | `shared/protocol/src` |

## Troubleshooting

- **Electron exits with `SIGTRAP`.** Install the AppArmor profile above. It must name the path of
  this checkout.
- **`node-pty` or `better-sqlite3` fails to load.** Run `pnpm run rebuild:native`. The app's error
  names the module that failed.
- **Agent control is unavailable.** A Unix socket path may hold 107 bytes on Linux and 103 on
  macOS. A very long `XDG_RUNTIME_DIR`, `TMPDIR` or `BMN_RUNTIME_HOME` disables the control
  socket, and Preferences shows why.
- **The voice engine build fails.** Install `cmake` (or uv) and run `node scripts/voice/build-whisper.mjs --force`.

## Known limitations

- Linux x64 and macOS; the package target is an unpacked folder, not a `.deb`, AppImage or `.dmg`.
- The macOS build is ad-hoc signed for the computer that built it, so it is not distributable.
- The shortcuts use `Ctrl` on macOS as well as on Linux, so that `Cmd` stays free for macOS itself.
- Output written after the last saved snapshot can be lost if the app or window crashes; the app
  says so when it recovers.
- Start again runs a fresh process; use Resume to reopen a Claude Code or Codex conversation.
- A model placed by hand in a custom Model folder is accepted by size without a checksum check.
