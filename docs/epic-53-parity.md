# Epic 53 parity and evidence

The Windows product must be as good as Linux in capability, reliability, security
and usability. The implementation team owns tests and repairs on both systems.
The Windows collaborator independently verifies final quality. Native Windows and
WSL are separate evidence columns; Linux tests or cross-compilation cannot fill them.

Baseline: `e20a21d93593512a7acc8d181acb33a3e2acf03c`. This includes the latest
Telegram delivery diagnostics as well as the Epic 54/55 source changes. Existing
Epic 50/54 installed/provider acceptance remains separate and unfinished.

| Capability / owning story | Implementation owner | Linux candidate | Native Windows | WSL |
| --- | --- | --- | --- | --- |
| Build, data roots, database, restart, single instance, unpacked startup — 53.1 | Implementation team | Build/startup/package PASS on Ubuntu CI | Install/build/package/startup/restart/ACL PASS on Server 2025; Windows 11 manual acceptance UNVERIFIED | UNVERIFIED |
| PowerShell/cmd launch, input, stop, process identity, crash cleanup, ConPTY feasibility — 53.2 | Implementation team | Affected tests and sandboxed startup PASS | Bundled bytes/trees/GUI/pressure, shell/UI and direct/debugger main-job crash cleanup PASS; twelve lifecycle observations including final Close/relaunch PASS; full story acceptance remains open | UNVERIFIED |
| Files, path links, attachments, backups, directory permissions — 53.3 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| CLI, transport, caller/session authority — 53.4 | Implementation team | 178 server/498 CLI affected checks PASS on 629dc91 | Native bmn.exe startup/argv/stdin and restricted control pipe owner/cross-account denial PASS; hook/config acceptance remains open | UNVERIFIED |
| Named distributions, bridge, path mapping, terminfo — 53.5 | Implementation team | Restricted prototype and separate-UID alias fence measured; full profile UNVERIFIED | Disposable WSL2 VM boot/cleanup PASS | Root-helper six cleanup modes and broker/UID/ABI controls PASS on WSL2; full capability profile and bridge unfinished |
| Claude/Codex/OpenCode/Cursor hooks, history, usage, compaction, resume — 53.6 | Implementation team | Hook/config fixtures: 68 passed, one native-only skip; retained history/Companion: 204 passed, replacement and hardlink regressions original RED/current GREEN | Latest native failures remain open; revised ACL/home/history fixtures UNVERIFIED | UNVERIFIED |
| Terminal images, clipboard, IME/AltGr, scaling, panes, themes, keyboard access — 53.7 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Microphone, local voice engine, cancellation, addressed paste — 53.8 | Implementation team | Portable speech/silence/transcription PASS | Portable/packaged engines and PE imports PASS; prior WAV ACL PASS, latest private-WAV inspector fails without OS cause (diagnostic pending); microphone/UI/other CPU UNVERIFIED | UNVERIFIED |
| Notifications, attention, Telegram replies and delivery diagnostics — 53.9 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Per-session development port discovery and navigation — 53.10 | Implementation team | 498 affected tests PASS, one skip; scanner timeout original RED/current GREEN | Owned-job TCP scanner implemented and focused-reviewed; owned Edge IPv4/IPv6 navigation gate prepared; MSVC/runtime/UI/browser UNVERIFIED | UNVERIFIED |
| Per-user install, source updates, rollback, uninstall — 53.11 | Implementation team | Affected source tests/type/bundle PASS; Linux development startup PASS | Offline installer, versioned transaction, leases, snapshot, queue and uninstall implemented in source; native compiler/kernel/install acceptance UNVERIFIED | UNVERIFIED |
| Full CI, required merge gates, contributor rules — 53.12 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Full feature-guide reconciliation and installed-app acceptance — 53.13 | Team + independent Windows verifier | 71-scenario coverage draft; installed acceptance UNVERIFIED | Final integration/installed acceptance UNVERIFIED | Final integration/installed acceptance UNVERIFIED |

## Story 53.1 checks

`.github/workflows/platform-build.yml` runs pinned install/rebuild, lint, typecheck,
the full unit/integration inventory, build and real Electron startup on Linux and
native Windows. Windows additionally builds and starts the internal unpacked app.
The full unit suite remains a failing gate until every platform failure is resolved;
it is not skipped on Windows. Native runner results are recorded below.

