# Development

## Planned Linux and Windows contribution policy

[Epic 53: Full Windows Support](epic-53-windows-support.md) defines the port and its
acceptance gates. Windows support is planned, not currently verified. During the
port, newly merged features join its parity checklist. Once the epic is accepted,
every feature and fix must work on both Linux and Windows before it is complete.
Use one shared codebase and short pull-request branches; isolate OS differences at
their boundaries. Linux and native Windows CI checks must pass, with affected
manual workflows checked on the relevant machine and WSL checks for WSL changes.
Missing platform evidence stays UNVERIFIED and blocks completion. Documentation-only
changes need documentation checks, not unrelated application tests.

For shared logic and renderer flows, execution in real Electron on native Windows
CI counts as Windows evidence. Changes to OS boundaries or device/desktop behavior
also need the affected flow checked on the supported Windows setup; see the epic's
evidence table. Reuse unchanged passing evidence instead of repeating unrelated
manual checks. The shared parity checklist and pull requests carry collaborative
progress; the maintainer's local BMAD tracker mirrors accepted results.

The implementation team owns development, testing and repair on Linux and Windows.
The Windows collaborator supplies an independent final verification of Windows
quality; this supplements, rather than replaces, the team's Windows checks.
Each pull request names its platform impact and records the checks actually run.

## Prerequisites

- Linux x64. The previously documented setup is Ubuntu 24.04; the owner's current
  machine reports Ubuntu 26.04.1 LTS. Epic 53.1 must record the tested Linux baseline;
  observing the OS upgrade alone does not verify compatibility.
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
| `pnpm run package` | Voice engine, app build and native unpacked output in `apps/desktop/release`; the Windows candidate also builds an unsigned offline installer |
| `pnpm run smoke:packaged [--root FOLDER]` | Start the packaged build (or the one in `FOLDER`) against a temporary data folder and check it |
| `pnpm run install:desktop [-- --pin]` | Install the platform launcher and icons; Linux `--pin` adds it to the GNOME dock, Windows creates a Start menu shortcut |
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
- `BMN_SMOKE_FORCE_FAILURE=1` makes `smoke:packaged` fail at once, for proving what a failed update
  leaves behind; nothing else reads it.
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

If `XDG_RUNTIME_DIR` is unset, the runtime root falls back to `$TMPDIR/bmn-<uid>`, and a very long
`TMPDIR` can push the control socket over the limit named in Troubleshooting.

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

## Windows port development (Story 53.1, not yet accepted)

The target desktop is Windows 11 x64, standard user, without WSL. Install Node
24.14.0, pnpm 12.3.4, Python and Visual Studio 2022 Build Tools with Desktop C++,
the Windows SDK and the matching MSVC Spectre-mitigated libraries required by
node-pty. Run `pnpm install --frozen-lockfile`; postinstall rebuilds node-pty and
better-sqlite3 for pinned Electron 44.3.0. Then run `pnpm run lint`,
`pnpm run typecheck`, `pnpm run test:unit`, `pnpm run build` and
`node scripts/test/platform-startup.mjs`. Keep full test failures in the
[parity inventory](epic-53-parity.md); Windows Server CI and Windows 11 acceptance
are tracked separately there.

`pnpm run package:unpacked` creates the internal `apps/desktop/release/win-unpacked/BMN.exe`.
Run `node scripts/test/platform-startup.mjs --binary apps/desktop/release/win-unpacked/BMN.exe`
and `pnpm exec vitest run scripts/tests/packaged-native-modules.test.mjs` to check
that candidate. Build on the target OS: native ABI filtering uses the host platform.
This remains development output without a full-parity claim. The new packaging
hooks also prepare an unsigned offline installer; its native compilation and
installed behavior are still UNVERIFIED.
Portable voice engines and the native `bmn.exe` launcher are included. Native CI verifies engine speech/silence/transcription and launcher startup/argv/stdin; microphone, hook/resume and complete desktop acceptance remain unfinished.
The existing full Linux `pnpm run package` continues to build voice resources.
Never package over a running packaged app.

