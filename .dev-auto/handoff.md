# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epics 19–21, six stories, owner `$dev-auto 19-21` (2026-09-23).
- Original request and intended outcomes: `_bmad-output/planning-artifacts/epics.md:1018-1175`; clean child sessions, OpenCode subagent asks, glanceable sidebar, repeat watch. Decisions/measurements: `_bmad-output/planning-artifacts/reference-context-19-21.md`.
- Mode: build
- Stopping condition: selected Epics 19–21 accepted; no automatic time limit. Owner requested autonomous work for two hours, not a stop deadline, and later said continue.
- Explicit user stop: none
- Restrictions and authorization boundaries: `$dev-auto 19-21` and project `AGENTS.md` authorize local implementation/checks/task commits; no push, merge, deployment or desktop update authorization. Preserve unrelated work. Project `AGENTS.md` forbids packaging while packaged BMN runs and requires `pnpm run update:desktop` only after commit and push to main. Configured GLM/Codex/Claude routes authorized by the dev-auto skill; no other provider.
- Decision/history log: `.dev-auto/log.md` append-only. Raw receipts under ignored `.dev-auto/evidence/epics-19-21/` and `.dev-auto/evidence/epic-20/`.
- Lead host / requested model / observed model: Codex API / no owner-requested model / gpt-6-sol/xhigh, rollout `01a0ce20-bc21`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml:107-120` (ignored local) marks Epics 19–21 and all six stories `done`, atomically written/read back. Baseline HEAD was `0dc003b`, initial worktree clean. Checked product source/docs committed locally as `49e7a36`; no post-review product edit or unrelated tracked change.
- Implemented: 19.1 exact-key inherited agent/terminal identity filter and fresh BMN credentials; 19.2 OpenCode child/sibling permission/question slots; 20 workspace attention dot, dormant styling, hover/focus menus and palette liveness; 21 Claude failure hook and canonical fingerprints, bounded repeat counting/log, one app-owned notice at eight calls. README and architecture/features/agent-control docs updated.
- Active helpers: none; five implementation helpers and three independent reviewers returned. Four GLM first routes failed EAI_AGAIN with no edit/$0; native fallback routes completed. Observed models/usage in `.dev-auto/log.md` under “Observed run usage”.
- Associated loop: none.

## Decisions and findings

- Original or approved intent changes: none.
- Material review findings: Epic 19 full review found none. Epic 20 full review found missing selected-exited/interrupted visual cases and grayscale keyboard focus proof; all CLOSED by two focused rechecks, final visual-only recheck against sha256 `9023281f0d7e554e2d86e21327129ead11fd786a384873d14960c6ce63b086b9`. Epic 21/project full review found owner-resolution race losing a hook record and premature PTY input sampling; both CLOSED by focused recheck with RED/GREEN race and RED PTY guard evidence. No open material findings; aggregate NFR24–28/pattern review found no drift.
- Documented limits: OpenCode Go subscription inactive and live owner plugin absent, so provider-backed dev-BMN event log, OpenCode environment and subagent navigation are UNMEASURED/UNVERIFIED as allowed by 19.1/19.2 conditional measurements. Isolated OpenCode 1.18.31 TUI startup emitted no `session.idle` or `session.status`. Owner three-second orientation assessment UNVERIFIED. The 1,000,000-character fingerprint cut is code-inspected but not runtime tested; all normal canonicalization cases tested. No tool input/output persisted.

## Evidence

- Full unit at final product code: 89 files, 1550 PASS/1 SKIP, `.dev-auto/evidence/epics-19-21/unit-after-review.log` sha256 `f61b0fcb88c6dbedf854781e159c6fc7c432a6dce5ab578227e7c4f33e08e8fd`. Typecheck, lint (after final visual edit), node syntax and `git diff --check` PASS.
- Electron full gate exit 0: `.dev-auto/evidence/epics-19-21/electron-after-review.log` sha256 `46107b738ac81fe1007525bfa0dc5c195605dc1269dadacd158ac12ce40cfe7d`. Receipt proves OpenCode child requests, workspace attention, actual interrupted selected styling, three-call log, eight-call notice/provenance/withdrawal and zero PTY input after notice. 19.1 isolated live-shell env grep printed only `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`: `session-env-runtime-final.log` sha256 `8bacdc2d01997f8c45216690c3e583ea59c47edb4b2082c4501f376da14aee61`.
- Visual full gate exit 0: `.dev-auto/evidence/epics-19-21/visual-interrupted-pass.log` sha256 `92ff9dfc6594dc47cc213f6a4bf6666af290439706deffbf40da058ad922c45c`; JSON `.dev-auto/evidence/epic-5/runtime-evidence.json` sha256 `d07da10649c76ba8f419a7e6188b8566e4218e590d81895f585b37477001eaf1`. Black/Knight and Black/Cross screenshots inspected: live, exited, interrupted, exited-with-question and selected-exited rows together; grayscale selected bar, white keyboard focus ring and workspace dot.
- Race test original candidate RED `repeat-race-red.log` sha256 `61552099ff0eb2c0dd0f22f95437e87a46e2de5773f98a609932709b373039ac`; repaired GREEN `repeat-race-green.log` sha256 `1e0ca095463ee3620c2845eba35571c6518f8b9331d76f7cde7a629cd1e091f5`. Real xterm key made zero-PTY guard RED `repeat-pty-guard-red.log` sha256 `aa0cb93593ed1688996d38ad557de35a78ac755f0aef09579372dac11490ff91`.
- Reviewed revision: baseline `0dc003b`; original product diff sha256 `1d22ed8d49517c23e7cb56a5f8e01256ac4b0cb2a7a630a6661bf1d92a2b2650`; first repair sha256 `451cbbda1ecb0ac3c7d5e1c91fba5c707f0e52a5f8f03a93d6922d2a284bb767`; final product candidate `.dev-auto/evidence/epics-19-21/candidate-after-visual.diff` sha256 `9023281f0d7e554e2d86e21327129ead11fd786a384873d14960c6ce63b086b9`. Full reviews and focused rechecks all returned RESULT: done; dispositions in log.

## Measurement

- Timing: started about 2026-09-23 15:00 Europe/Kyiv; selected acceptance finished after owner’s later “continue”, about 3h44m elapsed.
- Lead observed `gpt-6-sol/xhigh`; final `scripts/check.py usage` snapshot 79,839,303 cumulative tokens (79,063,552 cached), rollout `01a0ce20-bc21`. Five native implementation helper receipts: gpt-6-astra/low (four) and gpt-5.6-luna/max (one). Three reviewer receipts: gpt-6-astra/medium (Epics 19/20) and high (Epic 21+aggregate). GLM first routes unavailable/EAI_AGAIN, $0; Claude failure measurement GLM-5.3-Flash total $0.048670. Exact IDs, tier escalations and per-rollout usage in log. Codex receipts do not report dollar cost. No receipt gap.
- Observed usage: lead 79,839,303 cumulative tokens (79,063,552 cached); five implementation helper and three reviewer per-rollout usages recorded in `.dev-auto/log.md` “Observed run usage”; four GLM failures $0, Claude Flash measurement $0.048670. No gap.
- Owner interventions: initial scope request; autonomous-work instruction; later “continue”. No approval request. BMN cockpit mirror failed EPERM once, so no retry per skill.

## Resume

- Next safe action: none
- Status: COMPLETE — Epics 19–21 and all six stories accepted; implementation commit `49e7a36` local, checks and reviews passed, four material findings closed.
