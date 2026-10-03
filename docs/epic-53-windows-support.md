# Epic 53: Full Windows Support and Development for Both Operating Systems
**Suggested lead:** Sol 🇺🇸 — terminal lifecycle, local authority and native packaging need coordinated evidence on both operating systems.

Planning contract: 13 stories. Owner request: 2026-10-02. Execution status comes from
the shared pull requests and parity checklist described below, not this heading.

## Outcome and scope

The owner goal is a Windows version as good as Linux: the same capabilities,
reliability, security and usability, with no reduced-quality Windows edition.
The implementation team owns development, testing and repair on both operating
systems. Oleksandr's Windows collaborator independently double-checks the finished
Windows experience; that final verification supplements the team's Windows testing
and does not replace it. No unrun Windows check counts as passing.

After this epic is accepted, every feature and fix is developed for both operating
systems in one repository, with checks on both before completion. The suggested AI
lead above is not a human assignment.

Planning baseline: source `90596ee`, the current [feature guide](features.md),
[architecture](architecture.md), [development guide](development.md), and existing
epic acceptance contracts. Reconcile against the integration commit when work starts:
features merged during this port join the parity checklist before final acceptance.
Existing unfinished work keeps its own status; this plan does not take it over.

Initial target assumption: Windows 11 x64, native PowerShell and Command Prompt, plus
WSL2 sessions in a named Ubuntu distribution. The Windows desktop app must launch and
run native sessions without WSL installed. Linux x64 remains supported. The owner's
machine reports Ubuntu 26.04.1 LTS; that observation is not runtime verification.
Record exact OS, shell, distribution and dependency versions in acceptance evidence.
Windows ARM64, macOS and older Windows releases need separate support decisions.

“Full” means every existing BMN capability has a tested Windows route, including
agent integration, terminal graphics, voice, Telegram, files, backups and developer
port discovery. Upstream CLI limitations may require a documented WSL route; they
cannot silently remove the capability or count an untested route as passing.
Native and WSL support are separate checklist columns. Missing parity blocks closure;
reducing the promised scope requires an explicit owner decision.

This file is the canonical, shareable epic. The local BMAD epic index links here.
Pull requests identify their story IDs and carry the shared implementation status;
53.1 creates tracked `docs/epic-53-parity.md` for the capability matrix and evidence
index. Both maintainers update that checklist through their pull requests. Oleksandr
mirrors accepted progress into his Git-ignored sprint tracker; the collaborator
does not need that local file to contribute or inspect acceptance. Evidence links
must be accessible to both maintainers; retain synthetic results, never credentials
or private session content. Neither publishing a release nor sending test messages
is authorized merely by this planning document.

## Delivery acceptance update (owner, 2026-10-03)

Implement the full epic and run every feasible check on the development machine,
in native Windows/Linux CI, and in available local emulation. The owner directs
release after those checks. The Windows collaborator verifies the released build
on his Windows laptop and may repair issues found there.

This explicitly defers unavailable Windows 11, device and WSL acceptance to
post-release verification. Record each such check as **UNVERIFIED** in the parity
checklist and release notes; do not substitute Windows Server or WSL evidence for
native Windows 11. Missing access alone no longer blocks release. Known reproduced
failures still require repair, and this update does not remove promised features,
security requirements, the ConPTY feasibility gate, or authorization requirements
for paid infrastructure, phone/provider tests or owner-profile changes. This owner
update takes precedence over the earlier pre-release manual-evidence timing below.

## Requirements and coverage

| Requirement | User outcome | Stories |
| --- | --- | --- |
| W-FR1 | Build and open BMN on Windows as a standard user | 53.1 |
| W-FR2 | Start, use, stop and recover native shell sessions safely | 53.2 |
| W-FR3 | Use Windows paths, persistent data, files and backups | 53.3 |
| W-FR4 | Use the local `bmn` API and CLI with unchanged authority | 53.4 |
| W-FR5 | Run integrated sessions inside a chosen WSL2 distribution | 53.5 |
| W-FR6 | Use existing agent hooks, resume, history and usage features | 53.6 |
| W-FR7 | Use the complete terminal and desktop interaction set | 53.7 |
| W-FR8 | Dictate locally on Windows | 53.8 |
| W-FR9 | Receive notifications and answer through Telegram | 53.9 |
| W-FR10 | Discover and open the correct session's development ports | 53.10 |
| W-FR11 | Install and update a usable Windows package safely | 53.11 |
| W-FR12 | Keep future development working on both operating systems | 53.12 |
| W-FR13 | Trust full parity based on installed-app evidence | 53.13 |

