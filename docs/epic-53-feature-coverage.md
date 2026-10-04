# Epic 53 feature coverage checklist

This is the detailed draft for story 53.13, linked to the [parity evidence](epic-53-parity.md).
It reconciles the [feature guide](features.md), [README](../README.md), and merged
navigation/everyday-work contracts through baseline `e20a21d`. The source candidate
is `fffebc9eced9c410102efe7099a98051868c575b`; final integration reconciliation is still required.

Every row has an owning story and a concrete acceptance scenario. A linked test or
measurement is a starting point, not proof it covers the entire scenario or passed.
In particular, existing WSL measurements do not implement the bridge, durable workspace
or provider route. Expand their coverage before claiming those capabilities.

**U = UNVERIFIED on installed applications from the final integration commit.**
All three runtime columns currently use U. This preserves prior component/CI results
in the parity evidence without turning them into full installed-flow acceptance.
Record each actual result with commit, OS/shell/tool versions and shareable evidence
in that document; replace U only for the exercised scope. The owner's unavailable
Windows 11/device/WSL deferral affects release timing, not these result labels.
No live phone/provider test or owner-profile change is authorized by this checklist.

## Workspaces and sessions

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| WS01 / 53.7 | Create/rename/reorder/markers, restart preserves selection/layout | [database-workspace-store.test.ts](../apps/desktop/src/utility/database-workspace-store.test.ts) | U | U | U |
| WS02 / 53.2 | Archive refuses starting/running/unconfirmed exit; restore starts nothing | [archive-undo.test.ts](../apps/desktop/src/renderer/src/archive-undo.test.ts) | U | U | U |
| WS03 / 53.7 | Archive Undo timing/focus, changed-record refusal and quiet finished rows | [workspace-tree.test.ts](../apps/desktop/src/renderer/src/workspace-tree.test.ts) | U | U | U |
| WS04 / 53.2 | Shell/agent/template discovery, unavailable template, exact directory/argv/env | [session-manager.test.ts](../apps/desktop/src/utility/session-manager.test.ts) | U | U | U |
| WS05 / 53.6 | Claude/Codex/OpenCode/Cursor route, agent exit leaves interactive shell | [session-manager.test.ts](../apps/desktop/src/utility/session-manager.test.ts) | U | U | U |
| WS06 / 53.7 | Edit/cancel launch settings for next launch without disturbing live process | [command-palette.test.ts](../apps/desktop/src/renderer/src/command-palette.test.ts) | U | U | U |
| WS07 / 53.2 | Launch sets: copied 1–8 entries, exact JSON argv, ordered start/failure results | [launch-set-coordinator.test.ts](../apps/desktop/src/utility/launch-set-coordinator.test.ts) | U | U | U |
| WS08 / 53.3 | Repository identity incl linked worktree/unborn/detached, changed identity review | [repository-identity.test.ts](../apps/desktop/src/utility/repository-identity.test.ts) | U | U | U |
| WS09 / 53.4 | Session/run token isolation and removal of inherited harness/private identities | [session-manager.test.ts](../apps/desktop/src/utility/session-manager.test.ts) | U | U | U |
| WS10 / 53.6 | Hook-derived harness/model origin/API host; unknown model has no guessed flag | [session-manager.test.ts](../apps/desktop/src/utility/session-manager.test.ts) | U | U | U |
| WS11 / 53.6 | History consent, per-harness command, limits/in-use protection/Cursor unmanaged | [agent-history.test.ts](../apps/desktop/src/utility/agent-history.test.ts) | U | U | U |
| WS12 / 53.3 | Archive retention deletes records/output/requests but retains published files | [database-archive-purge.test.ts](../apps/desktop/src/utility/database-archive-purge.test.ts) | U | U | U |

