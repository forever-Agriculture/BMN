# Survival acceptance matrix

[architecture.md](architecture.md)'s "What survives" table says what each way of ending sessions
keeps. This matrix holds that same promise to evidence: every row names the trial that exercises
it, the outcome each column promises, and the current evidence state — **exercised-with-receipt**,
**documented-only**, or **UNVERIFIED**. Neither the owner nor an agent has to trust prose.

## Trials and receipts

- The trial contract uses synthetic workspaces and conversations and excludes the owner's real
  workspaces, profiles and sessions (NFR35). The historical cross-harness runs below breached the
  profile rule; they remain UNVERIFIED and are not acceptance evidence.
- Non-disruptive endings (no process kill, no reboot, no update install) run in isolated Electron
  instances with throwaway XDG/BMN/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`OPENCODE_CONFIG_DIR` roots,
  exactly as [electron-self-test.mjs](../scripts/test/electron-self-test.mjs) launches them.
  Reading of the story's "disposable OS user or VM" wording: NFR35's protection target is the
  owner's system and data, and these endings perform no OS-level action — nothing outside the
  throwaway app-data roots is killed, written or installed — so the isolated instance is the
  disposable profile for them; the disposable OS user or VM is required the moment a step reaches
  the OS (kill, reboot, update install), as the disruptive rows below state. Recorded here rather
  than silently assumed.
- Disruptive steps — process kill, reboot, update install — run only on a disposable OS user or VM
  that owns its own checkout, packaged binary and update service, with the owner's per-run
  go-ahead. An isolated app-data folder alone does not qualify: the updater replaces the packaged
  build and queues a user systemd unit
  ([update-desktop.mjs](../scripts/install/update-desktop.mjs)).
- Each trial writes a dated receipt under `.dev-auto/evidence/survival/` (local by design; the
  directory is git-ignored) naming BMN commit, OS, harness versions, steps, the observed outcome
  and a verdict of PASS, FAIL or UNVERIFIED with its reason. A FAIL receipt quotes the matrix
  promise and the observed behaviour verbatim, and becomes a tracked defect for separately
  authorized work; documentation is never quietly edited to match behaviour inside these stories.
- Because receipts stay local, each trial below also carries its result line in this file —
  verdict, receipt filename, commit, date — one line per distinct trial, the latest receipt last.

## Columns

The six columns are the survival table's own: **process**, **live screen**, **saved output**,
**session record and layout**, **conversation resume**, **open Needs you requests**.

## Rows

### Close the window, keep the sessions

- Promise per column — process: keeps running. Live screen: kept: the window is minimized, not
  destroyed. Saved output: captured on the same cadence. Session record and layout: unchanged.
  Conversation resume: not needed; nothing stopped. Open requests: stay open.
- Trial steps: in an isolated Electron instance with a live synthetic session, invoke the window
  close and choose the keep-sessions answer in the close prompt; then read the session's process
  state, verify the capture cadence continues with no final capture, the record and layout are
  unchanged, no interruption is recorded, and open requests remain open.
- Trial actually run (recorded honestly): one mixed-decision close — the target remembers Stop, a
  sibling remembers Hide — which is the prompt's per-session answer model in one run. The pure
  all-kept close (nothing stopped, window hidden) and the pure all-stopped close (which proceeds
  to quit) were not run as separate isolated trials; their unrun cells read as unexercised by this
  receipt rather than silently covered by the mixed run.
- Harnesses: Electron self-test instance (isolated roots, synthetic workspace).
- Follow-up repair `1757ec8`: the lifecycle skips final capture when every session is kept and
  scopes a mixed close's capture to the exact sessions being stopped. The all-kept unit check
  failed on the old code and passes on the repair; the mixed Electron run reports
  `noLifecycleCapture: true` for the kept sibling while acknowledging a final capture for the
  stopped target. The old discrepancy remains in the earlier local FAIL receipt. Periodic cadence
  itself was not measured in the Electron run.
- Evidence: PASS (partial) for the repaired no-extra-capture behavior; the other columns are
  partially exercised through the real close lifecycle (closeLastWindow plus its renderer prompt).
  The stopped target remembers Stop and every prompted sibling is answered Keep running. Process
  (kept session still live), no interruption recorded, and open-request identity retained are
  checked; the live-screen (minimized-not-destroyed) cell is observed only
  as the hide call running, not as a visible window state: the self-test window is forceHidden,
  and driving a real visible window close through it destabilizes the run. Result lines below.