The native broker discriminator is `node scripts/test/windows-broker-ownership.mjs`
on a disposable GitHub Actions Windows runner. It uses a synthetic WMI positive
control, an owned ConPTY direct child, and retained process handles before Stop.
A surviving WMI-created child makes the gate fail and leaves strict native process
ownership unresolved; a WMI-only pass does not establish all broker routes. The
fixture bounds its own lifetime and removes its own processes/files. Native
execution of this new discriminator is **UNVERIFIED**.

### Windows installation and queued source updates (candidate)

These routes are implemented in source but have not passed native installed-app
acceptance. Use a disposable Windows account/profile for validation and record the
exact commit and results in the [parity checklist](epic-53-parity.md). The existing
Linux systemd/desktop route is unchanged.

The Windows build includes the native launchers, CLI, voice engines, terminfo,
SQLite/ConPTY modules and offline worker. It includes an ordinary, byte-equal
`BMN-worker.exe` copy, sealed alongside `BMN.exe`. The worker image runs Node code
and refuses GUI startup; the GUI image refuses the installed-worker entry. This
keeps updater workers separate from GUI/utility processes during exit checks. The
extra installed PE size is not yet measured on Windows. Packaging emits
`apps/desktop/release/BMN-<commit>-setup.exe` beside `win-unpacked`. The installer
uses the included Electron runtime; an end user needs neither Node/pnpm/compiler
nor WSL to install and run the native app. The installer makes no network update
check and installs per-user under `%LOCALAPPDATA%\Programs\BMN`.

For contributors with the pinned toolchain:

```powershell
pnpm install --frozen-lockfile
pnpm run build
# Close any packaged BMN before packaging.
pnpm run package
pnpm run install:desktop
```

`install:desktop` validates and smoke-tests the build with temporary profiles,
waits for BMN to exit, selects its versioned payload and creates a Start menu
shortcut. Windows taskbar pinning uses the normal Windows UI. The shortcut's
application identity is `dev.bmn.desktop`; its target and identity are read back.
The new native helper still needs compiler/runtime verification.

After installation, `pnpm run update:desktop` requires a clean `main` matching
`origin/main`. It records that exact commit and the current Node/pnpm locations.
Close BMN, then open the installed Start menu shortcut to resume the queued work.
A start while the selected GUI is running and the queue is waiting forwards to
that instance. During queued work, an owned information window explains the wait;
dismissing it keeps the update running. The notice closes when the work finishes.
The launcher builds a detached Git worktree, validates and smoke-tests the candidate,
checks source identity again immediately before selection, and displays a completion
notice. A reboot or closed terminal retains the request; there is no login task or
service registration. Do not move/remove the source checkout or its Node/pnpm tools
while the request is pending. Uninstall takes the same request lease, sets queued
work aside and removes selection; a waiting worker cannot reinstall from that stale
request. A failed request permits the selected app to open;
rerun `update:desktop` to explicitly retry the same commit. A different unfinished
request needs explicit recovery rather than replacement.

Payloads stay in immutable `versions` directories, selected by `installation.json`.
`update.json` records incomplete activation and metadata repair. A metadata failure
can occur after the new version was selected; the installer reports the actual
selected commit, and retry repairs metadata without repeating migration. Previous
payloads and verified recovery snapshots are retained. Do not launch an old version
directly against current data or automatically restore an old snapshot: that can
discard subsequent changes. Unknown/newer data schemas refuse initialization.
For a runtime ABI change, use the new offline installer; the queued source route
refuses loading native SQLite modules with a mismatched Electron runtime.
The retained bootstrap holds a shared installation lease through selection,
validation and worker creation, then releases it before waiting for the worker.
This fences creation against uninstall without blocking the worker's exclusive
update lease. It resolves the current version, then runs that
version's included runtime and worker. A later source update uses the new runtime
after an offline upgrade; the old bootstrap never loads the new version's native
modules. Invalid selection permits pinned uninstall recovery and refuses source
updates or GUI launch. The manifest/selection format and native lease version are
compatibility contracts for this resolver. Native multi-launcher and runtime-change
acceptance remain UNVERIFIED.