Constraints applying to every story:

- W-NFR1: One shared UI, protocol and data model; small platform adapters at actual
  OS boundaries. No permanent Windows branch, copied application or general rewrite.
- W-NFR2: Preserve renderer sandboxing, caller/session/incarnation checks, bounded
  messages and owner-only credentials/state. Windows permissions need Windows access
  controls; Unix mode bits alone are not proof. No unauthenticated network control.
- W-NFR3: No accidental command execution from paths, shell quoting or environment
  handling; no automatic process restart or replay of uncertain terminal input.
  Process operations must establish ownership and handle PID reuse safely.
- W-NFR4: Preserve existing Linux data and behavior. Add migrations only when needed;
  preserve unrelated harness configuration and explicit consent for cleanup or input.
- W-NFR5: Exercise changed flows on real Linux and Windows stacks with isolated data.
  Unit tests, cross-compilation and WSL-only runs do not establish native Windows
  behavior. Mark missing checks UNVERIFIED; do not waive them to close this epic.
- W-UX1: Preserve existing layouts, themes, keyboard access, focus, explicit
  destinations, and paste-versus-submit meanings. Test Windows scaling and input.
- W-UX2: Show the actual shell/distribution, executable and directory; errors name
  missing prerequisites or unavailable resources without hiding a parity failure.

## Delivery and ownership

**Queue position (owner update, 2026-10-02): start now.** The owner explicitly
started Epic 53 ahead of the earlier queue. Preserve the active Epic 50/54 work and
Epic 55 evidence in their own runs; this port does not take over their acceptance.
Keep Epic 53 as its stable identifier.

Implement stories in numbered order, integrating short branches through pull requests.
Each story uses existing capabilities or earlier stories only. Freeze or integrate
overlapping active changes before editing the same files. No implementation starts
because a row was added to the tracker.

Numbered order is the default schedule, not a claim that every adjacent story has a
technical dependency. The explicit dependencies below identify actual prerequisites.
When preparing large stories such as 53.6/53.7, split implementation into bounded
subtasks by harness or user flow, retaining every acceptance criterion and story ID.

Start native Windows and Linux build checks with 53.1; grow the checks with each story.
53.12 makes the complete checks and contributor rules mandatory. Windows ownership
means someone can reproduce, fix and validate Windows issues, not that Linux-only
features are merged and left for the collaborator to repair later.

### Story 53.1: Build and Open BMN on Windows

As a Windows contributor, I want a repeatable native development setup, so that I can
start BMN and work on the port from my own machine.

**Coverage:** W-FR1. **Depends on:** current application only.

**Acceptance criteria:**

1. **Given** a clean Windows checkout, **when** documented prerequisites and the pinned
   package manager are used, **then** installation, native Electron module rebuild,
   lint, typecheck and application build succeed without Linux tools or WSL. Inventory
   the unit/integration suite now: run portable checks on both OSes and assign every
   failing Linux-specific fixture to its owning port story; no blanket Windows skip
   and no full-suite success claim while that inventory has open failures.
2. **Given** a standard Windows account and isolated test profile, **when** the desktop
   starts, **then** the sandboxed UI and database load, a workspace/settings change
   survives restart, and a second app launch activates the same instance. Choose and
   document final Windows user-data roots and override precedence here, with effective
   owner-only access; 53.3 extends file behavior without moving those roots. Use
   isolated disposable profiles for development; unavailable subsystems fail visibly.
3. **Given** the same commit on Linux, **then** its existing build/startup checks pass.
   Add Linux and Windows CI install/build checks. Create tracked
   `docs/epic-53-parity.md` with native Windows, WSL and Linux columns, story owners,
   current results, exact OS/tool versions and accessible evidence links. Record the
   tested Linux baseline separately from the owner's observed OS upgrade.
4. **Given** the Windows build, **then** produce an unpacked Windows application and
   run packaged startup/native-module smoke through platform-aware packaging helpers.
   This early internal artifact packages only capabilities delivered so far; later
   stories add their resources and smoke coverage. It is not a full-parity release.
   Per-user installation, safe updates and uninstall remain in 53.11.

