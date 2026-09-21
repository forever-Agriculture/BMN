# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 17 (stories 17.1 and 17.2).
- Original request and intended outcomes: `/dev-auto 17` (2026-09-21). Epic 17 "Surviving the Update Loop": one dialog after an update or quit resumes the sessions that stop interrupted (17.1), and a recreated terminal view keeps the program's DECSET modes (17.2). Source: `epics.md:863-909`, design `reference-context-15-18.md:76-82`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 17`). Push, merge and `pnpm run update:desktop` need separate authorization and are NOT granted for this run (the Epic 12 grant named that run's work only). Never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `ccb2a99f-8c8f-4c93-824a-00b324e8f403`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); `epic-17`, `17-1-resume-what-the-stop-interrupted` and `17-2-terminal-modes-survive-a-recreated-view` are `done`; `epic-17-retrospective` stays `optional`. Next in the owner's order: 15, then 16, 18, 10.
- Baseline `a3c92ae`. Committed: `ed76aab` (17.1), `63b9b3c` (17.2), `754879c` and `92c4199` (review repairs). Tree clean at `92c4199`; nothing pushed.
- 17.1 implemented: cohort vocabulary and three `session.cohort.*` methods, `interrupted-cohort.ts` selector, store reads plus migration 12 (`cohort_offered_at`), `resumeCohort` coordinator and `requireConfirmedCommand` in `session-manager.ts`, pty-host dispatch, three IPC handlers, `ResumeInterruptedDialog` with pure presentation, the one-time offer effect and the palette command, README and `docs/architecture.md`.
- 17.2 implemented: `decset-modes.ts` tracker read in `onPtyData` and cleared in `onPtyExit`, `modes` on the attach result through `SessionResumeResult`/`SessionCohortStartedProcess`/preload, `TRACKED_DECSET_MODES` and `decsetRestoreSequence` in `shared/protocol/src/terminal.ts`, the renderer restore after `terminal.open`, `docs/architecture.md`.
- Associated loop: none. Active native helpers: none.
- Active native helpers: none. Terminal helpers: three Codex Astra runs, all returned; receipts `review-17-astra.json`, `recheck-17-astra.json`, `recheck2-17-astra.json` in the session scratchpad.

## Decisions and findings

- Original or approved intent changes: 17.2 AC2 lists mode `1005` among the tracked DECSET modes. xterm 6.0.0 ignores `?1005h` and `?1005l`, so a view's encoding never follows them and carrying 1005 could only restore an encoding the view is not in, or drop the SGR encoding the program really uses (review finding 2, second round). BMN therefore tracks the other eleven modes and says why at the declaration (`shared/protocol/src/terminal.ts`).
- Material pending findings and dispositions against `92c4199`:
  1. Explicitly disabled modes lost (a fresh xterm has autowrap and the cursor on) — CLOSED in `754879c`; reviewer re-probed xterm and accepted; runtime fence `electron-9-wrap-fence.log`.
  2. Mouse protocol and encoding treated as independent flags — CLOSED. The protocol half was repaired in `754879c` (both reviewer reproductions pass); the encoding half regressed there, was reported unresolved, and was repaired in `92c4199` by dropping the mode xterm ignores. The reviewer re-probed the final tracker against xterm 6.0.0 — `1000h→1006h→1005l`, `1000h→1006h→1005h` and `1000h→1006h→1003h→1002h` all match live and restored — and closed it.
  3. A cohort stamped as offered although another dialog kept it from opening — CLOSED in `754879c`; reviewer accepted, noting it did not exercise the overlap in Electron.
  4. A retried action re-adopting an attachment renderer recovery had revoked — CLOSED in `754879c`; reviewer checked the early return loses no cwd, executable, dimensions or `processState`, and did not run the whole retry-after-recovery flow.
- Cross-epic obligations: migration 12 taken by 17.1 (Epic 10 takes 13). The `resumeCohort` coordinator lives in `session-manager.ts` and reuses `resume`/`relaunch`, never `session.create`, so Epic 10.2 can share it. B3: nothing starts without the owner's button. 17.2 writes modes to the new xterm only, never to the PTY, and asks for no second redraw.
- `tsc -b` for `@bmn/protocol` can leave a stale `dist` after a fence restore, because the restored source keeps the backup's older mtime. Touch the protocol sources before trusting a build that follows a mutation.