`scripts/test/platform-startup.mjs` checks the sandboxed UI, workspace and settings
persistence after restart, and second-launch activation with synthetic isolated data.
It intentionally creates no terminal; PTY feature and lifecycle proof belongs to
53.2. SQLite is exercised through the application's worker. Loading node-pty at
startup alone does not establish a functioning Windows PTY.

Evidence artifacts must name the exact candidate commit, OS, shell, Node, pnpm,
Electron and WSL distribution versions. CI uploads `platform-evidence-<os>` with
its environment and full unit JSON plus startup receipts. Add the accessible run
URL here after execution; local evidence is not a substitute for shared evidence.

Observed local environment: Ubuntu 26.04.1 LTS, Linux 7.0.0-34-generic x64,
Node 24.14.0, pnpm 12.3.4, Electron pin 44.3.0. This is an environment observation;
check results are recorded separately. CI's Ubuntu 24.04 and Windows Server 2025
runners do not replace final Windows 11 standard-user/device checks.

## Unit/integration fixture ownership

After each native Windows inventory run, attach its raw `unit.json`, assign each
failure below, and retain every unassigned failure under 53.1 until triaged.
No failing file has been silently declared portable or waived.

| Failure boundary | Owning story |
| --- | --- |
| Build/native loading/roots/startup or unclassified failure | 53.1 |
| Bash launch, POSIX signals, `/proc` process identity, PTY lifecycle | 53.2 |
| POSIX permissions, symlink/junction behavior, paths, file operations | 53.3 |
| Unix sockets, CLI/shebang/launcher behavior | 53.4 |
| WSL environment/bridge/distribution mapping | 53.5 |
| Agent configuration/history/hook executables | 53.6 |
| Terminal/clipboard/scaling/input | 53.7 |
| whisper, microphone, voice binaries | 53.8 |
| Notifications/Telegram | 53.9 |
| `/proc` port scanning and process attribution | 53.10 |
| systemd, desktop entries, packaging/install/update | 53.11 |

The [feature coverage checklist](epic-53-feature-coverage.md) expands these rows
into 71 scenarios against the current feature guide, README and merged Epic 50–55
contracts. Each names its owning story and a test or measurement starting point.
Installed-flow results remain UNVERIFIED; reconcile newly merged features again
against the final integration commit before acceptance.

## Current local evidence (not acceptance)

The Ubuntu 26.04.1 candidate passed typecheck, lint and build. The broad unit run
passed 2,825 tests with one packaging-command assertion failure; the corrected
assertion and affected script/root tests subsequently passed. The new platform
startup smoke passed with `chromiumSandbox: true`, native addon loading, isolated
workspace/settings persistence and second-instance activation. The existing Linux
Electron self-test passed (79 receipt fields, graceful shutdown). Local receipts
are retained in the run's ignored `.dev-auto/evidence/`; shareable CI receipts and
the candidate native Windows checks and Windows 11 acceptance remain required.

The first startup probe used Playwright's sandbox-disabling default and does not
count as sandbox evidence. The corrected probe explicitly enables Chromium's
sandbox and rejects disabling launch arguments. Older unrelated Playwright fixtures
also require a separate sandbox audit; their prior sandbox claims are not adopted
as this port's acceptance evidence.

## Native CI evidence