**Starting points:** root/app `package.json`, `scripts/build/rebuild-native.mjs`,
`scripts/test/electron-dev.mjs`, `apps/desktop/src/main/`, utility native loading and
data-root resolution and `scripts/lib/packaged-app.mjs`.
**Verification:** native clean-install/start/restart and unpacked-package smoke on
both OSes; synthetic workspace only; explicit remaining unit-fixture failures.

### Story 53.2: Use and Stop Native Windows Terminals Safely

As a Windows user, I want native shell sessions with reliable lifecycle behavior,
so that working in BMN does not lose input or leave unmanaged processes.

**Coverage:** W-FR2. **Depends on:** 53.1.

**Acceptance criteria:**

1. **Given** installed PowerShell or Command Prompt, **when** I create a session,
   **then** BMN launches the selected shell through the Windows PTY with the exact
   directory, arguments and environment. Handle `PATH`/`Path`, `.exe`/`.cmd`, spaces,
   Unicode and shell metacharacters without Bash assumptions or injection. Include
   renderer defaults/templates, `PATHEXT` lookup, case-insensitive private environment
   removal and `.cmd`/`.bat` shim arguments. Specify the Arguments-field grammar so
   Windows paths/backslashes round-trip unchanged; test quotes, `%`, `^` and `&`.
   Agent launch cards retain a usable shell when the agent exits.
2. **Given** a live interactive program, **when** I type, resize, send Ctrl+C, or stop,
   **then** terminal I/O remains correct, child processes are addressed safely, and
   exit status is truthful. PID reuse or lost ownership never targets unrelated work.
3. **Given** Close, Quit, renderer crash, host crash or restart, **then** existing
   keep-running/stop/ask, saved-output and interrupted-session semantics hold. Stopping
   is not reported successful before exit is known; no session restarts automatically.
   Record and exercise child-process cleanup after a utility/host crash, not just the
   recovered database label. Do not leave an uncontrolled background process tree.
4. **Given** the actual Windows PTY options, **before** choosing the adapter and
   starting 53.3, **then** run a feasibility spike for built-in and, if needed,
   bundled ConPTY: Sixel, OSC 52/9/777/99, mouse and bracketed-paste mode sequences,
   repaint and Ctrl+C. Record observed bytes and behavior, the chosen route and any
   redistribution/native-build implications. WSL still traverses the Windows display
   path, so it is not an assumed workaround. If no full-feature route is demonstrated,
   escalate the measured limitation before extending the port; do not silently cut parity.
5. **Given** Windows process and access-control requirements, **then** record the
   minimal native-addon/helper/OS-command choices for creation-time identity, owned
   process-tree control, pipe access restrictions and later port attribution. Measure
   availability as a standard user, bounded overhead and required build resources.
   Implement only this story's mechanisms now; later stories consume the decisions.

**Starting points:** `main/launch-spec.ts`, `utility/session-manager.ts`,
`utility/process-start-identity.ts`, `utility/pty-host.ts`, and
`renderer/src/launch-template.ts` under `apps/desktop/src`.
**Verification:** real PowerShell and cmd PTYs, child/grandchild exit, crash/restart
and isolated process-identity failure fixtures; Linux lifecycle regression checks.

### Story 53.3: Keep Files and Data Safe with Windows Paths

As a Windows user, I want files, workspaces and backups to use my real directories,
so that path differences do not break access or expose unrelated files.

**Coverage:** W-FR3. **Depends on:** 53.2.

**Acceptance criteria:**

1. **Given** default or overridden data roots, **then** use documented Windows user
   locations and effective access controls, preserving Linux XDG behavior. Settings,
   database, artifacts and atomic replacement survive restart and interrupted writes;
   locked files produce useful errors rather than truncated data.
2. **Given** drive-letter, UNC, spaced, Unicode and long-path fixtures, **when** I use
   directories, search, pins, repository identity, previews or path:line:column links,
   **then** the correct file is addressed. Test case handling, CRLF, junctions, symlinks
   and traversal boundaries; unavailable network paths cannot hang the UI.
3. **Given** attachments, clipboard images and published files, **then** preview,
   Open, Show in Folder, Save As and addressed delivery retain hashes, bounds and
   no-Enter rules. Backup export/verification succeeds with existing exclusions.
   Cross-OS backup verification does not imply a new restore or automatic path migration.