### Close the window and stop the sessions

- Promise per column — process: stopped, recorded *interrupted · last window close*. Live screen:
  ends with the process. Saved output: a final capture is taken before the stop. Session record
  and layout: unchanged; the pane keeps its place. Conversation resume: resume reopens a bound
  conversation. Open requests: stay open; a harness that sends `SessionEnd` withdraws the ones its
  hook opened.
- Trial steps: in an isolated Electron instance with a live synthetic session bound to a
  conversation, invoke the window close and choose the stop-sessions answer; verify the
  *interrupted · last window close* recording, the final capture before the stop, the unchanged
  record with the pane's place kept, resume reopening the bound conversation, and hook-opened
  requests withdrawn while the rest stay open.
- Trial actually run (recorded honestly): the mixed-decision close above — the stopped target's
  cells are this row's; an all-stopped close (every target Stop, which proceeds to quit the app)
  was not run as its own isolated trial.
- Harnesses: Electron self-test instance (isolated roots, synthetic workspace and conversation).
- Evidence: exercised-with-receipt, partial — the close runs through the real application
  lifecycle and its renderer prompt (remembered Stop choice for the target, Keep running for the
  asked sessions): the *interrupted · last window close* recording, the pre-stop marker in the
  post-stop saved output (the marker was asserted absent from every earlier snapshot) and the
  kept sibling are proven. The self-test now also requires an acknowledged production lifecycle
  capture request for this exact session during the close ending; the renderer's separate activity
  capture cannot satisfy that assertion. The marker can still have entered the store through an
  earlier activity capture, so the receipt proves both facts rather than attributing its bytes to
  one request. The resume and `SessionEnd`-withdrawal cells were not re-driven (the synthetic session is not a direct CLI
  launch, so no bound conversation; resume and withdrawals are exercised by the same run's
  conversationFromHook and hook-contract checks). Result lines below.

### Quit

- Promise per column — process: stopped after BMN lists the running sessions and asks, recorded
  *interrupted · application quit*. Live screen: ends with the process. Saved output: a final
  capture is taken before the stop. Session record and layout: unchanged. Conversation resume:
  resume reopens a bound conversation; the next start offers to resume them all in one dialog.
  Open requests: stay open; `SessionEnd` withdraws the hook's own.
- Trial steps: in an isolated Electron instance with live synthetic sessions (at least one bound
  to a conversation and one with a hook-opened request), quit the application and confirm; verify
  the *interrupted · application quit* recording after BMN lists and asks, the final capture
  before the stop, unchanged records, the resume-all offer on the next start (one row per session,
  nothing started until the button), resume reopening the bound conversation, and `SessionEnd`
  withdrawals.
