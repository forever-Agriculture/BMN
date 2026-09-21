# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epics 15, 16 and 18 (Epic 17, also in the `15-18` range, was accepted on 2026-09-21 and is excluded as already done).
- Original request and intended outcomes: `/dev-auto 15-18` (2026-09-21). Epic 15 "Attention from Any Harness" (`epics.md:767-814`), Epic 16 "A Handoff an Agent Can Ask For" (`epics.md:815-862`), Epic 18 "OpenCode, Fully Supported" (`epics.md:910-1009`). Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15-18`). `opencode upgrade` to the latest 1.18.x is authorized for Epic 18 (`epics.md:915` NFR23, owner 2026-09-21). The owner's mid-run instructions of 2026-09-21, quoted verbatim in `.dev-auto/log.md`, authorize finishing the scope autonomously overnight; the normal per-epic review plus extra GLM second opinions; escalating serious issues to gpt-6-astra; and, once the reviews leave no blocking finding, pushing `main` to `origin` and running `pnpm run update:desktop`. Merge is still unauthorized. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Normal dev-auto route: each epic's strong review is gpt-6-astra/medium, with GLM-5.3/max and GLM-5.3-Flash/max read-tool runs as the owner's extra second opinions (owner, 2026-09-21: "follow normal dev-auto reviews", "GLM/GLM-Flash for EXTRA reviews!").
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `8cb84739-653a-4e46-bc7d-4329aca415c1`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). `epic-15` in-progress, both stories `review`; `epic-16` and `epic-18` and their four stories backlog; `epic-17` done. Order: 15.2, 15.1, 16.1, 16.2, 18.1, 18.2 (18 depends on 15.2).
- Baseline `73942b8` (clean tree; Epic 17's `pnpm run update:desktop` reported COMPLETE for `73942b8` at 2026-09-21T18:19:24Z). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`, then four repair waves: `8392017`, `e8f2628`, `c5ef4d7`, and wave 4 as `8a0ae46` + `36a89d8`. `36a89d8` is the revision under review now. File-by-file lists are in `.dev-auto/log.md`.
- Associated loop and native helpers: none.
- **In flight (do not re-dispatch):** GLM-5.3/max on the recogniser and link resolver (task `b2fiqpz02`, receipt `epic-15-extra4-glm53.json` under `/tmp/claude-1000/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1/scratchpad/reviews/`). Astra's recheck 4 and the GLM-5.3-Flash opinion are both back and dispositioned.
- Wave 5 is in the working tree, unit-checked but not yet committed: it closes Astra's five new false positives, one I found myself, and GLM-5.3-Flash's four test-soundness points and six coverage gaps. Fences and the full evidence set wait for GLM-5.3 to stop reading the tree.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by all three reviewers (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route` rather than a new control method; the hooks code living inside `bin/bmn`, which `epics.md:790` allows; and `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- Material pending findings: one rejected, none open, GLM-5.3's verdict outstanding. Three full reviews of `a25ed3f` and four focused Astra rechecks (`8392017`, `e8f2628`, `c5ef4d7`, `36a89d8`) each refused acceptance over real defects, including a P1 data-loss regression of my own, which Astra has now confirmed closed against its own fixtures. Each finding is closed with a test and a mutation fence. **Finding 5 (a writer saving between BMN's final check and its rename still wins) is rejected as unclosable** and Astra accepted that reasoning, ruling out `RENAME_NOREPLACE`, `RENAME_EXCHANGE`, `O_TMPFILE` and advisory locks; `docs/agent-control.md` says the racing edit is lost and the backup does not contain it. Every disposition is in `.dev-auto/log.md`.
- Epic 15 is not accepted until a recheck returns without a blocking finding.
- Cross-epic obligations: migrations — 12 is taken by 17.1, 16.1 takes 13, 18.2 takes 14. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items (cannot be automated): Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN; those claims stay UNVERIFIED until then.

## Evidence

- Checks: `.dev-auto/evidence/epic-15/checks-36a89d8.log` is the last full set — lint, typecheck, unit (1,297 passed / 1 skipped over 88 files), Electron and visual all exit 0 against committed `36a89d8`, tree recorded clean at the start and the end. Its `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — AC5's "never refits" measured on both sides of a real second notice. Wave 5 needs its own set.
- **Discarded evidence:** `DISCARDED-checks-8a0ae46-tree-edited-mid-run.log` describes no committed revision — I edited source and tests while it ran. The two extra GLM runs of 2026-09-22 are in the same position and are recorded as leads I verified myself, not as reviews of a revision. Guard now run before the first edit of a wave: `scratchpad/who-reads-the-tree.sh`.
- Tests: 15.2 has 173 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5): the event-list drift fence, the recognition table, symlink fixtures for both P1 shapes, and a differential test that runs every listed shape through a real bash with a stub `bmn` and requires `hooks check` to agree — a wired verdict the shell contradicts fails outright, a missed one only for the listed exceptions, each of which must still be seen to run, and a runner that fails to start is its own problem rather than a silent "did not run". 15.1 has 10 parser and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-*.log` — 58 RED probes in all, with two GREENs and one NOTE explained in the log. Astra was right that four newer tests are coverage rather than regression fences; they are recorded as coverage.
- Reviewed scope and route: `73942b8..a25ed3f` reviewed three times read-only (gpt-6-astra/medium, plus GLM-5.3/max and GLM-5.3-Flash/max as the owner's extra opinions), then a focused gpt-6-astra/medium recheck of each repair delta. Receipts under `.dev-auto/evidence/epic-15/reviews/`.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `73942b8`; reviewed at `a25ed3f`; repair waves `8392017`, `e8f2628`, `c5ef4d7` each rechecked and refused; `36a89d8` is the revision proposed for acceptance and its recheck is in flight. Every disposition is in `.dev-auto/log.md`.
- Unreviewed or unverified areas: Epics 16 and 18 entirely.
- Pre-existing flake, reproduced at the baseline `73942b8` and not caused by this scope: `companion-service.test.ts > 'trims back to the newest refusals…'` times out roughly one run in four; details in `.dev-auto/log.md`.

## Measurement

- Timing: started 2026-09-21T21:25+03:00; Epic 15's review rounds ran 2026-09-22 overnight and through the morning.
- Dispatches: three read-only Epic 15 reviews of `a25ed3f` (gpt-6-astra/medium via Codex CLI; GLM-5.3/max $4.62 and GLM-5.3-Flash/max $3.72 via Claude CLI on the GLM profile with `Read,Grep,Glob` only), three gpt-6-astra/medium rechecks of the repair deltas, and the three in-flight runs listed under Progress. Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: none.
- Observed usage: lead `claude-opus-5[1m]`, session `~/.claude/projects/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1.jsonl`; to be read at acceptance.

## Resume

- Next safe action: wait for GLM-5.3 to finish reading the tree, then run the wave-5 mutation fences (`scratchpad/fences-15-wave5.json` and `-wave5b.json`), commit, run the full evidence set against the committed revision, and take recheck 5; then implement Epic 16 from `scratchpad/epic-16-plan.md`.
- Status: ACTIVE — Epic 15's fifth repair wave is in the tree after a fourth refused recheck; Epics 16 and 18 not started.