**Starting points:** utility file-reference/artifact/database/backup modules,
main file dialogs, renderer path links and `bin/safe-config-write.mjs`.
**Verification:** real Explorer/dialog flows, bounded path-security fixtures,
restart and backup verification on both OSes.

### Story 53.4: Reach BMN from Native Windows Commands

As an agent running on Windows, I want the `bmn` command available in my session,
so that I can report progress, publish files and request attention safely.

**Coverage:** W-FR4. **Depends on:** 53.3.

**Acceptance criteria:**

1. **Given** native PowerShell/cmd sessions, **when** they invoke the packaged or
   development `bmn` launcher, **then** all existing CLI commands retain their payload,
   stdin, exit-code and JSON contracts without a Unix shebang or external Node install
   being required by the unpacked package from 53.1. Choose the Windows launcher
   form from measured argument fidelity; test quotes, `%`, `^`, `&`, backslashes,
   Unicode and multiline stdin through the real launcher. Full installer proof is
   repeated in 53.11/53.13. Replace or scope the Bash-specific `codex`/`bmn-bashrc`
   resources so native sessions never try to execute a Unix launcher.
2. **Given** the Windows control transport, **then** use a Windows-local mechanism
   such as named pipes with verified access restrictions and existing token checks.
   Preserve owner/session boundaries, incarnation checks, size limits and idempotency;
   another user, wrong token or stale run cannot issue privileged operations.
3. **Given** disconnect, reconnect or app restart, **then** cleanup and endpoint
   discovery recover without deleting another app's endpoint or replaying uncertain
   input. Preferences shows actual transport readiness without exposing tokens.

**Starting points:** `apps/desktop/bin/bmn`, packaged CLI resources,
`utility/control-server.ts`, `control-auth.ts` and `transport.ts`.
**Verification:** native CLI-to-running-app flows plus denied cross-session/user
requests; preserve the Linux Unix-socket security tests.

### Story 53.5: Work inside a Chosen WSL2 Distribution

As a Windows user, I want an integrated WSL session, so that Linux-based agent tools
work inside the Windows desktop application.

**Coverage:** W-FR5. **Depends on:** 53.4.

**Acceptance criteria:**

1. **Given** installed WSL2 distributions, **when** I select one, **then** BMN records
   and shows the distribution, Linux shell and Linux directory. Start/resume use that
   exact environment; missing WSL or a removed distribution produces an actionable
   error and leaves native Windows sessions usable.
2. **Given** a WSL session, **then** `bmn` commands, scoped identity and file publication
   work across the boundary through a reviewed authenticated local bridge. Prefer
   a per-session stdio relay to the native transport; document the measured design
   before implementation. Do not add an unauthenticated or externally bound listener.
   State whether the WSL CLI uses a runtime installed inside the distribution or
   Windows executable interop; document prerequisites and test scoped credential
   propagation without copying the owner token or exposing it in command arguments.
3. **Given** Linux and Windows paths or two distributions with matching paths/PIDs,
   **then** mapping includes distribution identity, cannot escape authorized file
   roots, and delivers usable paths to the named destination. Ambiguous mappings fail
   explicitly. Stop affects that session's process tree, never the whole distribution.
4. **Given** a graphics-enabled WSL session, **then** install and resolve the Sixel
   terminfo entry inside that distribution's Linux environment. Test actual lookup;
   a file present only in the Windows app's data root does not satisfy this criterion.

**Starting points:** the launch, process, path and transport adapters from 53.2–53.4.
**Verification:** real WSL2 session with `bmn` calls and file delivery, two-distribution
isolation fixtures, disconnect/shutdown and native-session coexistence.

### Story 53.6: Keep Existing Agent Integrations Working

As a Windows user, I want BMN's agent integrations in their supported native or WSL
environment, so that I retain attention, conversation resume and history controls.

**Coverage:** W-FR6. **Depends on:** 53.5.

**Acceptance criteria:**

1. **Given** Claude Code, Codex, OpenCode and Cursor terminal-agent installations,
   **then** record supported versions and native/WSL routes. Validate executable
   discovery, launch templates/sets, environment isolation and exact resume commands.
   An upstream native limitation needs a verified WSL route, not a false support label.
