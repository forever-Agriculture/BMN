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
| Claude/Codex/OpenCode/Cursor hooks, history, usage, compaction, resume — 53.6 | Implementation team | Hook/config fixtures: 68 passed, one native-only skip; retained history/Companion: 204 passed, replacement and hardlink regressions original RED/current GREEN | Held-session command-line reader PASS natively (run 37312653316); Codex typed-shell launcher and revised ACL/home/history fixtures UNVERIFIED | UNVERIFIED |
| Terminal images, clipboard, IME/AltGr, scaling, panes, themes, keyboard access — 53.7 | Implementation team | UNVERIFIED | Actual creation form, renderer Sixel image, resize and continued input PASS; complete input/clipboard/scaling/pane acceptance open | UNVERIFIED |
| Microphone, local voice engine, cancellation, addressed paste — 53.8 | Implementation team | Portable speech/silence/transcription PASS | Portable/packaged engines and PE imports PASS; prior WAV ACL PASS, latest private-WAV inspector fails without OS cause (diagnostic pending); microphone/UI/other CPU UNVERIFIED | UNVERIFIED |
| Notifications, attention, Telegram replies and delivery diagnostics — 53.9 | Implementation team | UNVERIFIED | Shortcut seven ownership checks PASS; toast activation and complete reply matrix UNVERIFIED | UNVERIFIED |
| Per-session development port discovery and navigation — 53.10 | Implementation team | 498 affected tests PASS, one skip; scanner timeout original RED/current GREEN | Owned-job TCP attribution, two-session isolation, real Edge IPv4/IPv6 navigation and input/Stop six checks PASS run37230888519; renderer chips and complete story acceptance UNVERIFIED | UNVERIFIED |
| Per-user install, source updates, rollback, uninstall — 53.11 | Implementation team | Affected source tests/type/bundle PASS; Linux development startup PASS | Offline installer, versioned transaction, leases, snapshot, queue and uninstall implemented in source; isolated-smoke startup collision fixed and update windows ready in 1–2 s natively (run 37312653316); installed smoke/self-test and install acceptance UNVERIFIED | UNVERIFIED |
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

[Full ff7bb53 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37259993444) passed Linux 3,093 assertions with 36 skips; Windows passed 3,103 with 14 failures and 12 skips. The fourteen launcher obligations and two skipped POSIX socket equivalents remain open. The actual real-PTY exit-before-delete flow retains its prior native pass. This is not full-suite acceptance.