## Evidence

- Checks on `92c4199`: `pnpm run test:unit` 1183 passed / 1 skipped (`unit-repairs.log` b5118a3e); `pnpm run lint` and `pnpm run typecheck` clean; `pnpm run test:electron` exit 0 (`electron-10-encoding.log` 993c93fe); `pnpm run test:visual` PASS (`visual-encoding.log` 2f80d9ae).
- 17.2 AC1 test-before-fix evidence: `.dev-auto/evidence/epic-17/electron-2-modes-red.log` (modes lost, `pasteArrivedBare: true`, no focus report) — sha256 71e29c2f.
- Final Electron run: `electron-7-clean-build.log` (sha256 8d8bca94); its receipt proves `resumeOffer` and `terminalModes`, both now enforced by `scripts/test/electron-self-test.mjs`.
- Mutation probes: `fences-17-1.log` (sha256 44de6347, 13 RED plus a NOTE on the one claim held by three guards), `fences-17-2.log` (c6579256, 6 RED) and `fences-repairs.log` (1c7b3cf1, 9 RED, one per repaired guard).
- Other receipts: `unit-final.log` fa8277f1, `lint-final.log` 02d29765, `visual-final.log` 0bfe27af, earlier runs `electron-1.log` b3d07213 and `electron-3..6`.
- Reviewed scope and route: Epic 17 `a3c92ae..63b9b3c`, then the repair deltas `63b9b3c..754879c` and `754879c..92c4199`, all Codex Astra medium read-only.
- Runtime fence for the repair: `electron-9-wrap-fence.log` (e40f9883) reproduces finding 1 through the self-test and shows the new assertion catching it.
- Unreviewed or unverified areas: a real `pnpm run update:desktop` cycle (the self-test simulates the stop and the next start); the resume dialog has no screenshot in the visual layer, matching the Hook events dialog precedent (`scripts/test/electron-visual.mjs:1231-1233`).

## Measurement

- Timing: started 2026-09-21T15:20+03:00; finished 2026-09-21T16:00+03:00 local. Commits `ed76aab`, `63b9b3c`, `754879c`, `92c4199`.
- Dispatches:
  - Epic 17 full review | epic-review | gpt-6-astra/medium | ~/.codex/sessions/2026/09/21/rollout-2026-09-21T15-19-38-01a0c3e8-56c6-7813-9a91-cc37f820bf52.jsonl | first
  - Recheck of the four findings | epic-review | gpt-6-astra/medium | ~/.codex/sessions/2026/09/21/rollout-2026-09-21T15-46-17-01a0c400-bbef-7e10-817f-5be61ca20aea.jsonl | first
  - Recheck of finding 2 | epic-review | gpt-6-astra/medium | ~/.codex/sessions/2026/09/21/rollout-2026-09-21T15-52-57-01a0c406-d4f0-7db3-99bf-94e58582272d.jsonl | first
- Owner interventions: none.
- Observed usage: lead `claude-opus-5/xhigh`, 369 responses, 269,835 output and 79,381,672 cache-read tokens (`~/.claude/projects/-home-oleksandr-code-BMN/ccb2a99f-8c8f-4c93-824a-00b324e8f403.jsonl`; one `<synthetic>/unavailable` route with no usage). The three `gpt-6-astra/medium` reviews, in dispatch order: 1,272,013 / 602,300 / 236,291 total tokens (6,569 / 4,087 / 2,376 output). Every dispatch ran the requested route; no substitutions or failures.

## Resume

- Next safe action: none for Epic 17. The next epic in the owner's order is 15, which needs its own `/dev-auto` run. Pushing `ed76aab..92c4199` to `origin/main` and running `pnpm run update:desktop` need the owner's authorization.
- Status: COMPLETE — Epic 17 accepted: both stories implemented, all four review findings closed with evidence, every check layer green at `92c4199`, board updated; nothing pushed.