2. **Given** hook checking/installation, **then** choose the correct environment's
   configuration and launcher syntax; show target/diff, require the existing consent,
   preserve unrelated entries, and retain backup/atomic-write behavior. Actual hook
   events must prove attention, conversation binding, model identity and compaction.
3. **Given** usage reporting, configured retention and cleanup, **then** read only the
   correct environment's stores, preserve current source/uncertainty labels and use
   supported harness cleanup commands. In-use conversations stay protected; activation
   remains explicit. Existing upstream unsupported features remain clearly identified.

**Starting points:** utility harness adapters, hook configuration, conversation binding,
agent history and usage; `apps/desktop/bin` launchers/plugins.
**Verification:** disposable harness profiles and synthetic history fixtures, plus
actual installed CLI hook/resume checks. Record unrun provider checks as UNVERIFIED;
do not copy credentials or delete the owner's history.

### Story 53.7: Use the Complete Terminal and Desktop Interface

As a Windows user, I want the existing keyboard, graphics and workspace experience,
so that Windows support does not remove everyday BMN features.

**Coverage:** W-FR7. **Depends on:** 53.6.

**Acceptance criteria:**

1. **Given** native and WSL terminals, **then** test Unicode, multiline paste, selection,
   OSC 52 writes, mouse reporting, shell/TUI keyboard input and the send-next-key route.
   Windows clipboard behavior must not depend on Linux primary selection; clipboard
   reads remain forbidden. IME/AltGr input is not consumed as an app shortcut.
2. **Given** an actual Sixel producer, **then** prove graphics reach xterm and remain
   correct through resize/split/repaint, and preserve the text-only saved-output
   contract. Measure any ConPTY limitations and supply a tested Windows route;
   disabling graphics throughout Windows is not parity.
3. **Given** normal and scaled displays, **then** all themes, panes, focus mode, search,
   recent sessions, collapsed rows, Preferences, Files, Needs you, progress/results
   and handoffs remain keyboard accessible. Preserve explicit targets, single live
   terminal views, unsent input and paste-without-submit behavior.

**Starting points:** renderer terminal/view/keymap, file, attention and workspace
components; utility graphics handling. **Verification:** live native/WSL shell and
TUI fixtures, visual evidence at 100%, 150% and 200% scaling, clipboard/IME checks,
and the corresponding Linux flows.

### Story 53.8: Dictate Locally on Windows

As a Windows user, I want local voice dictation, so that I can enter text with the
same privacy and review-before-submit behavior as Linux.

**Coverage:** W-FR8. **Depends on:** 53.1, 53.2 and 53.5.

**Acceptance criteria:**

1. **Given** a Windows build, **then** build/package the pinned whisper engine and
   speech detector with their Windows runtime dependencies and correct executable
   paths. Any binary distributed from CI or another computer uses a documented
   portable CPU baseline, not the current host-tuned `GGML_NATIVE=ON` build. Verify
   transcription/detection on a supported CPU distinct from the build machine and
   record required instructions/runtime libraries. Local-only tuning, if retained,
   must not leak into distributed artifacts. Model download, checksum validation
   and custom folder handling retain limits.
2. **Given** microphone access granted, denied, missing or interrupted, **when** I
   use Hold Space, Speak or the shortcut, **then** recording/transcription or the
   failure is clear; the microphone closes afterwards. Voice stays local.
3. **Given** a native or WSL destination, **then** vocabulary/language settings work,
   silence pastes nothing, and transcription reaches only the addressed current run
   without Enter; cancellation or a stale destination never writes into another run.

**Starting points:** `scripts/voice/build-whisper.mjs`, main voice engine/IPC and
renderer voice components. **Verification:** real Windows microphone and packaged
engine, denial/cancel fixtures and Linux voice regressions.

### Story 53.9: Receive and Answer Attention on Windows

As a Windows user, I want native notifications and Telegram integration, so that
I can respond to the correct session while away from the application.

**Coverage:** W-FR9. **Depends on:** 53.1 and 53.4–53.6.

**Acceptance criteria:**

1. **Given** a background request, **then** Windows desktop notification identity,
   activation and idle-time policy behave as documented; clicking reveals the exact
   session. Disabled OS notifications and unavailable idle readings fail honestly.
   Use the unpacked app and an isolated shortcut/application-identity registration
   fixture for this story; verify the final installer-created identity again in 53.11.
