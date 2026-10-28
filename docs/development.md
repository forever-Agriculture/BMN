# MODULE: development.md - Build, check, package and maintain the BMN source tree
# Development

## Prerequisites

- Linux x64. Development happens on Ubuntu 24.04.
- Node.js 24 (`engines` allows `>=24 <25`).
- pnpm 12.3.4. `corepack enable` provides the version pinned in `package.json`.
- `node-gyp` on `PATH` (`npm install -g node-gyp`). pnpm compiles `better-sqlite3` with it during
  install; without it the install stops at `node-gyp: command not found`.
- A C/C++ toolchain and Python 3 to rebuild `node-pty` and `better-sqlite3` for Electron:
  `sudo apt install build-essential python3`.
- `cmake` or [uv](https://docs.astral.sh/uv/) for the voice engine.

```bash
pnpm install
```

`postinstall` downloads Electron and rebuilds the native modules against Electron's Node.js ABI.
If a native module later fails to load, run `pnpm run rebuild:native`.

Fresh releases wait three days: `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (minutes), so
pnpm refuses a package version published less than three days ago. To let one urgent security fix
through, add it to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` as `name@version` with a dated
comment, and remove the entry once the version is three days old.

## Ubuntu 24.04 AppArmor

Ubuntu 24.04 restricts unprivileged user namespaces, which Chromium's sandbox needs. Without an
exception, Electron exits at once with `SIGTRAP`, and the kernel log shows
`apparmor="DENIED" operation="capable" profile="unprivileged_userns"`.

BMN never disables the sandbox. Instead, `scripts/sandbox/bmn-electron` is an
AppArmor profile that grants user namespaces to the development Electron, the live packaged
`bmn`, and the staged `.next/bmn` used by desktop updates. Install it with your checkout's
absolute path:

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
| `pnpm run test:electron` | Build, run the real Electron app in self-test mode, then check that a normal start loads no self-test code |
| `pnpm run test:run` | Unit tests, then the Electron self-test |
| `pnpm run voice:build` | Build the pinned whisper.cpp engine (`node scripts/voice/build-whisper.mjs --force` rebuilds) |
| `pnpm run package` | Voice engine, app build and an unpacked Linux build in `apps/desktop/release` |
| `pnpm run smoke:packaged [--root FOLDER]` | Start the packaged build (or the one in `FOLDER`) against a temporary data folder and check it |
| `node scripts/measure/bmn-cpu.mjs --out FILE [--minutes 30]` | BMN's own CPU per process type (main, window, GPU, utilities), read-only from `/proc` and BMN's database; a session's terminal is left out, its BMN CLI and hooks are a line of their own; a gap over 10 s or a restart makes it invalid |
| `node scripts/measure/calibration-load.mjs --out FILE [--sessions claude=3,codex=1,shell=1] [--scale N] [--isolation-receipt FILE]` | This checkout's build (after `pnpm run build`) in temporary folders, its home included, its sessions replaying agent-like output with their mirrors on, measured by the CPU script with no debugger attached. It first runs the isolation probe (next row) and refuses to start unless it passes, or reuses a passing receipt for the same builder and build |
| `node scripts/measure/calibration-environment.mjs --prove [--out RECEIPT.json]` | Story 96.4's isolation probe: a synthetic outside home with an approved sentinel team and tries file stands for yours, a separate approved synthetic team sits in the disposable home, and the build starts through the calibration's own launcher under `strace -f -e trace=%file` with a stand-in `codex --version` so BMN's own tests write their tries file. PASS only when that write lands in the disposable home, the trace names nothing in the outside home and its fingerprints are unchanged. Chromium is started with `--password-store=basic`, off the desktop keyring; the trace covers file calls only, so D-Bus (notifications) stays your session's |
| `node scripts/audit/consumers.mjs [--json] [--exclude PATH]... TERM...` | Every place that may still use a name or a file before it is called dead: BMN's files and plan, dev-auto, the installed skills, names built from strings, packaging, each hit's blame and the term's Git history, and for a file the imports of a variable or template to read; exit 1 when a term has a hit |
| `pnpm run install:desktop [-- --pin]` | Install the launcher and icons, `--pin` adds it to the GNOME dock |
| `pnpm run update:desktop` | Queue a clean pushed `main` build; wait for BMN to exit, package into `linux-unpacked.next`, smoke-test it, swap it into `linux-unpacked` (the replaced build stays as `linux-unpacked.prev` until the next update), install and notify. A failed check leaves the live build as it was; a desktop start during the update waits for it |

`make test`, `make lint`, `make typecheck` and `make build` wrap the same commands.

### Notes on the tests

- `scripts/tests/packaged-native-modules.test.mjs` inspects the packaged build. It is skipped until
  `pnpm run package` has produced one, and it checks the native binaries for the platform you are
  on: `scripts/lib/packaged-app.mjs` is the single place that knows where a packaged build lands.
- The Electron self-test and the packaged smoke test run with temporary `XDG_*` folders. Your real
  BMN data is not touched.
- Close a running BMN before `pnpm run package`, since packaging replaces the binary it
  runs from. `update:desktop` packages beside it instead and swaps only after BMN has exited.
- "Every test passes" means on a quiet machine: no load loops and no other test run (another
  checkout's vitest or pytest). Timing runs use a stated load instead: one Node busy loop per two
  logical cores (`node -e 'for (;;) {}'`) while `vitest run --maxWorkers=50% --sequence.shuffle`
  runs the tests. A test with a wall-clock limit says beside the limit what real-time property it
  guards. A timing test kept on purpose that fails only under that load is listed in
  `plan/references/091/kept-on-purpose.md` (planning, not committed here) with its pass counts; it
  is not a gate failure.
- `BMN_SMOKE_FORCE_FAILURE=1` makes `smoke:packaged` fail at once, for proving what a failed update
  leaves behind; nothing else reads it.
- `scripts/lib/sandbox-flag-audit.mjs` fails the tests if a flag that disables Chromium's sandbox
  appears anywhere in `apps`, `shared` or `scripts`.
- The unit suite rejects native selects and source files over 2,000 lines through
  `scripts/lib/source-guards.mjs`. Its allowlist explains the four files kept whole. Tests and
  standalone harnesses are excluded; the bundled self-test is explicitly listed. The retired-name
  check in `scripts/lib/retired-references.mjs` keeps its own classified allowlist.
- `pnpm run test:visual [-- --out DIR]` builds the app, checks its screens on a fixed made-up fixture
  (one folder, window sizes, themes, system fonts, a page clock that starts at 2026-01-01, a
  settled screen) and keeps the screenshots as one set under its commit:
  `.dev-auto/evidence/visual/<short commit>`, with `-dirty` for uncommitted changes, or `DIR`. A
  folder that already holds a set is refused. A "before" set comes from the preceding revision's
  own build: check that commit out in another worktree, run its `pnpm install` and
  `pnpm run test:visual -- --out DIR` there, never restyling the current build. In a worktree, add
  `--electron` with the main checkout's Electron, the one the AppArmor profile above allows.

### Turn Changes handshake diagnostics

The `real hook diagnostic` cases in `turn-changes-host.test.ts` join the actual hook CLI,
private control socket, CompanionService, recorder and capture engine. They use a synthetic
foreground identity and `/proc` fixture, private homes and a small real Git repository.
The integration selection used for the three-revision diagnosis is:

```bash
node node_modules/vitest/vitest.mjs run apps/desktop/src/utility/turn-changes-host.test.ts \
  -t 'real hook diagnostic' --pool=threads --maxWorkers=1 --no-file-parallelism --bail=1 \
  --exclude '.dev-auto/**' --exclude '.claude/**'
```

The recorded comparisons also wrapped Node with a run-owned launch recorder and syscall
tracing. Set `BMN_TURN_DIAGNOSTIC_DIR` to a private output directory to retain each case's
synthetic stage/status record, source hashes, stored turn and cleanup result.

The four cases cover timely confirmation, capture expiry, connection loss during publication
and an immediately refused capture. Explicit reached/release barriers control the negative
cases; the production 300 ms deadline remains unchanged. Every hook must exit quietly and
forward its ordinary event. Only timely confirmation keeps the before snapshot and yields
one file with two added lines; the other cases keep honest missing-before output and discard
unconfirmed staging. The stand-in's unread version keeps the ordering caveat and labels.

These checks exercise the subprocess/socket/capture boundary. They do not establish the cause
of an earlier packaged failure or packaged baseline parity, and do not launch Electron or a
real agent. A quiet hook exit alone does not establish successful snapshot publication.

## Terminal image resizing

The renderer pins xterm.js 6.0.0 and image addon 0.9.0. The maintained addon patch
uses a synchronized canvas context and admits stored images, font rescaling and pending
image allocations before creating their surfaces. Each view has at most 16 MB of image
payload; active views share 128 MB, including the renderer's image smoke check.

`terminal-image-resize.ts` preserves the displayed text and image together before
FitAddon clears the old grid. Repeated resizes keep the first scene, scaling it into the
new bounds until a complete update arrives. Its one-second hold extends only while a
synchronized update is open, ending on completion or xterm's watchdog. New-grid image
tiles can extend past the right edge only while their last visible cell still identifies
that image and the resize deadline has not expired. During the hold, mouse reports and
selection use the current VT grid and live buffer; copied text can differ from the held
scene. Current-scene overflow compensates for display scaling. Teardown retires the image
layer before releasing its allocation.

Additional output payload is measured against the unmodified addon's canvas at matching
dimensions and resize stages. Reservations cover both dimension setters and their old/new
overlap; a failed setter retains its reservation until the layer is retired. The budget
covers application-controlled payloads. Chromium's private GPU allocations and literal
every-display-frame timing remain **UNVERIFIED**. Resize acceptance compares complete
images and displayed text on every recorded native frame; Electron's subscriber is capped
at 30 fps.

## Data folders

The app resolves its folders from the XDG variables, and each can be overridden directly:

| Variable | Default |
| --- | --- |
| `BMN_CONFIG_HOME` | `$XDG_CONFIG_HOME/bmn` (`~/.config/bmn`) |
| `BMN_DATA_HOME` | `$XDG_DATA_HOME/bmn` (`~/.local/share/bmn`) |
| `BMN_STATE_HOME` | `$XDG_STATE_HOME/bmn` (`~/.local/state/bmn`) |
| `BMN_RUNTIME_HOME` | `$XDG_RUNTIME_DIR/bmn` |

If `XDG_RUNTIME_DIR` is unset, the runtime root falls back to `$TMPDIR/bmn-<uid>`, and a very long
`TMPDIR` can push the control socket over the limit named in Troubleshooting.

The development launcher (`scripts/test/electron-dev.mjs`) points BMN's four `BMN_*_HOME` roots
at a new temporary folder and removes it on exit. It preserves the inherited `XDG_*` paths for
agent apps, so a Claude Code update cannot put its shared launcher in a folder deleted on exit.

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
| Self-test (loaded only under `--self-test`) | `apps/desktop/src/main/self-test/`, `apps/desktop/src/renderer/src/self-test/` |
| Shared message types | `shared/protocol/src` |
| Header identities and sigils | `apps/desktop/src/renderer/src/theme.ts`, `icons.tsx` |

### Parked sigils

The Boss identity shipped on 2026-09-20 with a trophy and *Veni, Vidi, Vici*. These drafts were the
runner-up for a corporate Boss and are kept for a future identity or a swap. Each is a 16×16 `d`
string for the stroke icon set in `icons.tsx` (stroke 1.4, round caps, no fill):

- Classic tie: `M6.2 2.5h3.6l-.9 2.5 1.9 7.3L8 14.5l-2.8-2.2 1.9-7.3zM7.1 5h1.8`
- Tie with tie bar: `M6.2 2.5h3.6l-.9 2.5 1.9 7.3L8 14.5l-2.8-2.2 1.9-7.3zM7.1 5h1.8M5.6 9.3h4.8`
- Windsor, wider knot (Astra's pick): `M5.8 2h4.4l-.9 3 1.7 7.5L8 14.5l-3-2L6.7 5zM6.7 5h2.6`
- Gavel with block, for an "owner's judgement" theme: `M8.7 4.4 6.6 2.3 2.3 6.6l2.1 2.1zM7.1 7.1l4.2 4.2M8 13h5.5v1.8H8z`

## Troubleshooting

- **Electron exits with `SIGTRAP`.** Install the AppArmor profile above. It must name the path of
  this checkout and include `.next/bmn` for staged desktop updates.
- **`node-pty` or `better-sqlite3` fails to load.** Run `pnpm run rebuild:native`. The app's error
  names the module that failed.
- **Agent control is unavailable.** A Unix socket path may hold 107 bytes on Linux. A very long
  `XDG_RUNTIME_DIR`, `TMPDIR` or `BMN_RUNTIME_HOME` disables the control socket, and Preferences
  shows why.
- **The voice engine build fails.** Install `cmake` (or uv) and run `node scripts/voice/build-whisper.mjs --force`.

## Known limitations

- Linux x64 only; the package target is an unpacked folder, not a `.deb` or AppImage.
- Output written after the last saved snapshot can be lost if the app or window crashes; the app
  says so when it recovers.
- Start again runs a fresh process; use Resume to reopen a Claude Code or Codex conversation.
- A model placed by hand in a custom Model folder is accepted by size without a checksum check.