The source request is under `requests/source-update.json` in the installation root.
It records scratch worktree locations for recovery; mapped Windows native DLLs may
delay removal until BMN exits. Inspect that state and the selected commit before
manually repairing a failed update. Keep recovery payloads/snapshots until their
replacement has been verified.

Windows Settings' registered Uninstall action offers data retention by default.
Its optional deletion names the exact data folder and covers **all its contents**,
including files placed there by the user. Project files outside that folder are
preserved. Configuration, the empty lock and the offline recovery runtime remain
for reinstall. A versioned engine currently executing the uninstall also remains
inactive because Windows may keep its executable/DLLs mapped. Other observed live
worker versions are retained for the same reason. The installation
selection is removed, so this retained version cannot open application data. This
does not claim removal of every BMN file. Custom data/config
overrides are separate and are not silently discovered or deleted.

The generated BMN installer and native helpers are unsigned. Hashes in the payload
manifest detect corruption; they do not establish the publisher's identity. Verify
the release commit and installer hash through a trusted maintainer channel. Windows
may display a trust prompt; do not disable Defender, SmartScreen or other security
controls. Signing purchases and public release publication require separate approval.
Native Windows install/upgrade/failure/uninstall/reinstall, kernel leases, shortcut
activation and source-update execution remain UNVERIFIED in this candidate.

Windows persistent defaults are `%LOCALAPPDATA%\BMN\config`, `data`, `state` and
`runtime` (fallback: the account's `AppData\Local\BMN`). All are local to the
account, including config; no roaming database is introduced. Per-root precedence
is `BMN_*_HOME`, then `AITERM_*_HOME`, then the Windows default. XDG variables affect
Linux only. Explicit override values are exact paths, without an appended `bmn`.
Development uses disposable roots unless all four BMN overrides are supplied.

Before writing state, Windows uses the built-in Windows PowerShell to create new roots with
an owner-SID-only protected inheritable directory DACL and validate existing roots
and descendants without changing their ACLs; a failure stops
startup. Only the data root's Chromium network/cache subtrees recognize the exact
pinned sandbox capability ACLs, as described in [Windows storage security](windows-storage-security.md).
Application roots must not alias or overlap the data root. Windows mode bits alone are never considered permission evidence.
Existing roots that do not already have the private BMN ACL, root/ancestor
junctions and unverified links inside stored data are refused. This initial check
is bounded at 10,000 entries and 15 seconds; larger stores remain an open Windows
acceptance boundary, not a full-parity claim.
Native denial from a second standard account and override-path security remain
required acceptance checks. See Microsoft's [DirectorySecurity API](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity?view=netframework-4.8.1).


### Windows 11 acceptance record

Use a standard account on native Windows 11, a clean checkout of the PR candidate,
and the disposable startup scripts above. Do not use an elevated terminal or WSL
as a substitute. Record `git rev-parse HEAD`, `winver`, `$PSVersionTable`,
`node --version`, `pnpm --version`, and whether WSL is installed. Save the command
exit codes and startup JSON receipts alongside the exact CI run link in the PR.
Run both development and unpacked startup: each must verify sandbox settings,
native addon loading, workspace/settings persistence, and second-instance activation.
The visible unavailable local-control status is expected until Story 53.4.

Run `pnpm exec vitest run apps/desktop/src/utility/private-directory.windows.test.ts`
for real private-root creation/restart and unchanged-ACL refusal checks. Additional
security acceptance must exercise a second standard account unable to read/write
synthetic BMN state, rejection of foreign-owned or replaceable paths, junctions,
and bounded wide-directory validation. Use disposable test directories and synthetic
files only; never relax a real profile's permissions to make a check pass. Record
unrun checks as UNVERIFIED. These checks supplement the team's CI; the collaborator's
final full-product check remains separate from Story 53.1's development bootstrap.