[Initial run 37057811322](https://github.com/forever-Agriculture/BMN/actions/runs/37057811322)
tested `7bfa647` on Ubuntu 24.04 x64 and Windows Server 2025 Datacenter x64,
with Node 24.14.0, pnpm 12.3.4 and Electron 44.3.0. Linux passed the full
inventory, build, sandboxed startup, package and packaged smoke. Windows passed
installation/native rebuild, lint, typecheck, build and unpacked packaging;
startup failed and packaged startup timed out. Its inventory recorded 2,007 passed,
630 failed and 8 skipped assertions; one additional suite failed during import.

[Native diagnostic 37060375331](https://github.com/forever-Agriculture/BMN/actions/runs/37060375331)
compared the original helper with a single metadata refresh after creating the
private directory: original failed with a false link refusal, refreshed passed.
`fa91090` applies that fix without relaxing owner, ACL, link or size checks.
The inherited PowerShell module path was separately ruled out as the production
cause. Native test fixture ACL access now uses .NET APIs to avoid the observed
PowerShell cmdlet-module load failure. Temporary probes were removed.

[Candidate run 37060628420](https://github.com/forever-Agriculture/BMN/actions/runs/37060628420)
tested `fa91090`: Linux passed all gates. Windows root/ACL, Linux-root fixtures
and sandbox-audit tests passed; inventory is now 2,014 passed, 623 failed and 9
skipped. Both development and unpacked apps reach the UI/database, then fail
during workspace/settings/control setup with an opaque IPC error. Stage-specific
diagnostics are being added; startup acceptance remains open. Windows Server CI does not establish
Windows 11 standard-user, cross-user denial or desktop/device acceptance.

The first inventory below is retained even when individual fixtures are repaired.
Numbers count failed assertions, not all assertions in the file. The companion
suite's zero means an import failure in its synthetic `/proc` port fixture
(`process.getuid`); its other assertions did not execute. Story assignment is
ownership for repair, never a waiver or a confirmed diagnosis of every failure.

| Failed file | Failed assertions | Owning story |
| --- | ---: | --- |
| `scripts/lib/disposable-provider-env.test.mjs` | 2 | 53.2 |
| `scripts/tests/desktop-launcher.test.mjs` | 14 | 53.11 |
| `scripts/tests/sandbox-flag-audit.test.mjs` | 1 | 53.1 |
| `scripts/tests/staged-build.test.mjs` | 1 | 53.11 |
| `apps/desktop/src/main/file-reference-ipc.test.ts` | 3 | 53.3 |
| `apps/desktop/src/main/voice-engine.test.ts` | 7 | 53.8 |
| `apps/desktop/src/utility/agent-history-adapters.test.ts` | 8 | 53.6 |
| `apps/desktop/src/utility/agent-history-claude.test.ts` | 4 | 53.6 |
| `apps/desktop/src/utility/agent-history.test.ts` | 8 | 53.6 |
| `apps/desktop/src/utility/artifact-files.test.ts` | 13 | 53.3 |
| `apps/desktop/src/utility/codex-launch.test.ts` | 1 | 53.6 |
| `apps/desktop/src/utility/companion-service.test.ts` | 0 | 53.10 |
| `apps/desktop/src/utility/control-auth.test.ts` | 1 | 53.4 |
| `apps/desktop/src/utility/control-cli.test.ts` | 294 | 53.4 |
| `apps/desktop/src/utility/control-server.test.ts` | 175 | 53.4 |
| `apps/desktop/src/utility/conversation-binding.test.ts` | 3 | 53.6 |
| `apps/desktop/src/utility/database-companion-store.test.ts` | 2 | 53.3 |
| `apps/desktop/src/utility/database-workspace-store.test.ts` | 2 | 53.3 |
| `apps/desktop/src/utility/file-reference-reader.test.ts` | 3 | 53.3 |
| `apps/desktop/src/utility/hook-configuration-check.test.ts` | 2 | 53.6 |
| `apps/desktop/src/utility/hook-event-history.test.ts` | 2 | 53.6 |
| `apps/desktop/src/utility/private-directory.windows.test.ts` | 3 | 53.1 |
| `apps/desktop/src/utility/remote-answer.test.ts` | 17 | 53.9 |
| `apps/desktop/src/utility/reported-resume.test.ts` | 2 | 53.6 |
| `apps/desktop/src/utility/repository-identity.test.ts` | 4 | 53.3 |
| `apps/desktop/src/utility/roots.test.ts` | 4 | 53.1 |
| `apps/desktop/src/utility/screen-mirror.test.ts` | 12 | 53.7 |
| `apps/desktop/src/utility/session-manager.test.ts` | 40 | 53.2 |
| `apps/desktop/src/utility/telegram-card-keeper.test.ts` | 1 | 53.9 |
| `apps/desktop/src/utility/terminal-graphics.test.ts` | 1 | 53.7 |

### Additional native security evidence

[Run 37062572504](https://github.com/forever-Agriculture/BMN/actions/runs/37062572504)
on `26b1206` passed all five native ACL tests: new-root/restart, shared-root refusal,
broad-child refusal, root-junction refusal without changing the target ACL, and
entry-limit refusal. The 10,000-child fixture reached the explicit entry limit in
629 ms without timing out. This does not measure memory or prove foreign-owner or
cross-account denial. The real application still loses its utility host because
that process's folder-security check fails; full startup remains unverified.

The `fa91090` inventory also exposed a timeout in
`apps/desktop/src/utility/file-reference-search.test.ts`, owned by 53.3. Its cause
is unconfirmed and it has not been waived.

### Resume evidence: Chromium ACLs and path aliases

[Full candidate run 37069696565](https://github.com/forever-Agriculture/BMN/actions/runs/37069696565)
tested production `67bdf69`. Linux passed all gates, including 2,832 unit tests,
startup, packaging and packaged smoke. Windows passed install/native rebuild,
lint, typecheck, build, unpacked packaging and one complete packaged startup
(persistence, second-instance activation, sandbox and native module checks).
Windows development startup failed. Its unit inventory recorded 2,027 passed,
624 failed and 9 skipped; 29 files failed. The Windows-specific storage suite
passed 12 tests and failed the new missing-leaf alias test. These are individual
results; Windows startup reliability and Story 53.1 are not accepted.

Two Story 53.1 defects remain:

- Existing 8.3/long-path selection and overlap rejection now pass, but creating a
  missing leaf through a short-path ancestor with a long-path data designation
  still fails (`private-directory.windows.test.ts`, the `new-leaf` assertion).
  Its exact normalization failure needs further evidence; it is not waived.
- [Synthetic restart diagnostic 37070042296](https://github.com/forever-Agriculture/BMN/actions/runs/37070042296)
  runs the same production source with diagnostic-only harness changes in
  `b603d35`. Verification passes after the first Electron launch and fails after
  restart: Chromium's `Preferences` file has two current-user FullControl ACEs,
  while the guard requires exactly one. No foreign principal or extra right is
  present in that captured failure. The passing packaged sample above does not
  override this reproducible failure.

The original Chromium capability mismatch is documented in
[Windows storage security](windows-storage-security.md). The narrow policy keeps
unknown identities/rights, shared roots, links and unsafe owners rejected.
Source rechecks found no additional defect, but native evidence leaves the two
failures above unresolved. The dev-auto consultant/final repair allowance is
exhausted; this boundary is BLOCKED pending an explicit next design decision.
No merge or deployment has occurred. Stories 53.2–53.4 are in progress;
53.5–53.13 remain unfinished. Native Windows job nesting and retained Electron
child cleanup are unverified until the new crash fences run. Windows file-path
grammar, pins and directory-flush portability have local regression evidence;
this does not establish native file or Explorer acceptance.

Windows 11 standard-user acceptance, foreign-owner refusal, ordinary and
capability-bearing cross-account denial, and wide-tree memory measurements remain
UNVERIFIED. WSL and later capabilities retain their separate gates.

## Current native terminal and storage evidence

[Run 37113576528, attempt 2](https://github.com/forever-Agriculture/BMN/actions/runs/37113576528)
passed on `33deab2`, Windows Server 2025 Datacenter x64, Electron 44.3.0
(embedded Node 24.20.0), host Node 24.14.0 and pnpm 12.3.4. The maintained
addon compiled and supplied real terminal stdin/stdout. Exact Sixel, OSC 52/9/777/99,
mouse and bracketed-paste sequences, repaint, resize, Ctrl+C and exit zero passed.
Owned root/child/grandchild/OpenConsole cleanup passed for normal exit, Stop and
host crash; silent and immediate-exit checks passed. The unrelated sentinel survived
all cases. The first attempt stopped during a Node-header download with ECONNRESET;
its unchanged rerun is the passing evidence.

[Storage run 37111187296](https://github.com/forever-Agriculture/BMN/actions/runs/37111187296)
on `6cb7a46` passed Chromium restart and alias checks plus a true separate ordinary
account fixture: public read succeeded while private read/write/delete were denied;
the generated account was removed. Full platform run
[37112142206](https://github.com/forever-Agriculture/BMN/actions/runs/37112142206)
on `9305898` passed Linux gates and Windows development/packaged startup. Windows
unit inventory remained failing: 2,044 passed and 622 failed. Later-story failures
remain required work, not waived acceptance.

The owner explicitly deferred unavailable Windows 11 laptop, WSL/device manual
checks until the collaborator tests the release. They remain **UNVERIFIED**.
All feasible local/native CI checks and known reproduced failures still require
resolution. No full-parity release or Epic 53 completion is claimed here.

[Capability isolation run 37118862309](https://github.com/forever-Agriculture/BMN/actions/runs/37118862309)
on `7fd12e8` passed real second-user AppContainer access with the exact Chromium
network capability. The ordinary broker was medium integrity (RID 8192), and both
AppContainer receivers were low integrity (RID 4096). A capability-bearing positive
control allowed read/write; removing the capability denied it. Strict storage,
accepted Cache storage and an accessible low-integrity diagnostic copy denied both
read and write with Windows error 5. All private hashes were unchanged and all
generated account/profile resources were removed. This closes the feasible native
storage gate for 53.1; the owner-deferred Windows 11 check remains UNVERIFIED.

[Launch and fixture run 37116830591](https://github.com/forever-Agriculture/BMN/actions/runs/37116830591)
on `ee59eb4` retained passing Linux gates and Windows launch UI, native shell/argv,
packaged startup and native selection. Windows unit inventory improved to 2,096
passed, 589 failed and 11 skipped. Two new skips are specifically the Linux Bash
wrapper and SIGHUP semantics, with their Windows owned-job/native-agent-prompt
counterparts exercised separately. Remaining failures retain their story ownership.

## Native voice and crash measurements (2026-10-03)

[Platform run 37134340385](https://github.com/forever-Agriculture/BMN/actions/runs/37134340385)
tested `cd39f825` on the recorded Windows Server 2025/Ubuntu 24.04 stacks. Linux
passed its full suite, startup and packaged checks. Windows passed portable and
packaged speech/silence/transcription using only public audio; both executable PE
imports contain only ADVAPI32/KERNEL32, and the actual temporary recording ACL
test passed. Development and packaged startup each exercised the real `bmn snapshot`
launcher. Other CPU hardware, real microphones and the complete voice UI flow
remain UNVERIFIED.

Native protected direct and debugger-attached utility-then-main crash probes each
confirmed eight retained process handles exited. The baseline without the main job
also cleaned naturally, so original-defect reproduction remains INCONCLUSIVE.
Renderer recovery, Close/Keep-running, Close/Stop/restart and Ask/Cancel/Quit/restart
passed; the later main PID lookup assertion prevented completing the lifecycle gate.
The candidate fixture now obtains the actual main PID and native creation identity
inside Electron, recording launcher and metrics identities separately.

[PTY run 37134340356](https://github.com/forever-Agriculture/BMN/actions/runs/37134340356)
passed all native tree/GUI/pressure/race and cross-account private-pipe checks.
The full Windows unit inventory remains failing: 2,730 passed, 167 failed, 12 skipped.
Eight newly observed passing keys were removed from the failure inventory. Synthetic
hook diagnosis delivered Stop RPCs with both fake and missing `/proc`; real server
validation subsequently identified a POSIX-only Claude configuration-path check.
The next candidate uses native absolute-path validation, retaining relative-path
rejection and agent/session authority. No whole-story acceptance is claimed.

[Platform run 37137313541](https://github.com/forever-Agriculture/BMN/actions/runs/37137313541)
tested `b973be9`: native drive/UNC configuration-directory RPC validation passed,
and Windows units improved to 2,775 passed, 126 failed, 12 skipped. Thirty fully
passing keys were removed; two new fixture timeouts remain failures until repaired.
Main-crash and utility-crash restart checks passed, but final fixture-directory
removal failed; full lifecycle acceptance remains open. Playwright's Windows
`cmd.exe` wrapper had PID 6404 while the actual Electron main had PID 6436.
The next fixture retains final Electron process handles before Close rather than
using wrapper exit as cleanup evidence.

[WSL ownership run 37137313568](https://github.com/forever-Agriculture/BMN/actions/runs/37137313568)
imported the pinned Canonical Ubuntu 24.04.4 image as a fresh WSL2 registration.
With systemd and ordinary UID 1000, Stop and root SIGKILL each ended all three
detached processes, verified with retained Linux pidfds and start ticks. The
registration was removed. Native host crash/stdio EOF and Windows GUI interop
remain separate, unverified design gates. The next probe measures raw host loss,
and measures configuration symlink/dotdot resolution and copy/write/rename ACL
behavior using synthetic files only. No product WSL adapter exists yet.

## Latest complete native inventory (cb9f8f28)

[Run 37161061556](https://github.com/forever-Agriculture/BMN/actions/runs/37161061556) completed the full Windows inventory: 2,826 passed, 93 failed and 12 skipped out of 2,931. Seven failed keys are unowned and remain gate failures; they were not added to the allowed inventory. Fifteen previously listed keys passed in every parameter case and were removed. The failure list now contains 84 open keys; keys and assertion counts can differ when a parameterized test shares a name.

The same run passed Linux checks, native startup/shell/launch UI, and unpacked packaged startup/native selection. [Config run 37161061581](https://github.com/forever-Agriculture/BMN/actions/runs/37161061581) passed all 18 writer safety assertions, including original/fixed uppercase SystemRoot and namespace replacement races, then failed removing its synthetic fixture directory. The fixture cleanup repair is not yet natively verified.

Native Sixel ConPTY-to-renderer and owned TCP listener gates are prepared but have not run on their new candidate. Windows 11/device acceptance remains UNVERIFIED under the owner's release amendment; available native CI failures still block release.

## Local repair candidate after cb9f8f28 (native checks pending)

`19923b4` redirects hook-check HOME/USERPROFILE into a fresh synthetic fixture and uses a native read-deny DACL with readback/restoration instead of Unix chmod. Learned Claude history fixture files receive only the elevated CI owner setup. Linux: 68 passed, one native-only skip; typecheck/lint passed.

`459916f` checks retained hook history pathname/handle identity before reading and refuses links, hardlinks and replaced files. Both new guards fail against the original implementation (two failures, 15 passed) and pass with the repair; 204 affected history/Companion tests, the CLI read-denial case, typecheck and lint passed. Windows state files inherit the existing secured state root; native inheritance and these repaired flows remain UNVERIFIED.

`d25700a` uses native absolute voice model paths in the stored-row and normalization fixtures. All 46 Linux database tests and typecheck/lint passed. Native fixtures remain UNVERIFIED.

The TCP gate now opens an isolated Edge profile inside a retained Windows session job and navigates to both sessions' IPv4/IPv6 root, child and grandchild listeners. Edge and all other fixture jobs must confirm exit at cleanup. [The Windows 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md#browsers-and-drivers) provides Edge; no browser installation, owner profile or sandbox-disable flag is used. The new gate has only syntax/lint validation locally and remains **UNVERIFIED** until native CI runs. This does not verify clicking a BMN port chip or default-browser activation.

## Installer and source-update candidate (2026-10-04)

The current source adds an offline per-user NSIS installer, a stable launcher,
immutable version directories, native shared startup/exclusive updater leases,
and a durable transaction journal. Validation and self-test use fresh profiles;
activation preserves the old payload. Older code refuses an unknown data schema
before initialization writes, and a newer migration requires a verified SQLite
backup. A failed metadata refresh reports the actually selected commit and retries
metadata instead of reapplying migrations. There is no automatic data rollback.

The existing `install:desktop` and `update:desktop` commands have Windows adapters.
A contributor update queues the exact clean `main == origin/main` commit, resumes
from the installed launcher, builds a separate detached worktree, and checks source
identity again immediately before activation. A failed queue allows the retained
selected app to open; retry is explicit. Uninstall offers retention by default or
explicit deletion of **all contents of the displayed data folder**, including
user-created files there. It retains configuration, the empty lock and the offline
recovery runtime; projects outside the folder are not enumerated. Native shortcuts
set and read back `dev.bmn.desktop` and the launcher target.

The retained bootstrap now delegates to the selected version's runtime/worker,
so an offline runtime upgrade does not leave later source updates using the old
runtime. A short shared lease covers validation and worker creation, then releases
before the worker needs its exclusive update lease. Both launcher branches use an
ordinary byte-equal `BMN-worker.exe` copy. Payload sealing covers both images;
GUI startup rejects the worker image, and the worker entry rejects the GUI image.
The existing exit observer continues waiting for `BMN.exe` GUI/utility processes.
Actual Windows PE size and renamed-runtime execution remain UNVERIFIED.

Uninstall takes the request lease before installation/data leases, sets queued work
aside and removes selection. Resume rechecks both request and selection after
acquiring the same lease; it cannot reactivate an uninstalled root. Live mapped
worker versions are retained. Private roots are provisioned first, then the complete
security scan runs under both mutation leases after GUI/utility exit. A new native
gate checks that full scan while kernel lock handles are held; it has not run.
Queued/waiting starts forward to the selected running GUI. Otherwise, an owned
asynchronous notice explains the wait; dismissing it leaves the update running.

Local evidence: the consolidated worker repair has 100 affected passing tests,
typecheck, lint and worker bundling. The original reviewed resolver fails the
bounded two-worker queue/lease regression; the repair passes with one activation
and all simulated leases released. Original image guards, uninstall rechecks and
renamed-GUI selection tests fail on their respective defects and pass after repair.
These tests use synthetic process observations and ordinary temporary files.
The three earlier installer findings are closed; the former shortcut compatibility
finding was rejected against Git history because that format was never shipped.
The focused Astra source recheck closed the consequential worker repair and found
no new material defect. The attempted Luna recheck timed out without a verdict;
its partial output does not count as acceptance. Full-epic review is unrun.
The pinned NSIS compiler's prior Linux syntax/resource check and real Linux startup
evidence are retained for unchanged behavior.

Native MSVC compilation, standard-user kernel locking, copied-worker/ASAR/module
loading, concurrent launches, offline install/upgrade/uninstall/reinstall,
crash/locked-file recovery, actual wait/focus UI, installed shortcut/toast activation,
contributor execution and Windows 11 acceptance remain **UNVERIFIED**. Scratch
worktrees may remain while native modules are mapped; their recorded locations
support recovery. No installed-app or Epic 53 completion is claimed.

## Restricted WSL profile: UID boundary measurement (2026-10-04)

The owner approved strict cleanup with an explicit restricted capability profile.
That choice does not make the current prototype complete. A local disposable
Docker fixture, with no network, host mounts or owner configuration changes,
reproduced an ordinary same-UID peer reading a private project through
`/proc/<pid>/root` and requesting a broker-created process. That process survived
the session target's exit. Giving the target a separate numeric UID denied both
project and proc-alias reads and prevented that launch request.

| Local fixture | Private project read | Proc-root alias read | Outside actor after target exit |
| --- | --- | --- | --- |
| Target UID 1000, peer UID 1000 | Allowed | Allowed | Survived |
| Target UID 200000, peer UID 1000 | Denied | Denied | Not launched |

This measures the Linux UID/filesystem/proc boundary only. It does **not** verify
WSL2, user/mount/network namespaces, general egress, authenticated `bmn` relay,
mediated project import/export, device/FD/syscall restrictions, WSLg/native interop,
two-distribution identity, ports or terminfo. `ProfileComplete` remains false.
A trusted root helper inside the selected WSL distribution could provision an
isolated per-session numeric UID and private filesystem without permanent Linux
user records or global distro changes. The owner authorized this per-session helper
through `wsl.exe --user root` only in the selected distribution. That approval excludes
permanent users, distro/global configuration changes, Windows elevation, credential
copies and tests on owner profiles. No WSL product adapter is implemented.

The extracted [guest-root helper prototype](../scripts/lib/wsl-root-session.py)
now creates root-owned PID/mount/network/IPC/UTS namespaces, a private filesystem
and an unprivileged numeric session UID. Runtime kernel leases serialize UID
allocation across root callers, refuse occupied account/process identities, and
reclaim stale slots only after exit. They create no Linux user records.
Allocation also scans each thread's real/effective/saved/filesystem UID rather
than only its process leader. A live worker-thread fsUID reproduces the original
allocation failure and is refused by the repaired helper. The syscall filter
explicitly denies kernel-global `syslog`; its size-only probe returned EACCES.
The unfiltered control was denied by the outer container policy, so that control
is INCONCLUSIVE; no kernel log contents were read.


The [synthetic measurement](../scripts/test/fixtures/wsl-root-profile.py), on
Linux kernel `7.0.0-34-generic` in a disposable Python 3.12 Debian container,
exercised ready filesystem/abstract Unix, TCP and file-watcher brokers. All four
positive controls launched outside actors; the restricted session launched none.
Peer UID 1000 could not read its private project through a proc-root alias.
Natural exit, Stop, supervisor crash and stdin EOF each terminated three retained
session processes while the unrelated broker/actors remained alive. Actual i386
and x32 entrypoints were rejected; private socketpair IPC and threads worked.
The root observer required `SYS_PTRACE`; session effective, permitted, inheritable
and ambient capabilities are explicitly cleared. The fixture removes its scratch
files and confirms termination of its own outside actors separately.

An Opus design consultation identified a missing adversarial EOF case: the session
can ignore stdin entirely. That fifth lifecycle failed against the original
helper: retained descendants survived after host EOF. The controller now polls
stdin hangup and its retained init pidfd without reading terminal input; the same
five-mode local fixture passes, with all three processes terminated and unrelated
sentinels alive. Callback failure still exits 70. The focused Luna source review
found no material defect in the repair. A sixth mode repeats the original failure
and repaired cleanup through a dedicated raw Linux PTY, with byte-identical Sixel
output. The receipt gate requires both nonreading-EOF modes; 14 parser/receipt
checks pass. This measures terminal bytes, not xterm rendering or a WSL PTY relay.
Actual WSL root-helper hangup measurements are recorded below. The production
ConPTY-to-inner-PTY relay remains UNVERIFIED.

This is a helper prototype with a trusted measurement callback, not a production
launch protocol. Native WSL root-helper measurement passed through the existing
freshly imported distribution gate. Persistent project mediation,
mediated general egress, scoped BMN relay, PTY/terminfo and native host lifecycle remain
open; `ProfileComplete` is still false.

The callback failure regression exits 70 inside the fork without unwinding into
the root caller's cleanup. It failed on the original helper and passed with the
repair; the four lifecycle measurements above remained passing. Guest invocation,
malformed output and assertion failures now produce explicit FAIL receipts rather
than a missing result that the outer gate could accept. The receipt tests also
parse the exact Python launch text: the indentation regression fails against
`f00ddad`, and the repaired twelve checks pass. These are local synthetic/runtime
and parser results, not native WSL acceptance.

The remaining capability design must preserve agent sandboxes, ordinary Internet
and package-manager access, private durable projects, scoped `bmn` calls and ports.
The current filter denies user/mount namespaces used by nested agent/browser
sandboxes; disabling those sandboxes would violate the owner boundary. A safe
nested-namespace policy still needs measurement. Persistent workspace ownership
must prevent a later UID lessee from accessing another project's stored files;
private storage, namespace mapping and crash-safe import/export are unimplemented.
A writable tree shared with outside watchers would recreate the measured broker
escape. Mediated egress must account for host addresses, DNS/redirects, IPv4/IPv6
and Windows NAT/mirrored routing; a provider-only allowlist does not preserve
general shell/build use. The bridge must carry protocol separately from terminal
bytes and bind authority at the native host without copying its owner token.
These are unresolved implementation/design gates, not delivered capabilities.

## Native outside-broker discriminator (candidate)

The new [WMI gate](../scripts/test/windows-broker-ownership.mjs) requires a
disposable native runner and medium-integrity token. It creates a ready same-user
WMI positive control, retains process handles, launches a direct ConPTY child and
a WMI-requested child, then exercises Stop. A surviving broker child makes strict
ownership FAIL; a refused or owned WMI route establishes that route only. Unrelated
control survival and fixture cleanup are checked separately. Its syntax/lint checks
passed; native execution is **UNVERIFIED**, and it is not currently routed into CI.
The owner’s all-launched-process requirement remains unchanged.

## Current native candidate: `9f797ff`

[Platform run 37213060352](https://github.com/forever-Agriculture/BMN/actions/runs/37213060352)
passed the Linux suite (3,024 assertions, 36 skipped), build, startup and packaged
smoke. Windows passed 3,018 assertions with 30 failures and 12 skips. Native lint
also included generated installer output, and packaging refused a hook outside
its app workspace. These reproduced failures remain open; earlier packaging
success does not verify the changed installer candidate. The shell/argv checks
passed, but the native Sixel producer exited before a retained renderer view;
its cause remains UNCONFIRMED. App lifecycle/crash cleanup measurements passed.

[WSL run 37213060358](https://github.com/forever-Agriculture/BMN/actions/runs/37213060358)
passed the measured root-helper profile on Linux
`6.18.33.2-microsoft-standard-WSL2`, x86_64. Natural exit, Stop, supervisor crash,
stdin EOF, nonreading stdin EOF and nonreading raw-PTY EOF each terminated all
three retained processes and preserved unrelated sentinels. The raw-PTY case
preserved exact Sixel bytes. UID reuse/thread guards, proc-root alias denial,
filesystem/abstract/TCP broker denial, callback failure and i386/x32 denial passed.
The unfiltered syslog positive control was allowed; the filtered request was
denied. The fixture removed its files and unregistered its disposable distribution.
This establishes the measured helper only: `ProfileComplete` remains false.
The product adapter, durable projects, general egress, nested agent sandboxes,
scoped control relay, terminfo and actual Windows-host disconnect remain unfinished.