## Terminal and panes

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| TP01 / 53.2 | Real PTY Unicode/stdin/TUI, exact args, no replay, shell/TUI exit | [windows-pty-ownership.mjs](../scripts/test/windows-pty-ownership.mjs) | U | U | U |
| TP02 / 53.7 | Sixel producer reaches live pane; term identity/fallback; text-only saved output | [terminal-images.test.ts](../apps/desktop/src/renderer/src/terminal-images.test.ts) | U | U | U |
| TP03 / 53.7 | Sixel resize/split/repaint with one live view per session | [terminal-view-tracking.test.ts](../apps/desktop/src/renderer/src/terminal-view-tracking.test.ts) | U | U | U |
| TP04 / 53.7 | Split/stack/pane switch/focus retains input and exact destination | [workspace-layout.test.ts](../apps/desktop/src/renderer/src/workspace-layout.test.ts) | U | U | U |
| TP05 / 53.7 | Find next/previous/Escape, floating Top/Bottom and narrow pane, no resize | [terminal-view.test.ts](../apps/desktop/src/renderer/src/terminal-view.test.ts) | U | U | U |
| TP06 / 53.7 | Selection/copy/select-all/paste/right-click with mouse reporting; clipboard never read | [terminal-clipboard.test.ts](../apps/desktop/src/renderer/src/terminal-clipboard.test.ts) | U | U | U |
| TP07 / 53.7 | OSC52 bounded plain text, opt-out/no replay/no read response, Linux primary selection | [terminal-clipboard.test.ts](../apps/desktop/src/renderer/src/terminal-clipboard.test.ts) | U | U | U |
| TP08 / 53.7 | Send-next-key, Ctrl-click ownership, Unicode layout/IME/AltGr shortcuts | [keymap.test.ts](../apps/desktop/src/renderer/src/keymap.test.ts) | U | U | U |
| TP09 / 53.7 | Font sizes, 100/150/200% scaling, status/footer priority and closed input | [terminal-exit.test.ts](../apps/desktop/src/renderer/src/terminal-exit.test.ts) | U | U | U |

## Lifecycle and resume

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| LR01 / 53.2 | Stop/natural exit/main crash kill all launched direct/broker descendants and GUI | [windows-broker-ownership.mjs](../scripts/test/windows-broker-ownership.mjs) | U | U | U |
| LR02 / 53.2 | Saved text on stop/quit; crash-loss warning; fresh Start again; no automatic replay | [terminal-history.test.ts](../apps/desktop/src/renderer/src/terminal-history.test.ts) | U | U | U |
| LR03 / 53.6 | Exact Claude/Codex/OpenCode/Cursor resume with bound conversation/environment | [conversation-resume-ipc.test.ts](../apps/desktop/src/main/conversation-resume-ipc.test.ts) | U | U | U |
| LR04 / 53.4 | Reported resume command shown with folder/time; owner explicitly checks it | [reported-resume.test.ts](../apps/desktop/src/utility/reported-resume.test.ts) | U | U | U |
| LR05 / 53.2 | Close Ask/keep running/stop vs Quit; renderer recovery preserves child processes | [windows-launch-smoke.mjs](../scripts/test/windows-launch-smoke.mjs) | U | U | U |
| LR06 / 53.2 | Resume-all only after Quit, exact commands/order/one offer/failure stops sequence | [resume-interrupted-presentation.test.ts](../apps/desktop/src/renderer/src/resume-interrupted-presentation.test.ts) | U | U | U |
| LR07 / 53.11 | Queued update waits for app exit; Quit resume offer retained; no forced owner stop | [windows-source-resume.test.mjs](../scripts/tests/windows-source-resume.test.mjs) | U | U | U |

## Attention and control

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| AC01 / 53.9 | Needs-you counts/type/expiry/withdrawal and exact open session/dismiss/answered | [attention-actions.test.ts](../apps/desktop/src/renderer/src/attention-actions.test.ts) | U | U | U |
| AC02 / 53.9 | Typing/paste/voice closes ordinary requests, never review/handoff; focus retained | [attention-actions.test.ts](../apps/desktop/src/renderer/src/attention-actions.test.ts) | U | U | U |
| AC03 / 53.7 | Response-card arrows browse only; answer controls retain keys; scroll target | [attention-actions.test.ts](../apps/desktop/src/renderer/src/attention-actions.test.ts) | U | U | U |
| AC04 / 53.9 | Desktop notification AppID/shortcut/idle policy and exact-session activation | [windows-install-shortcut.mjs](../scripts/test/windows-install-shortcut.mjs) | U | U | U |
| AC05 / 53.4 | Progress source/time/evidence, agent-claim label, unavailable evidence retained | [progress-evidence-dialog.test.ts](../apps/desktop/src/renderer/src/progress-evidence-dialog.test.ts) | U | U | U |
| AC06 / 53.7 | Review results grouping/current-previous/freshness/no-report, pending/uncertain handoffs | [workspace-results.test.ts](../apps/desktop/src/renderer/src/workspace-results.test.ts) | U | U | U |
| AC07 / 53.4 | Handoff max10 files, owner review/edit/destination, paste once/no Enter/uncertainty | [workspace-handoff-review.test.ts](../apps/desktop/src/renderer/src/workspace-handoff-review.test.ts) | U | U | U |
| AC08 / 53.4 | All bmn commands native launch/stdin/JSON/exit/error and local readiness disclosure | [control-cli.test.ts](../apps/desktop/src/utility/control-cli.test.ts) | U | U | U |
| AC09 / 53.4 | Scoped transport cross-user/token/run/idempotency/bounds; restart/reconnect cleanup | [control-server.test.ts](../apps/desktop/src/utility/control-server.test.ts) | U | U | U |
| AC10 / 53.6 | Hook check vs observed event; consent/diff/backup/atomic install preserves other entries | [control-cli.test.ts](../apps/desktop/src/utility/control-cli.test.ts) | U | U | U |
| AC11 / 53.9 | OSC9/777/99 notices incl reserved progress4 and malformed controls | [terminal-notice.test.ts](../apps/desktop/src/renderer/src/terminal-notice.test.ts) | U | U | U |
| AC12 / 53.6 | Current observed events vs bounded metadata-only restart history/archives/deletion | [hook-event-history.test.ts](../apps/desktop/src/utility/hook-event-history.test.ts) | U | U | U |
| AC13 / 53.6 | OpenCode subagent prompts isolated; repeated8/20 tool-call notice never stops agent | [session-manager.test.ts](../apps/desktop/src/utility/session-manager.test.ts) | U | U | U |