- Harnesses: Electron self-test instance (isolated roots, synthetic workspace and conversation).
- Saved-output cell evidence: the self-test cannot drive `beforeQuit` without quitting itself, so
  the flush-before-stop order for the quit cause rests on the lifecycle unit tests
  ([host-loss.test.ts](../apps/desktop/src/main/host-loss.test.ts), "flushes pending terminal
  output before %s stops the process", quit case) and on the one `captureThen` the same run
  exercises in-app through the real lifecycle for the close and explicit endings.
- Evidence: exercised-with-receipt for the recording, its reason surviving an application
  restart, and the open requests intact — through a direct stop with the quit cause, not a driven
  `beforeQuit`: the owner prompt, the quit-time final capture and the next-start quit resume-all
  dialog are indirect here (lifecycle unit tests for the flush and prompt order; the update-stop
  scenario's resumeOffer fields for the same cohort mechanism). A regression confined to the quit
  use site would escape this receipt; those cells read as indirect, not as driven. Result lines
  below.

### Stop a session

- Promise per column — process: stopped; an unconfirmed stop stays *exit unconfirmed* until the
  host reports the exit. Live screen: ends with the process. Saved output: a final capture is
  taken before the stop. Session record and layout: unchanged. Conversation resume: resume
  reopens a bound conversation. Open requests: stay open; `SessionEnd` withdraws the hook's own.
- Trial steps: in an isolated Electron instance with a live synthetic session bound to a
  conversation and carrying a hook-opened request, stop the session explicitly; verify the
  *exited* recording with the host's exit code (or *exit unconfirmed* until the host reports it —
  never *interrupted*), the final capture before the stop, the unchanged record, resume reopening
  the bound conversation, and `SessionEnd` withdrawals with the remaining requests retained.
- Harnesses: Electron self-test instance (isolated roots, synthetic workspace and conversation).
- Evidence: exercised-with-receipt, partial — the stop runs through the production Stop path
  (`stopCurrentTarget`: flush, then stop with cause explicit); the *exited* recording (code 0,
  signal 1, never *interrupted*) and the final capture (pre-stop marker present, flush burst) are
  proven; resume and `SessionEnd`-withdrawal cells for this session rest on the same run's
  conversationFromHook and hook-contract checks rather than a re-drive. Result lines below.

### Renderer crash

- Promise per column — process: keeps running. Live screen: a new view is created, brought to the
  private terminal mode state the program is in, and the program is asked to repaint once; bytes
  from before the crash are not replayed. Saved output: unaffected. Session record and layout:
  unchanged; order, selection, scroll position and follow-tail are restored. Conversation resume:
  not needed; nothing stopped. Open requests: stay open.
- Trial steps: in an isolated Electron instance with live synthetic sessions, crash the renderer
  and let the app rebuild the view; verify every process still running, the rebuilt view's
  terminal modes (paste bracketing, focus and mouse reports, autowrap), layout order, selection,
  scroll and follow-tail restored, the saved output unaffected, no interruption recorded, and open
  requests unchanged.
- Harnesses: Electron self-test instance (isolated roots, synthetic workspace).
- Evidence: exercised-with-receipt — the self-test checks the processes, the layout and the
  program's terminal modes surviving a new view. Result lines below.

### App crash or reboot

- Promise per column — process: ends when its pseudo-terminal closes (UNVERIFIED); the next start
  marks earlier incarnations *interrupted* and starts nothing by itself. Live
  screen: gone. Saved output: the last periodic capture; output written after it is lost. Session
  record and layout: unchanged. Conversation resume: resume reopens a bound conversation,
  including one a `SessionStart` hook reported. Open requests: stay open.
- Trial steps (app crash): on the disposable OS user or VM, with the app running synthetic
  sessions and a periodic capture present, kill the app process; restart it; verify earlier
  incarnations marked *interrupted*, nothing started by itself, the last periodic capture present
  with no final capture, records unchanged, resume working, requests retained.
- Trial steps (reboot): as above, replacing the kill with a reboot of the disposable machine.
- Harnesses: disposable OS user or VM owning its own checkout and build; owner per-run go-ahead.
- Evidence: UNVERIFIED, with receipts. The 2026-09-25 app-crash and reboot trials were not run:
  no disposable OS user or VM exists on this machine, and the owner's delegation of the decision
  to the consultant (Astra/medium, quoted in the receipts) was answered by recording both
  UNVERIFIED rather than approximating a kill or a reboot on the owner's system. The process
  column stays UNVERIFIED by the table's own words. Result lines below.

### Desktop source update

- Current behavior per column — process: the updater waits for BMN to exit; it does not stop
  sessions. The owner can Quit (records *interrupted · application quit*), close the last window
  and choose Stop (records *interrupted · last window close*), or Keep running (updater still
  waits). Live screen: ends with BMN, or stays in the minimized window when kept. Saved output:
  Quit and close-stop take a final capture; the updater takes none. Session record and layout:
  unchanged. Conversation resume: individual Resume reopens a bound Claude/Codex conversation or
  OpenCode with `--session`; Quit offers resume-all on the next start, while close-stop does not.
  Open requests: stay open unless their harness sends `SessionEnd`.
- Original promise discrepancy: the previous table said an update installed while BMN ran
  stopped sessions as *interrupted · update restart* and offered resume-all. The source updater
  instead waits for BMN to exit ([update-desktop.mjs](../scripts/install/update-desktop.mjs),
  `waitForPackagedAppToExit`); the app's downloaded-update handler returns without stopping when
  any session runs ([app-lifecycle.ts](../apps/desktop/src/main/app-lifecycle.ts),
  `updateDownloaded`). Its only `update-restart` stop passes an empty target list. The Electron
  self-test directly manufactures that cause to exercise the cohort UI, so it does not prove the
  update use site. The old process and resume-all promise is **FAIL** against source behavior.
- Trial steps (while running): on a disposable OS user or VM with synthetic sessions, queue the
  source update and confirm it waits. Explicitly Quit; verify the *application quit* record,
  final capture, retained requests, next-start resume-all offer, update completion and packaged
  version. In a separate run, close the last window and choose Stop; verify *last window close*,
  final capture and individual Resume, with no automatic resume-all offer. Keep-running close
  must leave the updater waiting.
- Trial steps (while stopped): on the disposable OS user or VM, with sessions already stopped,
  queue and install the update; verify the already-stopped sessions' records unchanged (no new
  *interrupted*, no phantom exit), the update completing and the packaged version advancing, the
  sessions remaining resumable, and no resume-all offer.