2. **Given** Telegram enabled through the owner's existing opt-in settings, **then**
   cards, choices, Other, multi-select, Back, drafts, direct typing and supported
   permission replies preserve sender, request, conversation and incarnation checks
   in native and WSL sessions. A sent answer is not called confirmed without evidence.
3. **Given** sleep/resume, reconnect, duplicate callback, restart or a stale prompt,
   **then** no answer is replayed or sent to the active pane by inference. Credentials
   remain owner-only, and current remote authority/unsupported prompt limits remain.

**Starting points:** main notification/idle integration, utility Telegram and remote
answer paths. **Verification:** Windows desktop activation and synthetic callback
fixtures; an explicitly authorized phone-to-agent test on the unpacked candidate.
Repeat the installed-release notification/phone path at 53.13.

### Story 53.10: Find the Development Ports of My Session

As a Windows user, I want per-session development-server links, so that I can open
my application without guessing which process owns a port.

**Coverage:** W-FR10. **Depends on:** 53.2, 53.4 and 53.5.

**Acceptance criteria:**

1. **Given** native and WSL child/grandchild servers, **then** attribute listening
   ports to the correct session using verified process ownership and distribution
   identity, replacing Linux `/proc` assumptions at the platform boundary. For WSL,
   prefer executing the existing bounded Linux scanner inside the named distribution
   when it meets the same ownership/security contract.
2. **Given** PID reuse, unrelated processes, denied reads or stale scans, **then**
   show only attributable current results and fail closed on unknown ownership;
   polling stays bounded and cannot block input or require administrator access.
3. **Given** a port link, **when** opened, **then** the Windows browser reaches the
   correct server, including tested WSL forwarding behavior. Closing a server removes
   its stale link. Inspecting ports never kills processes or changes firewall rules.

**Starting points:** `utility/listening-ports.ts`, `port-watch.ts`, process ownership
adapters and renderer session-port chips. **Verification:** simultaneous native/WSL
servers, unrelated-server isolation and actual browser navigation; Linux regression.

### Story 53.11: Install and Update a Windows Release Safely

As a Windows user, I want an installable BMN build and safe updates, so that I can
use it without a development toolchain or losing my existing work.

**Coverage:** W-FR11. **Depends on:** 53.1–53.10 (all delivered capabilities).

**Acceptance criteria:**

1. **Given** a clean Windows build runner, **then** produce a per-user installer
   containing all required Electron/native/voice/CLI resources, icons and shortcuts.
   A standard-user machine without Node, pnpm or a compiler can run it. Native use
   does not require WSL; its installation is a separate documented prerequisite.
2. **Given** an existing installation and data, **when** an explicit update is requested,
   **then** wait for BMN to exit, stage and validate the candidate, preserve data,
   and keep a recoverable previous version on failure. Windows file locks, interrupted
   updates and incompatible data migrations cannot silently destroy a working setup.
3. **Given** uninstall/reinstall, **then** retention or removal of user data is explicit.
   Document package authenticity, signing status and any OS trust prompt honestly;
   do not require disabling security controls. Signing purchases, public publication
   and automatic network update checks require a separate owner decision.
4. **Given** Linux packaging/update, **then** retain its close-before-replace and failed
   smoke preservation guarantees. Platform-specific commands must not invoke systemd,
   GNOME or `.desktop` tooling on Windows.
5. **Given** a Windows contributor using a source checkout, **then** document and
   implement the Windows equivalents of the local desktop install/update route:
   explicit request, persistent queued work, wait for exit, clean intended commit,
   staged smoke, preserved previous build, refreshed launcher and completion notice.
   This complements the per-user installer; it does not add automatic network updates.

**Starting points:** `apps/desktop/electron-builder.yml`, package commands,
`scripts/lib/packaged-app.mjs`, staged-build, packaged smoke and installer scripts.
**Verification:** clean Windows install, normal launch, upgrade, injected update failure
and uninstall/reinstall with synthetic data; corresponding Linux packaged checks.

### Story 53.12: Check Every Future Change on Both Operating Systems

As a contributor, I want automated checks and a shared completion rule, so that
developing on one computer does not regress the other supported OS.

**Coverage:** W-FR12. **Depends on:** 53.11.

**Acceptance criteria:**