## Files and references

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| FR01 / 53.3 | Publish/attach/paste image immutable originals/hashes/size caps and symlink refusal | [artifact-files.test.ts](../apps/desktop/src/utility/artifact-files.test.ts) | U | U | U |
| FR02 / 53.3 | Preview/Open/Save As hash check/Show in Folder with real Windows dialogs/Explorer | [artifact-actions.test.ts](../apps/desktop/src/main/artifact-actions.test.ts) | U | U | U |
| FR03 / 53.3 | Deliver path to reviewed current target; stale run/focus refusal; no Enter | [artifact-actions.test.ts](../apps/desktop/src/main/artifact-actions.test.ts) | U | U | U |
| FR04 / 53.3 | Reference regular UTF8<=1MiB/line/column/canonical path/fresh link checks/refresh | [file-reference-reader.test.ts](../apps/desktop/src/utility/file-reference-reader.test.ts) | U | U | U |
| FR05 / 53.3 | Reference destination initially empty/exact reviewed path; restart/focus/archive invalidates | [file-reference-presentation.test.ts](../apps/desktop/src/renderer/src/file-reference-presentation.test.ts) | U | U | U |
| FR06 / 53.3 | Filename search roots/skip names/6 levels/20k entries/50 matches/no symlinks/cancel | [file-reference-search.test.ts](../apps/desktop/src/utility/file-reference-search.test.ts) | U | U | U |

## Voice

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| VO01 / 53.8 | Pinned portable engine/VAD/dependencies/distinct CPU; size+SHA model/custom folders | [voice-build-config.test.mjs](../scripts/tests/voice-build-config.test.mjs) | U | U | U |
| VO02 / 53.8 | Hold Space0.3s/tap Space/Speak/shortcut/permission denial/cancel/mic closed | [voice-ipc.test.ts](../apps/desktop/src/main/voice-ipc.test.ts) | U | U | U |
| VO03 / 53.8 | Language/vocabulary bounded suggestion approval; silence pastes nothing/local CPU | [voice-engine.test.ts](../apps/desktop/src/main/voice-engine.test.ts) | U | U | U |
| VO04 / 53.8 | Transcript goes to exact current native/WSL run without Enter; stale target denied | [voice-ipc.test.ts](../apps/desktop/src/main/voice-ipc.test.ts) | U | U | U |

## Telegram

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| TG01 / 53.9 | Opt-in owner bot/allowed chat+sender, no competing poller, private token, idle/unseen once | [telegram-connector.test.ts](../apps/desktop/src/utility/telegram-connector.test.ts) | U | U | U |
| TG02 / 53.9 | Draft default/direct-typing opt-in/handoff always draft; no inferred active-pane target | [telegram-delivery.test.ts](../apps/desktop/src/utility/telegram-delivery.test.ts) | U | U | U |
| TG03 / 53.9 | Single/multi/Other/Back/manual cards, once permission limits and confirmation evidence | [telegram-cards.test.ts](../apps/desktop/src/utility/telegram-cards.test.ts) | U | U | U |
| TG04 / 53.9 | Sleep/reconnect/restart/duplicate/stale/incarnation isolation; diagnostic no content | [telegram-card-keeper.test.ts](../apps/desktop/src/utility/telegram-card-keeper.test.ts) | U | U | U |

## Backup

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| BK01 / 53.3 | Consistent database+referenced files snapshot/hash manifest/exclusions; verify/no restore | [electron-self-test.mjs](../scripts/test/electron-self-test.mjs) | U | U | U |
| BK02 / 53.3 | Two explicit exports coexist without filename collision; locked/invalid destinations | [electron-self-test.mjs](../scripts/test/electron-self-test.mjs) | U | U | U |