- Harnesses: disposable OS user or VM owning its own checkout, packaged binary and update service
  (`systemd` user unit); owner per-run go-ahead.
- Evidence: FAIL for the old update-stop promise from the source audit and existing lifecycle
  tests; packaged install, version advance and the exact owner Quit/close flows remain
  UNVERIFIED. The 2026-09-25 disruptive trials were not run: both need a disposable OS user or VM
  owning its packaged binary and update service, which does not exist here. Result lines below.

## Beyond the table: the other promises this epic exercises

### OpenCode support (real harness)

- Promise: one real interactive OpenCode session exercises hook delivery, capture and Resume via
  `opencode --session <id>` (Epic 18; shipped on synthetic receipts only).
- Trial steps: in an isolated-config environment (synthetic `OPENCODE_CONFIG_DIR` holding the BMN
  plugin, synthetic workspace), run one real interactive OpenCode session through BMN; verify the
  plugin's hook delivery reaches BMN, the conversation is captured, and Resume reopens it with
  `--session`. If provider access blocks the run, the row records UNVERIFIED with the exact
  blocker; a synthetic run is never labelled the real thing.
- Harnesses: real `opencode` CLI over a PTY inside an isolated-config BMN session.
- Evidence: UNVERIFIED, with receipt. A compliant isolated-config real-provider harness (synthetic
  config root that still holds working provider credentials, bounded spend) was not built within
  this run's window; the blocker is infrastructure, not a provider refusal. No synthetic run is
  labelled real. Result lines below.

### Cross-harness handoff, both directions (Epic 7 usefulness)

- Promise: a real Claude→Codex and a real Codex→Claude handoff, synthetic content, normal harness
  permissions — the chosen summary pasted once, existing destination input retained without
  submission, every selected original readable after the owner submits.
- Trial steps: run the cross-harness trial harness (real `claude` and `codex` CLIs over PTYs, real
  permission modes, synthetic files) once per direction; verify the paste count, no Enter, the
  retained input, and the destination reading the selected original after submission; record
  remaining friction.
- Harnesses: tracked [cross-harness trial](../scripts/test/cross-harness-trial.ts), invoked only
  with its [explicit Vitest config](../scripts/test/cross-harness.vitest.config.mjs). Its
  launcher uses the tracked [disposable-provider-env.mjs](../scripts/lib/disposable-provider-env.mjs)
  guard and refuses to start either provider without separately provisioned private profiles under
  `/tmp/bmn-cross-harness-profiles-*`; no compliant rerun has yet been made.