1. **Given** a pull request, **then** Linux and native Windows CI install pinned
   dependencies and run lint, typecheck, unit/integration checks, build, real Electron
   startup/affected acceptance tests, packaging and packaged smoke. Use isolated data;
   do not weaken sandboxing or grant untrusted PR code release secrets.
2. **Given** OS-specific fixtures, **then** shared behavior runs on both platforms and
   platform behavior gets dedicated equivalent coverage. Replacing the entire Windows
   suite with skips, or testing Windows only inside WSL, cannot satisfy the checks.
3. **Given** a new feature/fix after this epic's acceptance, **then** its pull request
   states Linux/Windows impact, changed-flow results and any manual Windows checks.
   Both platforms must pass before completion/merge; missing evidence stays open.
   WSL-affecting changes require WSL checks. Documentation-only changes need appropriate
   documentation validation, not unrelated runtime suites.
4. **Given** project documentation and agent instructions, **then** both Claude Code
   and Codex receive the same rule. Keep one main branch and short task branches;
   nominate Windows validation responsibility without making every change wait for
   the same person. Configure required CI checks when repository-admin access is
   authorized; unavailable enforcement remains an explicit acceptance blocker.
   The existing instruction to update the Linux desktop after a main push describes
   post-push behavior; it does not authorize bypassing pull requests or required
   checks. Keep that behavior while requiring checks before merge. Use included CI
   capacity or an already authorized runner; enabling paid overages or new paid
   infrastructure needs separate explicit approval, not an assumed planning budget.

**Evidence that counts after acceptance:**

| Change | Required evidence |
| --- | --- |
| Shared logic or renderer behavior | Passing relevant checks and affected-flow execution in real Electron on Linux and native Windows; Windows CI execution counts |
| PTY/process, path/security, transport or WSL behavior | Automated platform checks plus the affected OS-boundary flow on the supported Windows setup (WSL where affected); Linux regression evidence |
| Voice, notifications, clipboard/IME/scaling or installation/update | Automated coverage plus the affected real-device/desktop/installed-app flow; CI cannot substitute for hardware or OS interaction it did not exercise |
| Documentation only | Link/content checks appropriate to the edit; no unrelated runtime suite required |

The collaborator or another maintainer with the required environment can supply
manual evidence. Reuse passing results for unchanged code on the same candidate;
unrelated features do not require repeating the entire manual parity checklist.

**Starting points:** `.github/workflows/` (new), existing test scripts, `AGENTS.md`,
contributor instructions and `docs/development.md`. **Verification:** actual CI runs
on both OSes; a controlled failing check prevents merge, then a corrected candidate
passes. Record runner coverage separately from real-machine/manual coverage.

### Story 53.13: Accept Full Parity on the Installed Applications

As the two maintainers, we want evidence from our installed applications, so that
we can adopt dual-OS development with confidence in the whole product.

**Coverage:** W-FR13 and final coverage of W-FR1–12. **Depends on:** 53.12.

**Acceptance criteria:**

1. **Given** one integration commit, **then** reconcile the entire current feature
   guide, README and merged epic contracts into a parity checklist covering Linux,
   native Windows and WSL routes. Include features merged during the port; map each
   row to a test, result, OS/tool versions and evidence location.
   Use the tracked checklist started in 53.1. A discovered gap reopens its owning
   story or gets a new scoped 53.x story and tracker/checklist entry before closure;
   it cannot remain an unowned follow-up while the epic is marked done.
2. **Given** installed packages from that commit, **when** Oleksandr checks Linux and
   his collaborator checks Windows, **then** exercise everyday multi-session work,
   files/handoffs, agent integrations, voice, notifications/Telegram, backups and
   update/restart. Real device/provider checks require their normal explicit consent;
   absent access leaves the relevant acceptance gate UNVERIFIED.
3. **Given** the completed checklist, **then** every required capability has a passing
   Windows route and Linux regression evidence. Open parity failures or unrun required
   checks keep Epic 53 open; no blanket waiver or “build passes” substitute.
4. **Given** acceptance, **then** update the public support/install/troubleshooting
   documentation with tested OS versions and native-versus-WSL routes; activate the
   dual-OS completion rule for all subsequent features/fixes, including remaining
   backlog stories. No retroactive reset of completed historical epics is needed.

**Verification:** both maintainers' installed-app results on the same commit,
passing CI and a complete requirement-to-evidence checklist. Planning this epic
does not establish that Windows support is implemented or verified.
