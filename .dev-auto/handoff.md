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
- Baseline `73942b8` (clean tree; Epic 17's `pnpm run update:desktop` reported COMPLETE for `73942b8` at 2026-09-21T18:19:24Z). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`, then five repair waves: `8392017`, `e8f2628`, `c5ef4d7`, `8a0ae46`+`36a89d8`, and `b342658`, which is the revision under review. File-by-file lists are in `.dev-auto/log.md`.
- Associated loop and native helpers: none.
- **In flight (do not re-dispatch)**, all read-only against clean committed `b342658`, prompts and receipts under `/tmp/claude-1000/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1/scratchpad/reviews/`: Astra recheck 5 (`epic-15-recheck5-*`, task `bcce7tg01`), GLM-5.3/max (`epic-15-extra5-glm53.json`, task `boyrtnarf`), GLM-5.3-Flash/max (`epic-15-extra5-glmflash.json`, task `bipiirwxz`). The tree stays unedited until all three are back — `scratchpad/who-reads-the-tree.sh` reports whether anything is still reading it.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by all three reviewers (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route` rather than a new control method; the hooks code living inside `bin/bmn`, which `epics.md:790` allows; and `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- Material pending findings: one rejected, none open, three verdicts outstanding on `b342658`. Three full reviews of `a25ed3f` and four Astra rechecks each refused acceptance over real defects, as did a GLM-5.3 second opinion on `36a89d8`. Between them they found the same class of symlink defect three times — the last being the `..` in the path BMN is *given*, collapsed by `resolve` before the resolver could see it — and a whole category the test's own stub was too permissive to show: an entry that runs but can never report, because the hook event arrives only on standard input. Every finding is closed with a test, and each guard with a mutation fence. **Finding 5 (a writer saving between BMN's final check and its rename still wins) is rejected as unclosable** and Astra accepted that reasoning, ruling out `RENAME_NOREPLACE`, `RENAME_EXCHANGE`, `O_TMPFILE` and advisory locks; `docs/agent-control.md` says the racing edit is lost and the backup does not contain it. Every disposition is in `.dev-auto/log.md`.
- Epic 15 is not accepted until a recheck returns without a blocking finding.
- Cross-epic obligations: migrations — 12 is taken by 17.1, 16.1 takes 13, 18.2 takes 14. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items: Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN; UNVERIFIED until then.

## Evidence

- Checks: `.dev-auto/evidence/epic-15/checks-b342658.log` — lint, typecheck, unit (1,340 passed / 1 skipped over 88 files), Electron and visual all exit 0 against committed `b342658`, tree recorded clean at the start and the end, load 1.6. Its `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — AC5's "never refits" measured on both sides of a real second notice.
- **Discarded evidence:** `DISCARDED-checks-8a0ae46-tree-edited-mid-run.log` describes no committed revision, and the two GLM runs of 02:17 read a tree that changed under them; all three are leads I verified myself, never cited as evidence. `scratchpad/who-reads-the-tree.sh` now runs before the first edit of a wave.
- Tests: 15.2 has 188 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5): the event-list drift fence, the recognition table, symlink fixtures for all three shapes of the resolution defect, and a differential test whose stub now holds the real binary's contract — exactly one agent, the event on stdin — so a shape that runs but could never report is visible. A wired verdict the shell contradicts fails outright; a missed one only for the listed exceptions, each of which must still be seen to run. 15.1 has 10 parser and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-*.log` — 80 RED probes in all. Wave 5's own set is 19 probes, 18 RED, and the one GREEN found a dead rule of mine, now removed with the real guard fenced separately and RED. The two earlier GREENs and one NOTE are explained in the log, and four tests Astra checked are recorded as coverage rather than fences.
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

- Next safe action: collect the three reviews of `b342658`, disposition every finding, and either repair or accept Epic 15; then implement Epic 16 from `scratchpad/epic-16-plan.md`.
- Status: ACTIVE — Epic 15's fifth wave is committed and under three concurrent reviews; Epics 16 and 18 not started.