- Evidence: UNVERIFIED — method non-compliant. The 2026-09-25 re-run executed both directions end
  to end under the Epic 26 build (single bounded paste, no submit before the owner, destinations
  read the selected originals and answered; codex-cli 0.157.0 / claude 2.1.282), but the harness
  inherits the caller's environment, so both real CLIs ran against the owner's actual
  Claude/Codex profiles — reading their config, writing session transcripts there and consuming
  real quota — instead of disposable profile roots. NFR35 forbids touching the owner's real
  profiles, so the runs stand as method evidence only and the row stays UNVERIFIED. Exact blocker:
  a compliant harness needs disposable `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/XDG roots that still
  carry working provider credentials for the trial turn — provisioning credentials inside
  disposable roots and their spend is owner authorization the run does not carry. The harness's
  string-based input-retention check is also weaker than the promise (it finds tokens in the
  accumulated output, not in the rendered current input); a compliant rerun should assert the
  submitted prompt directly. The tracked replacement now records exact PTY writes, labels actual
  input retention UNVERIFIED, and writes only directions exercised in that run to its receipt;
  it cannot turn a green method probe into acceptance evidence. Result lines below.

## Trial result lines

One line per distinct trial, newest last. Receipts live under `.dev-auto/evidence/survival/`.

| Trial | Verdict | Receipt | Commit | Date |
| --- | --- | --- | --- | --- |
| dry run (receipt format validation before any disruptive trial) | PASS | [dry-run-format-2026-09-25.md](../.dev-auto/evidence/survival/dry-run-format-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| renderer crash (processes, layout, terminal modes, requests; first exercised by the Epic 25 gate) | PASS | [renderer-crash-2026-09-25.md](../.dev-auto/evidence/survival/renderer-crash-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| quit (partial: interruption recorded, reason survives restart and requests intact; prompt and final capture remain indirect) | PASS (partial) | [quit-columns-2026-09-25.md](../.dev-auto/evidence/survival/quit-columns-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| close-window-keep (no extra lifecycle capture in mixed close; pure all-kept and visible-window cells remain indirect) | PASS (partial) | [close-window-keep-repair-2026-09-25.md](../.dev-auto/evidence/survival/close-window-keep-repair-2026-09-25.md) | 1757ec8 | 2026-09-25 |
| close-and-stop (partial: real lifecycle + prompt, recording, acknowledged lifecycle capture, kept sibling; resume/withdrawal cells rest on conversationFromHook) | PASS (partial) | [close-and-stop-2026-09-25.md](../.dev-auto/evidence/survival/close-and-stop-2026-09-25.md) | 0a71e47 (review tree) | 2026-09-25 |
| stop, explicit (partial: exited recording and acknowledged lifecycle capture; resume/withdrawal cells rest on conversationFromHook) | PASS (partial) | [stop-2026-09-25.md](../.dev-auto/evidence/survival/stop-2026-09-25.md) | 0a71e47 (review tree) | 2026-09-25 |
| app crash | UNVERIFIED — no disposable OS user/VM exists to run it on; delegated consultant decision quoted | [app-crash-2026-09-25.md](../.dev-auto/evidence/survival/app-crash-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| reboot | UNVERIFIED — same blocker | [reboot-2026-09-25.md](../.dev-auto/evidence/survival/reboot-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| desktop update, while running | FAIL — original update-restart/resume-all promise contradicts source; packaged install UNVERIFIED | [update-source-semantics-2026-09-25.md](../.dev-auto/evidence/survival/update-source-semantics-2026-09-25.md) | fd8c7e0 (source audit) | 2026-09-25 |
| desktop update, while stopped | UNVERIFIED — same blocker; nothing installed on the owner's system | [update-while-stopped-2026-09-25.md](../.dev-auto/evidence/survival/update-while-stopped-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| OpenCode real harness | UNVERIFIED — isolated-config real-provider harness not built in this run's window; no synthetic run labelled real | [opencode-real-session-2026-09-25.md](../.dev-auto/evidence/survival/opencode-real-session-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| cross-harness claude→codex | UNVERIFIED — ran, but on the owner's inherited profiles (NFR35 method non-compliance); disposable-root credentials need owner authorization | [cross-harness-claude-to-codex-2026-09-25.md](../.dev-auto/evidence/survival/cross-harness-claude-to-codex-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |
| cross-harness codex→claude | UNVERIFIED — same method non-compliance | [cross-harness-codex-to-claude-2026-09-25.md](../.dev-auto/evidence/survival/cross-harness-codex-to-claude-2026-09-25.md) | b341724 (Epic 26 tree) | 2026-09-25 |

One line per distinct trial, the latest receipt linked; FAIL and UNVERIFIED lines stay with their
reasons rather than being dropped. PASS (partial) rows keep their unexercised cells named in the
row above and in the receipt. `b341724 (Epic 26 tree)` identifies the original 26 trial baseline;
`0a71e47 (review tree)` identifies the parent commit of the 2026-09-25 review fixes. Both sets of
receipts ran with uncommitted task changes, stated in their local receipt files.
