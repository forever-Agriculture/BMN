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
| Build, data roots, database, restart, single instance, unpacked startup — 53.1 | Implementation team | Build/startup/package PASS on Ubuntu CI | Install/build/package and one packaged startup PASS; development/restart blocked | UNVERIFIED |
| PowerShell/cmd launch, input, stop, process identity, crash cleanup, ConPTY feasibility — 53.2 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Files, path links, attachments, backups, directory permissions — 53.3 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| CLI, transport, caller/session authority — 53.4 | Implementation team | UNVERIFIED | Not implemented | UNVERIFIED |
| Named distributions, bridge, path mapping, terminfo — 53.5 | Implementation team | UNVERIFIED | UNVERIFIED | Not implemented |
| Claude/Codex/OpenCode/Cursor hooks, history, usage, compaction, resume — 53.6 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Terminal images, clipboard, IME/AltGr, scaling, panes, themes, keyboard access — 53.7 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Microphone, local voice engine, cancellation, addressed paste — 53.8 | Implementation team | UNVERIFIED | Not implemented | UNVERIFIED |
| Notifications, attention, Telegram replies and delivery diagnostics — 53.9 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Per-session development port discovery and navigation — 53.10 | Implementation team | UNVERIFIED | Not implemented | UNVERIFIED |
| Per-user install, source updates, rollback, uninstall — 53.11 | Implementation team | UNVERIFIED | Not implemented | UNVERIFIED |
| Full CI, required merge gates, contributor rules — 53.12 | Implementation team | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Full feature-guide reconciliation and installed-app acceptance — 53.13 | Team + independent Windows verifier | UNVERIFIED | UNVERIFIED | UNVERIFIED |

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

Before acceptance, expand the capability rows against every current feature-guide
entry and newly merged epic contract. These initial rows do not claim complete
final feature-by-feature coverage.

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
No merge or deployment has occurred. Stories 53.2–53.13 remain backlog.

Windows 11 standard-user acceptance, foreign-owner refusal, ordinary and
capability-bearing cross-account denial, and wide-tree memory measurements remain
UNVERIFIED. WSL and later capabilities retain their separate gates.