[Native ff7bb53 token evidence](https://github.com/forever-Agriculture/BMN/actions/runs/37259993387) retains the strict class-21 shape failure and incomplete metadata. Three fresh four-byte buffers on the same query-only handle returned success and length one: `00000000`, `00a5a5a5`, `005a5a5a`. Byte zero was written consistently while the poisoned tail remained. Handle closure and cleanup pass. A class-21-only length-aware decoder remains pending; other query shapes and process-measurement restrictions stay unchanged.

[Native ff7bb53 installer evidence](https://github.com/forever-Agriculture/BMN/actions/runs/37259993444) times out the untouched original app-query helper after 30,028 ms, then passes the separate explicit Utility/CimCmdlets preflight in 581 ms. Environment fingerprint, executable hash, ordered flags and command identities are bound; the observer injects no PowerShell into the original query. This supports a bounded sole-import candidate experiment, not installer acceptance or a helper-wide repair claim. The packaged artifact commit is the PR integration merge `de220d8c0066bc4f7f6229b3e8d666cbaeacae99`, with `ff7bb53` as its feature parent; relevant source blobs match the feature checkout and the observer runtime hash matches CRLF conversion.

[Native ff7bb53 WSL evidence](https://github.com/forever-Agriculture/BMN/actions/runs/37259993457) passes all six real nested lifecycle triggers with nine retained process handles per case, confirmed exit before fallback, unreused active UID lease, unrelated-sentinel survival, and disposable-registration removal. The private guest PTY returns exact Sixel bytes; the guest compiles and looks up its private terminfo with actual `tic`/`infocmp`. The sixth trigger is inner PTY hangup. Production helper and adapter remain unchanged: actual agents, general mediated egress, durable projects, scoped bridge, two distributions and native host behavior are **UNVERIFIED**, and `profileComplete` remains false.

Source-update crash-after-selection is reproduced with the actual source functions, transaction and sealed synthetic files: rebuilding the same commit can select another payload and repeat data inspection. Isolated full-descriptor/journal recovery and a selection guard under the installation lease pass nominal, seven uncertainty controls and original-RED/proposed-GREEN race checks. The tracked repair now records the full descriptor before activation, rechecks matching selection and an ordinary supported journal under the installation lease, and preserves recovery identity through validation/metadata/completion crashes and explicit legacy retries. Combined actual source/resume/worker/transaction checks pass with only native process/ACL/lease/database seams substituted. A dropped-forwarding-flag control detects the unsafe path; missing/completed-mismatch journal races and the legacy requeue guard are original **RED** / repaired **GREEN**. These are synthetic checks; native acceptance and preselection interrupted-build recovery remain **UNVERIFIED** and open.

The separate explicit Utility/CimCmdlets manifest preflight passes in 515 ms, including trusted manifest hashes, all five dependency identities, unchanged process selector and child exit. The instrumented installer then times out after 30,031 ms during command discovery before its original selector. This does not prove that the untouched selector fails. The next observer passes only the three exact, hash-fenced worker query sources/argv/options unchanged, with candidate/artifact/source/environment/exit provenance and explicit dropped-record failures. Actual-source unchanged-argv and primary-error guards fail on the original observer and pass with the delta. The original worker query now runs before explicit preflight to avoid cache-warming ambiguity; product CIM imports remain unchanged pending corroboration.

The next synthetic WSL slice retains real long-lived bubblewrap supervisors/root/child/grandchild across six triggers, uses a private inner PTY for exact Sixel bytes, and compiles/looks up the actual terminfo inside the guest. It reuses the existing candidate filter and PID mapper; original kernel/device/route guards stay prerequisites. Outer/inner syntax and fragmented protocol checks pass locally. Actual guest custody, UID maps, terminfo, hangup and cleanup remain **UNVERIFIED**. The production root helper and `profileComplete=false` remain unchanged.

A separate actual-function/sealed-synthetic-file crash discriminator confirms a source-update recovery defect: after selection but before durable source completion, resuming the same source commit rebuilds a different payload descriptor and repeats data inspection. Descriptor/journal reconciliation is required before claiming once-only recovery; its repair is still pending. Native GUI/update/uninstall acceptance is open.

[Full 17a00a4 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37249637688) passed Linux 3,084 assertions with 36 skips; Windows passed 3,093 with 15 failures and 12 skips. Actual bundled-Electron physical-ASAR checks and all nine exact-one isolated observations passed their original deadlines, including the smoke environment at 4,268 ms. The full inventory still fails: fourteen Linux launcher obligations need native equivalents, and the synthetic real-PTY reply test fails during fixture directory removal with EPERM. Two skipped POSIX socket cases also need complete Windows equivalents. Passing isolated observations do not waive inventory failures.

The installed slice passed physical payload validation and ten private-directory operations, then timed out after 30,028 ms while resolving `Get-CimInstance` with module autoloading. No installed GUI check completed. The next diagnostic runs explicit trusted Utility/CimCmdlets manifest imports and the unchanged process selector in a separate owned PowerShell process with the exact controlled installer environment. Its receipt and the original installer's outcome stay separate; no product import repair or installer PASS is inferred.

[Native 17a00a4 PTY evidence](https://github.com/forever-Agriculture/BMN/actions/runs/37249637689) identifies `TokenElevation` class 20: NULL/zero sizing returns required size four and Win32 error 24. The current token handle closed successfully; no tokens were created or privileges enabled. The next query uses initialized fixed four-byte scalar buffers, strict returned lengths, and pointer-sized existing linked-token lookup, preserving TOKEN_QUERY rights and variable-size queries. C# 5 compilation and 12 scalar/five linked-shape and cleanup shim cases pass locally; actual Windows metadata acceptance remains **UNVERIFIED**.

The independently attempted CLI slice passed all ten command provenance checks, 80 substitution controls, original OEM/fixed UTF-8 stdin discrimination and controller-crash cleanup. It then correctly refused a 36,096-character encoded controller at the unchanged 32,767-character guard. All six call sites now use private, canonical, exclusive UTF-8-BOM script files and literal `-File` argv through the same backstop. All seven generated scripts preserve exact bytes/hash and pass the original guard locally; collision, link, tamper and protection-refusal tests pass. Native ACL, execution policy, full process matrix and Bun remain **UNVERIFIED**; execution policy and guard limits are unchanged.

The real-PTY fixture now observes exit immediately after spawn, stops pending writes, awaits bounded exit and attempts all cleanup before directory deletion. Its actual Linux fake-bot/PTY reply flow passes within the original 30-second budget. A separate standalone two-PTY probe aborts during parent shutdown on both unchanged and current callers; that gate remains FAIL and is not repaired or dismissed here. Native onExit-before-delete and the filesystem-lock cause remain **UNVERIFIED**.

[Full 302159e inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37247315883) passed Linux 3,080 assertions with 36 skips; Windows passed 3,088 with 16 failures and 12 skips. All eight isolated observations executed exactly one intended assertion and passed their original deadlines: five release-data, two backup and the Claude history symlink write. The corrected raw OpenCode reference assertion also passed (654 ms), closing its inventory key without changing the client. Fourteen Linux launcher obligations and two skipped socket cases still need complete native equivalents. The new physical-ASAR test reaches link refusal then fails while removing a Windows directory junction; a separate smoke-environment test exceeds five seconds. Neither failure is waived.

The real installed slice now passes physical ASAR validation and reaches a PowerShell operation failure before its first completed check. Its exact installer stage and API error remain unconfirmed; no successful installed GUI flow is claimed. [The native PTY run](https://github.com/forever-Agriculture/BMN/actions/runs/37247315829) passes prior owned-tree checks, then the read-only token metadata probe fails with Win32 error 24 during an unidentified query. No token creation, privilege enablement or process measurement occurred. The metadata failure stops the independent PowerShell/CLI/Bun observations, which remain UNVERIFIED. A bounded consultant-guided diagnostic will identify query class, buffer phase and installer substage while retaining overall failure.

[Full c699625 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37243078764) passed Linux 3,074 assertions with 36 skips; Windows passed 3,082 with 16 failures and 12 skips. The five release-data cases and two backup cases completed within their original five/thirty-second limits; the next candidate restores those limits. All seven isolated observations accidentally skipped their targets because Vitest's runner hierarchy uses ` > ` while its JSON names use spaces. They establish no isolated acceptance. The corrected route has actual old-zero/current-one execution proofs for the data and backup families and refuses skipped-only, duplicate, wrong-file, wrong-name and over-deadline reports. The new Claude history link-write timeout remains unexplained and gets named stage observation with its original five-second gate retained.

The actual installed-launcher slice failed before staging: Electron's `node:fs` expands `app.asar` into a virtual directory, so its physical release manifest disagrees. The next scoped adapter uses Electron's built-in `original-fs` for physical payload validation/copies, preserving the module loader. Real Electron 44.3.0 emitted-CJS original RED/current GREEN, byte-equal stage/bootstrap, archive-loader preservation and corruption/link/hardlink/name refusal checks pass locally; native installation remains unverified. Both fresh-target owner controls passed natively. The raw CLI diagnostic stops before connection construction because the test's hyphenated pipe UUID triggers the client's endpoint-file fallback; an exact production-function discriminator proves the fixture-format difference. The client implementation and deadlines are unchanged.

[Native c699625 command metadata](https://github.com/forever-Agriculture/BMN/actions/runs/37243078616) recorded all ten dependencies. The prepared predicate requires the measured command source/type, assembly identity and exact GAC path, exact permitted module base, and ten unique names, with original/current and 80 substitution controls before native process/Bun flows. Strong-name metadata is not independent signature verification. Actual amended PowerShell/process/Bun results remain unverified. A separate read-only token-metadata probe is prepared; no token creation, privilege enablement or WMI launch is authorized by that probe. Fourteen Linux launcher obligations still need complete native equivalents.

[Full 111b522 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37234066390) passed Linux 3,045 assertions with 36 skips; Windows passed 3,048 with 21 failures and 12 skips. Fourteen Linux launcher obligations remain open. New metadata identified the reader's second physical-folder rename as EPERM before replacement, the config writer's failure as `prepare:original-open`/RuntimeException, and the hook child as connected without bytes until the 15-second watchdog. Two additional named installer cases exceeded five seconds; a host-only BPF test attempted to import Linux `fcntl` on Windows. These are captured failures, not waived acceptance.

[Full 6bbbd47 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37237884419) passed Linux 3,056 assertions with 36 skips; Windows passed 3,058 with 22 failures and 12 skips. All 14 native reader assertions passed, with one Linux-only FIFO skip. The immutable original/current junction retarget discriminator passed, as did inaccessible-metadata classification and unchanged-handle read denial. The reader key is removed from the open list; Explorer/dialog and complete file workflows remain unverified. The config writer correctly refused a fresh Administrators-owned target at `prepare:original-owner`; its two synthetic targets require existing fixture-owner setup, without changing production refusal. PowerShell diagnostics confirmed Utility ModuleBase is PSHOME; all dependency metadata is collected before any predicate repair. The raw Node-pipe diagnostic stopped at a CRLF extractor guard, which is now original RED/current GREEN locally. Native pipe/Bun behavior remains unverified.

Astra agreed transactional release-data seeding and separate real-file backup stage observations. Local original/amended SQLite schema and data match at versions 22–24. Five data and two backup cases pass locally; Windows results are pending. Named 30/60-second Windows diagnostic ceilings preserve original five/thirty-second limits in receipts and the inventory gate. Exact-name isolated observations run serially after preserving full inventory and exit status. An observation over its original deadline cannot count as full-suite acceptance. Fourteen Linux launcher obligations remain open; a prepared native installed slice exercises the real sealed payload, stable launcher, GUI, queued forwarding, literal argv, Quit and stateful restart. Its runtime and the broader update/notice/shortcut matrix remain unverified.

[Full b70 inventory](https://github.com/forever-Agriculture/BMN/actions/runs/37230888388) passed Linux 3,037 assertions with 36 skips; Windows passed 3,042 with 19 failures and 12 skips. Native build/startup/packaging passed. Failures remain owned and unfinished: fourteen Linux launcher fixtures require evidenced Windows equivalents, two source-drift transaction deadlines, two hook cases, and the reader's second folder-swap fixture. Its first native File.Replace assertion passed. The next candidate records bounded stage/identity and pipe/child metadata before any unproved product repair.

[Native fixture run 37230888519](https://github.com/forever-Agriculture/BMN/actions/runs/37230888519) on `b70d2d8` passed six owned-port/actual Edge navigation checks, seven installer lease checks, seven shortcut checks and the isolated durable queue assertion. The CLI discriminator proved original OEM stdin decoding misaddressed the Unicode path and explicit UTF-8 preserved exact code units/file existence. Its subsequent process-ownership controller failed because `Join-Path` was unavailable with module discovery disabled. Ownership/Bun acceptance remains UNVERIFIED. The next consultant-agreed fixture method explicitly imports the trusted Management module, verifies command provenance, attempts every retained-handle cleanup and keeps an outer backstop alive through all original/fixed observations. Its native execution is pending.

The next fixture candidate assigns 30 seconds only to thirteen named Windows source
transactions, including the four source-drift cases, retaining Linux's five-second budget; the concurrent-worker fixture
has a 30-second Windows watchdog, cancelled after completion. The native CLI gate
compares original and explicit UTF-8 stdin decoding by code units before writing,
and refuses to proceed unless the original failure and corrected path both reproduce.
The reader fixture uses the documented [NullString sentinel](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring?view=powershellsdk-7.4.0)
for a CLR null backup pathname. One synthetic Telegram retry case uses a controlled
clock so thirty intended milliseconds cannot exhaust two 100-millisecond retries.
No product deadlines, cleanup requirements or retry limits are relaxed. Native
results remain pending; the two unexplained hook cases retain diagnostic errors.


[Native renderer run 37226566647](https://github.com/forever-Agriculture/BMN/actions/runs/37226566647)
passed the actual session creation form, literal Arguments field, native shell and
npm argv/cwd/env/TTY cases, labelled batch creation/editing, and a retained Sixel
image through ConPTY to xterm. The image remained visible after resize and the
terminal accepted subsequent input. The screenshots and `windows-launch.json`
corroborate the receipt. Clipboard, IME/AltGr, scaling and multipane acceptance
remain open; this does not close story 53.7.

[Lease/shortcut/queue run 37228701415](https://github.com/forever-Agriculture/BMN/actions/runs/37228701415)
retained all seven private lease checks and passed all seven native shortcut
checks, including refusal of a different hardlink pathname. The existing durable
source queue case passed all assertions with a diagnostic 30-second deadline:
7.424 seconds inside the test, 8.242 seconds including process startup. Its normal
five-second Windows fixture deadline is below that measured passing duration.
The workflow then failed in the Unicode CLI fixture at `Process.Start`; CLI
ownership/Bun acceptance remains open. Product timeouts and security checks are
unchanged. The full inventory remains a failing gate.


[Native packaging run 37215902456](https://github.com/forever-Agriculture/BMN/actions/runs/37215902456)
verified the repaired hook paths and generated-output lint boundary, unpacked and
offline NSIS packaging, and packaged startup. Actual installed update/uninstall
transactions remain UNVERIFIED.

[PowerShell diagnostic 37218918822](https://github.com/forever-Agriculture/BMN/actions/runs/37218918822)
isolated a `New-Object` constructor hang under the synthetic lease worker's minimal
environment: direct .NET construction with the same input-encoding setter and
stdin completed in 205 ms. Commit `3ededb0` replaces typed constructors at 48
sites. [Follow-up 37222257505](https://github.com/forever-Agriculture/BMN/actions/runs/37222257505)
still timed out during complete private-directory provisioning; the constructor
control does not establish full lease/ACL acceptance. Further diagnosis remains open.

[WSL measurement 37222257506](https://github.com/forever-Agriculture/BMN/actions/runs/37222257506)
retained all six root-helper cleanup and broker/UID/ABI checks. Its new nested
namespace experiment failed a source-match assertion before reaching the kernel:
the Windows checkout supplied CRLF. The fixture repair has an original-RED/current-
GREEN regression that constructs all four candidates without running namespaces.
Native nested sandbox acceptance remains UNVERIFIED; the production helper policy
is unchanged, and the disposable distribution was removed.

[Follow-up 37223295411](https://github.com/forever-Agriculture/BMN/actions/runs/37223295411)
passed Core commands and explicit Utility module import under three controlled
environments. Automatic `ConvertFrom-Json` discovery timed out in each; disabling
autoload failed promptly, and the full helper trace stopped at its JSON conversion.
An explicit-import/full-helper comparison is prepared; no additional product fix
has been inferred from the import-only control.

[WSL follow-up 37223295371](https://github.com/forever-Agriculture/BMN/actions/runs/37223295371)
reached the kernel after the CRLF repair: only amended-filter plus `pivot_root`
created the nested user namespace. It then failed opening `/proc/self/setgroups`.
The next synthetic probe measures proc ownership and dumpability before enabling
its own mapping-file access; the production helper remains unchanged.

[Run 37222257544](https://github.com/forever-Agriculture/BMN/actions/runs/37222257544)
was superseded and cancelled during packaging. Its collected Windows startup,
persistence, single-instance, real CLI and lifecycle receipts passed; its inventory
recorded 3,026 passed, 31 failed and 12 skipped tests. The graphics producer was
live, but direct IPC creation had not adopted its attachment into the renderer;
the captured screen showed a session summary instead of a terminal. The fixture
now uses the actual creation form and waits for keyboard input before emitting an
image. Native graphics acceptance remains UNVERIFIED.

[Discriminator 37224203329](https://github.com/forever-Agriculture/BMN/actions/runs/37224203329)
reproduced the original full-helper timeout at 15 seconds, then completed the same
request and security checks in 423 ms after explicitly importing the OS Utility
module with automatic module loading disabled. The implemented repair applies that
trusted import to privacy/config helpers and the corresponding installer/ACL
fixtures. Complete native lease and updated config/installer checks remain pending.

[Kernel measurement 37224203306](https://github.com/forever-Agriculture/BMN/actions/runs/37224203306)
passed all four discriminator cells. Only amended-filter plus `pivot_root` permitted
nested user namespaces; its single-UID mapping and private mount worked. Extra UID
mappings, writable tool remounts, outside brokers and inspection syscalls remained
denied, with `no_new_privs` retained and the old root detached. The synthetic probe
measured dumpability zero and root-owned proc mapping files after the UID drop;
enabling dumpability changed their owner to the leased UID and enabled the positive
control. This matches the documented [proc ownership effect](https://man7.org/linux/man-pages/man7/user_namespaces.7.html).
This is a kernel prototype result, not real agent sandbox or full WSL acceptance;
the production helper policy is unchanged and the disposable distribution was removed.

[Native lease flow 37225334942](https://github.com/forever-Agriculture/BMN/actions/runs/37225334942)
passed all seven checks after the Utility repair, including cross-process leases,
crash release, foreign/hardlink refusal and the complete ACL scan with locks held.
Private-folder operations completed in 443 and 400 ms. The workflow then failed
creating/verifying its synthetic shortcut with HRESULT `80004005`; the next
diagnostic distinguishes target-path normalization from application identity.
Shortcut/installed acceptance remains open.

The next graphics fixture repair uses Windows argument quoting instead of JSON in
the Arguments field and awaits resolved IPC readiness. An isolated sandboxed
Chrome page reproduced the original Playwright waiter returning `false` after one
call; the replacement retries and returns `true` after three. Three tests also
cover eventual session records, hung evaluation and surfaced errors. The same
asynchronous wait pattern is repaired in Epic 53 startup and lifecycle fixtures.
Native renderer graphics acceptance is still UNVERIFIED.

[Shortcut discriminator 37226566813](https://github.com/forever-Agriculture/BMN/actions/runs/37226566813)
found the correct AppID and empty arguments, but the Shell expanded `RUNNER~1`
to `runneradmin` while the verifier compared the literal input. The repair compares
both targets using [GetLongPathNameW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew),
fails closed on conversion errors, and preserves exact path and AppID ownership
checks. The native gate adds a distinct-hardlink-path refusal alongside the
foreign, missing/conflicting AppID, malformed and directory refusals. Compile and
repaired native acceptance are pending.

[Inventory 37225334978](https://github.com/forever-Agriculture/BMN/actions/runs/37225334978)
passed Linux's 3,034 tests with 36 skips; Windows recorded 3,029 passed, 29 failed,
12 skipped. Source-update cases still exceeded their five-second fixture deadlines
(observed failed-test durations 6.4–20.6 seconds). One existing durable queue case
will run separately with a diagnostic deadline and exact assertion-count check;
inventory deadlines and product timeouts remain unchanged pending that measurement.
The reader fixture now preserves its native replacement error directly in the
unit report instead of replacing it with an opaque outer assertion.

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

The actual [111b522 WSL experiment](https://github.com/forever-Agriculture/BMN/actions/runs/37234066506) passed all four kernel cells but bubblewrap 0.9.0 failed to create its NETLINK_ROUTE socket. The owner explicitly approved a disposable synthetic exception for `socket(AF_NETLINK, SOCK_RAW, protocol=0)`, including only the standard CLOEXEC/NONBLOCK type flags. This expands rtnetlink operations within the private network namespace; it is not a loopback-only message permission. The candidate requires root-created namespace ownership, no inherited network/namespace descriptors, only loopback topology, denial of other protocols/types, existing broker/UID/ABI/lifecycle guards and unchanged bubblewrap execution. The [6bbbd47 WSL experiment](https://github.com/forever-Agriculture/BMN/actions/runs/37237884374) passed all seven routing/namespace/descriptor/type/protocol checks and all four kernel cells. Actual bubblewrap then failed because its expected generic `/dev/full` was missing. Astra agreed a synthetic-only six-device setup with exact character-device identities before/after isolation, trusted-child session detachment before UID drop, nonterminal pipe/null stdio, denied controlling-terminal access, ENOSPC semantics and bounded random read. All probe descriptors close before unchanged bubblewrap argv; executable and payload hashes are recorded. Twelve device-substitution controls are original RED/current GREEN and 47 receipt checks pass locally. The [c699625 WSL run](https://github.com/forever-Agriculture/BMN/actions/runs/37243078649) passed actual non-setuid bubblewrap 0.9.0 execution, all twelve route/device/stdio controls, the nested UID/NNP/capability/broker/workspace checks and all four kernel cells. The root helper's six cleanup modes remain passing and the disposable registration was removed. Nested-agent lifecycle, general egress, durable projects, scoped relay and actual PTY/native-host acceptance remain unverified; profileComplete stays false. Production helper and owner distributions remain unchanged.

The next synthetic kernel candidate adds actual non-setuid bubblewrap execution in the restricted helper, verifies a single leased UID mapping, distinct namespaces, no new privileges, zero final capabilities, private project writes and outside-broker/syscall denial. Its narrowed filter rejects cgroup/time namespaces and parent/ptrace clone flags while permitting the measured descendant sandbox namespaces. The exact compiled filter fails the original flag guards and passes the current guards; 32 receipt checks pass locally, including rejection of kernel-only or incomplete sandbox proof. Actual WSL execution remains UNVERIFIED, and the production helper is unchanged. A bubblewrap result alone will not establish agent, egress, durable project, bridge or lifecycle parity.

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

### Session protocol (preparatory, Linux only)

The first slice of the consultant-agreed WSL plan fixes the wire format before any adapter: [WSL session protocol](wsl-session-protocol.md). Frames carry a version, a channel and a length, so terminal bytes are never read as control. The launch message is versioned and validated field by field; credentials are refused in its environment. A session state machine runs on each side, and a receipt is complete only with a matching `ready` and an `exit` whose cleanup is confirmed. The native side (`scripts/lib/wsl-session-protocol.mjs`) and the guest side (`scripts/lib/wsl-session-protocol.py`) meet the same hand-written vectors under every split of the input (`scripts/tests/wsl-session-protocol.test.mjs`): 39 launch cases, 7 frame encodings, 10 malformed streams, 16 guest and 18 native session runs. Seven deliberate defects each failed the tests: the environment allowlist off, terminal bytes parsed as control, a receipt complete without confirmed cleanup, frames dropped before a format error, a foreign nonce accepted, end of input treated as an abort while running, and `..` allowed in paths. Nothing here runs WSL, root or a relay; WSL behavior, ConPTY transport and the two-registration checks remain **UNVERIFIED**, and `profileComplete` stays false.

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

The next native method is diagnostic-only: invoke all three actual original helper variants once, a separate explicit positive, then three sole-CimCmdlets-import candidates. Exact-source hash fences preserve source/argv/options and bind artifact, module, environment, executable and exit identity. Selected-app observation uses ordinary private synthetic selection metadata so it reaches the actual CIM branch; mapped-engine observation is exported from the complete actual helper module without invoking uninstall. The finite collection deadline is 230 seconds, inside the existing controller budget. Original failures remain failures even if candidate helpers pass; production CIM imports and installer acceptance are unchanged.

The class-21-only decoder retains a four-byte allocation and separately tracks returned bytes. It reads only a canonical byte for returned length one, or the full DWORD for returned length four. Three fresh seeded buffers on the same existing query-only handle reject missing, partial or inconsistent declared writes. Thirty-nine exact-source C# 5 native-query-seam checks pass, including original **RED** / repaired **GREEN** and unchanged scalar/pointer/variable guards. Actual native metadata completion and ownership remain **UNVERIFIED**.


[Native c7cec2f collection](https://github.com/forever-Agriculture/BMN/actions/runs/37264964376) finished five workflows PASS and build FAIL. Linux passed 3,119 assertions with 36 skips; Windows passed 3,124 with 19 failures and 12 skips. Fourteen failures retain their assigned launcher obligations; five new synthetic worker-integration failures occurred before the global lease because a graph-wide process mock captured Windows protected-config operations. These five are unwaived and have no expected-failure entries. The repair restricts mocking to the exact resolved worker importer; protected configuration uses its actual subprocess implementation.

[Native token metadata](https://github.com/forever-Agriculture/BMN/actions/runs/37264964386) now completes with successful cleanup. Three class-21 queries each requested four bytes, returned one, and decoded false consistently. The observed runner token is elevated/admin with integrity RID 12288; linked lookup returns Win32 code 1312. This proves current-token metadata collection, not a usable standard token or broker ownership. `processMeasurementAllowed` remains false and ownership remains **UNVERIFIED**; the WMI process-launch gate is unchanged and unrun.

The finite actual-helper CIM experiment retains original app/selected-query timeouts of 30,028/30,241 ms and a successful mapped-engine original at 24,480 ms. The separate explicit positive passes in 506 ms. Three sole-import candidates pass in 318/332/334 ms, with matching environment, executable, flags, default buffer semantics and exit receipts; all return count zero. The tested integration commit is `3926091195dad7a34335bc7caa90d3e071e67483`, with feature parent `c7cec2f`; relevant source blobs and CRLF-sensitive worker/observer/fence hashes match. This is scoped repair evidence, not reliability, populated-output coverage or confirmed autoload causation.

The production helper now contains the exact measured trusted CimCmdlets import, retaining query bodies and budgets. The original/candidate pair remains a regression harness: removing exactly that import reconstructs the original source. A separate native installer gate will exercise the actual current production helper, independently verify command metadata, and then run actual installer/GUI assertions. Historical original failures remain failures; current installer acceptance is **UNVERIFIED**.

[Native 3adb57a collection](https://github.com/forever-Agriculture/BMN/actions/runs/37271595002) finished five workflows PASS and build FAIL. Linux passed 3,122 assertions with 36 skips; Windows passed 3,132 with 14 failures and 12 skips. The five worker-integration fixture failures from `c7cec2f` and both capability-routing cases now pass on both systems; the fourteen assigned launcher obligations remain. The actual production CIM query passed five times in 338–406 ms with independent command metadata in 543 ms, but the separate installer gate still fails at `install-payload` with an assertion whose location the catch discarded. The original five-second smoke-environment deadline failed at 5,244 ms; it is not relaxed or waived.

The next candidate is diagnostic and fixture-only. The smoke environment provisions its nine private roots through one call to the same full guard, in the same order and with the same 5,000 ms budget; successful output and secure refusal must match, not partial failure side effects. The installer catch records only fixed error names, allowlisted runtime-file frames (at most six, from 32 lines of a 64 KiB stack) and SHA-256 bindings of the bounded source captured before the measured modules load; messages, values and other paths are excluded, and the primary FAIL is preserved. Two native control-endpoint tests replace the skipped POSIX socket cases: caller-provisioned private directory and endpoint ACLs, the pipe DACL captured during `listen`, authentication and removal after close; and refusal to take over a live server's endpoint, then replacement after its actual crash. Both establish native lifetime ownership before spawning. Their native results, the batched deadline and the installer location are **UNVERIFIED** until collected; no installer repair is inferred from them.

[Native 8b9a915 collection](https://github.com/forever-Agriculture/BMN/actions/runs/37278665858) finished five workflows PASS and build FAIL. Linux passed 3,135 assertions with 38 skips; Windows passed 3,147 with 14 failures and 12 skips, all fourteen the assigned Linux shell-launcher obligations. The batched smoke environment passed in 836 ms within its original 5,000 ms budget. Both native control-endpoint tests passed: private directory/endpoint ACLs, the pipe DACL captured during `listen`, authentication and removal (1,132 ms), and live-server refusal then replacement after an actual crash (1,819 ms). Their two POSIX socket keys are closed; the POSIX cases remain Linux-only. The installer location diagnostic now places the remaining installer failure at the isolated staged smoke (`windows-installed-worker.mjs:89`, reached from the transaction's smoke step); all four frames matched their bound source. That smoke runs the packaged application's full `--self-test`, which has no prior native Windows run. Its cause is **UNCONFIRMED**; the next candidate records the smoke's exit status, signal, error code, receipt names and the self-test's own bounded failure line before any repair.

## Windows desktop start and update windows

The Windows launcher now follows the Linux launcher contract. A start with no active update, or with a completed or older failed one, opens the selected build at once and reports nothing. While an update waits for BMN to exit, a start is forwarded to the running app. Otherwise the start is held in a progress window that shows the actual stage from bounded, attempt-bound update observations (no command output, arguments or environment). "Don't wait", closing the window or an unexpected window exit leaves the owned update running and suppresses opening BMN. After this start's own wait, a failure is reported from authoritative selection only: previous build unchanged, new build selected, no build selected, or unverifiable (never reported as unchanged). Open BMN revalidates the selection under its lease; Show log opens a read-only viewer; closing a dialog opens nothing. When no window can be shown, an informational toast through the existing `dev.bmn.desktop` identity is attempted; submission is not proof of display. Windows run on the absolute system PowerShell in STA without a profile, with text passed as environment data and decisions recorded as exclusively created files in a private directory.

Native equivalents of all fourteen Linux launcher obligations are in `scripts/tests/windows-desktop-launcher.test.mjs`, driving real windows through UI Automation with real selection files and CIM process observation; `scripts/tests/windows-update-ui.test.mjs` covers the windows, literal text, keyboard default, dismissal, crash and unavailable paths. Their native results are **UNVERIFIED** until collected. The per-step nested-job runner for build descendants is not part of this change; build-step descendant cleanup before later steps remains open under 53.11.

[Native 1f0cf90 collection](https://github.com/forever-Agriculture/BMN/actions/runs/37299667758): five workflows PASS, build FAIL. Linux passed all 3,215 assertions. Windows had 13 failing tests (16 assertion results), all native update-window tests. Every window was found too late or never reported ready, while the windows behaved correctly when observed. Under the parallel unit inventory each progress window reported ready after 28–46 s, beyond the 20 s fixture search and the product's 20 s default budget. After three failed runs of this gate, the next method was agreed with the consultant. Window-behavior tests now:
- search for up to 90 s, ending as soon as the window appears;
- give progress windows an explicit 90 s budget and log any start beyond the product's 20 s default.

A separate test exercises the default budget's timeout and its notification fallback with a real window process. An observation-only probe records where a window's start time goes (bare PowerShell, WinForms load and first show, product versus full environment). The product's 20 s default stays provisional; it is not verified readiness.

The packaged `--self-test` printed nothing for 120 s on native Windows: stderr 0 bytes, no phase markers, no receipt. The installed smoke did the same for 300 s. The cause is **UNVERIFIED**. An observation-only adaptive diagnostic now runs once before the installed gate, with up to three 80 s runs: a minimal-environment self-test, then a full-environment self-test and a minimal-environment normal start only while the earlier runs stay silent. Each run briefly attaches the Node inspector to record main readiness, open windows, a stack sample and whether a stderr sentinel reaches the pipe.

## Native startup located and repaired: `aa9cb0d`

[Run 37312653316](https://github.com/forever-Agriculture/BMN/actions/runs/37312653316) on `aa9cb0d`: five side workflows PASS; the build gate failed on Windows only. Linux passed every step, including the packaged smoke with the new startup markers. The Windows unit inventory recorded 3,220 tests, 0 failed and 27 skipped.

- **Silent packaged self-test: cause found and fixed.** The installed smoke's isolated profile set `LOCALAPPDATA` to `BMN_DATA_HOME`. Startup refuses a BMN root equal to `LOCALAPPDATA` before any output. With no reporter installed, Electron then waited on its hidden error dialog. The profile now has its own local and roaming folders; validation is unchanged.
  - The diagnostic's old-layout control now ends in 2 s with that refusal at the `private directories` step.
  - With the corrected layout, startup completes in 765 ms (every step's enter/return marker, single instance acquired, ready).
  - A regression test runs startup's own root resolution and folder checks with Windows path rules on every platform.
- **Update windows.** Importing PowerShell's utility module before `Add-Type` cut the window environment's WinForms load from a 50 s timeout to 79 ms. Real progress windows now report ready in 1.0–1.9 s, within the 20 s product budget.
- **53.6.** The native held-session reader passed both of its Windows tests; the patched ConPTY addon compiled natively.
- **First native Windows self-test.** It ran the Sixel animation in a real pane (`CODEX-RATE-DONE`, `MAX-RATE-DONE`), then failed at 35 s: "the animation pane never printed SCROLLED". The cause is **UNVERIFIED**. The next run records the pane's last lines and how soon after `MAX-RATE-DONE` was seen the next line was sent and accepted. It does not capture the raw PTY output, so the result may stay inconclusive.
- **Gate failures in this run.**
  - The lifecycle step failed because the startup markers wrapped the lifetime-protection call. The crash fixture's original-defect control removes exactly that standalone statement. The call stands alone again, and a source test guards it.
  - In the installed smoke, removing the temporary profile threw, and that error replaced the smoke's own result. What held the profile, and how the smoke itself ended, are **UNVERIFIED**. Removal now retries briefly. A removal failure after a failed smoke no longer replaces it; its error code is added to the smoke's outcome when the smoke produced one. A removal failure after a passing smoke still fails the step.

## Native result for `b68ebfb`

[Run 37317616196](https://github.com/forever-Agriculture/BMN/actions/runs/37317616196): five side workflows and the Linux job pass. Windows recorded 3,228 unit tests, 0 failed and 24 skipped. The new native tests pass: start identity, the CLI's refusal of a terminal on standard input, device-path refusal, and `codex.exe` end to end. The launcher sources compile under `/W4 /WX`, and the lifecycle step passes. The gate failed only at packaged startup:
- **SCROLLED, reproduced in two runs.** The diagnostic self-test and the installed smoke show the same pane: the scroll line ran and printed through `scroll-79`. Neither `SCROLLED` nor the next PowerShell prompt appeared within 10 s; the line was accepted within 1 ms of `MAX-RATE-DONE` being seen. Output stopped mid-stream. Whether PowerShell/ConPTY never produced the rest or BMN never delivered it is **UNVERIFIED**.
- **Installed smoke keeps its verdict.** The smoke reported the same failure and, separately, that its profile could not be removed (`EPERM`).

## Native result for `5ea91e1`

[Run 37322654021](https://github.com/forever-Agriculture/BMN/actions/runs/37322654021): five side workflows and the Linux job pass. Windows recorded 3,231 unit tests, 0 failed and 24 skipped, including both PowerShell PATH tests in Windows PowerShell 5.1. The gate failed again only at packaged startup, at SCROLLED, in both the diagnostic self-test and the installed smoke. The observation added in `5ea91e1` narrows where the output stops:
- BMN's host received 1,971,804 bytes from the pane, and its view had processed all of them: nothing pending, in flight or paused. node-pty's output stream was neither paused nor holding unread data. The last bytes the host received were exactly `scroll-79\r\n`, with no terminal query after them.
- No byte arrived for the next 23 s. `SCROLLED` never came late. A probe line typed into the pane was accepted but produced nothing, not even its echo.
- So the missing output never reached BMN's host process. It stopped in PowerShell, in the bundled ConPTY (`useConptyDll`), or in node-pty's reader for ConPTY's output. Which one is **UNVERIFIED**. The pane's last lines were identical in all four runs that reached this step.
- The installed smoke again kept its verdict and recorded `EPERM` for its profile removal. The alternate-screen and quit steps come after SCROLLED, so their Windows forms are still **UNVERIFIED** natively.

## Codex typed in a Windows session (53.6, local candidate)

On Linux, `bin/codex` sits first on a session's PATH and adds `--no-daemon` to Codex typed in the shell. A shared Codex app-server daemon keeps the environment of the terminal that started it, so without this its hooks could carry another session's BMN credentials. Windows shipped no equivalent, so Codex typed in a Windows session's shell could join such a daemon.

`codex.exe` is now built from the native `bmn` launcher source. The launcher takes its script and development sidecar names from its own file name. The `codex.exe` build keeps its runtime in the caller's job instead of a nested one, as the Linux wrapper's `exec` does: a daemon that `codex agents` or `remote-control` starts keeps running after the command returns, and the session's own job still owns the tree. It runs `bin/codex.mjs`, which:
- finds the real Codex on PATH, skipping BMN's launcher, session and script folders however they are spelled;
- uses the same literal lookup BMN uses for the programs it starts, so an npm `codex.cmd` shim runs as `node.exe` with its entry script and no batch interpreter;
- applies the session manager's own `--no-daemon` rule;
- runs Codex with the session's environment and returns its exit code.

The lookup and the rule are shared modules (`bin/windows-launch.mjs`, `bin/codex-launch.mjs`). A Linux test checks the JavaScript rule against the shell wrapper over thirteen argument shapes. Windows tests cover the lookup past BMN's folder and an end-to-end run of the built `codex.exe` against a synthetic npm-installed Codex. Native results are **UNVERIFIED** until collected.

A PowerShell profile can put a global Codex ahead of BMN's folder on PATH, as a Bash startup file can. Linux restores the order after Bash startup and before each prompt (`bin/bmn-bashrc`). A plain interactive PowerShell session (`powershell` or `pwsh` with no arguments, or only `-NoLogo`) now starts with `-NoExit -Command` and an inline step that does the same: after the profiles it puts BMN's folder first again, and it wraps the owner's `prompt` function to repeat that before each prompt. The step is inline because the default execution policy refuses script files. PowerShell hides its startup banner when given a command, so these sessions open without it. Any other arguments (a command, a file, `-NoProfile`, `-NoExit`) are left exactly as given.

Tests: the session argv shapes run on both systems. The step itself runs in a real PowerShell with a simulated profile and a later PATH change: locally in PowerShell 7.6.6 on Linux (GREEN; the same script without the step resolves the competing Codex), and natively in Windows PowerShell 5.1 ([run 37322654021](https://github.com/forever-Agriculture/BMN/actions/runs/37322654021), PASS).

Windows unit coverage added alongside:
- The process start-identity tests now run on Windows. Only there is an exited process's refusal awaited, for up to 5 s, because Windows keeps the process until its last handle closes; Linux still requires an immediate refusal.
- The CLI's refusal of a terminal on standard input now runs through a real PTY on both systems.
- A Windows test refuses reserved device names and the pipe and device namespaces as file references, without reading them.