## Customization and navigation

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| CN01 / 53.7 | Four themes/header identities/font size, preferences preserve edits/Jump to section | [preferences-dialog.test.ts](../apps/desktop/src/renderer/src/preferences-dialog.test.ts) | U | U | U |
| CN02 / 53.7 | Palette groups/literal-first abbreviations/context/highlight/action only Enter/click | [command-palette.test.ts](../apps/desktop/src/renderer/src/command-palette.test.ts) | U | U | U |
| CN03 / 53.7 | Recent20 stable chooser; archived/deleted removed; focus existing other pane | [recent-sessions.test.ts](../apps/desktop/src/renderer/src/recent-sessions.test.ts) | U | U | U |
| CN04 / 53.3 | Pinned8 paths explicit folder resolution/fresh link checks/unavailable removable/no send | [workspace-ipc.test.ts](../apps/desktop/src/main/workspace-ipc.test.ts) | U | U | U |
| CN05 / 53.7 | Collapsed group keeps selected row; move/counts reflect full group | [workspace-tree.test.ts](../apps/desktop/src/renderer/src/workspace-tree.test.ts) | U | U | U |

## Privacy and install

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| PI01 / 53.1 | Sandbox/context isolation/narrow preload; no telemetry/cloud/automatic update | [platform-startup.mjs](../scripts/test/platform-startup.mjs) | U | U | U |
| PI02 / 53.3 | Roots/override/legacy migration consistency, owner-only state/config/token/voice | [private-directory.windows.test.ts](../apps/desktop/src/utility/private-directory.windows.test.ts) | U | U | U |
| PI03 / 53.11 | Per-user install/launch/update/rollback/uninstall retention/remove choice/trust disclosure | [windows-release-transaction.test.mjs](../scripts/tests/windows-release-transaction.test.mjs) | U | U | U |
| PI04 / 53.12 | Linux+native Windows pinned CI and controlled failure prevents merge | [platform-build.yml](../.github/workflows/platform-build.yml) | U | U | U |

## WSL and ports

| ID / owner | Flow to exercise | Test or measurement starting point | Linux | Native Windows | WSL |
| --- | --- | --- | --- | --- | --- |
| WP01 / 53.5 | Selected distro/shell/directory/exact resume, absent/removed distro errors/coexistence | [windows-wsl-systemd-spike.mjs](../scripts/test/windows-wsl-systemd-spike.mjs) | U | U | U |
| WP02 / 53.5 | Restricted UID/root/net/FD profile/provider/workspace/bridge four teardown modes | [wsl-root-profile.py](../scripts/test/fixtures/wsl-root-profile.py) | U | U | U |
| WP03 / 53.5 | Authenticated scoped stdio bmn relay, bounded file delivery/distribution path identities | [wsl-restricted-profile-spike.mjs](../scripts/test/wsl-restricted-profile-spike.mjs) | U | U | U |
| WP04 / 53.5 | Terminfo resolves in selected distro, two distro isolation/native interop constraints | [windows-wsl-systemd-spike.mjs](../scripts/test/windows-wsl-systemd-spike.mjs) | U | U | U |
| WP05 / 53.10 | Native/WSL server ownership/PID reuse/denials/bounded scans/live browser/stale removal | [windows-session-ports.mjs](../scripts/test/windows-session-ports.mjs) | U | U | U |

## Changes merged during the port

`6eeaf95` exposes Cursor and repairs notification usability; WS05/WS10/AC04/AC10
retain that scope. `4c2a126` adds abbreviation lookup, palette launch editing and
response-card navigation; CN02/WS06/AC03 explicitly cover those Epic 55 contracts.
Epics 50–52 remain represented by TG03/TG04, CN01/TP05 and CN03/CN04/CN05;
their other runs keep their own installed/provider acceptance state.

The merged Epic 54 behavior is represented explicitly: inspect panels without
terminal reflow (TP04/TP05/AC05/FR04), edit/cancel launch settings (WS06), narrow-pane
Find (TP05), once-only reviewed draft delivery (AC07/FR03/TG02), collision-free
backup export (BK02), and readable/unlaunchable archives (WS02/WS12).
This mapping does not accept the separate Epic 54/55 installed runs.

README shortcut descriptions and feature-guide mouse-reporting behavior require
reconciliation against the running terminal (TP06/TP08). Public Windows support,
Linux-only launcher wording, roots and transport descriptions must be updated with
tested routes at release; PI02/PI03 and WP01–WP04 own those changes.

## Final reconciliation

Before story 53.13 acceptance, compare the final integration commit with this
candidate and its feature-guide/README hashes. Add every newly merged capability
under an owning 53.x story before closure. Review all rows against the original
story criteria, exercise everyday multi-session work on both installed packages,
and keep gaps open. Manual evidence includes microphone/CPU, notifications,
clipboard/IME/scaling, installation/update and WSL where relevant. CI only proves
what it actually exercised; no automated or hardware result is inferred here.
