# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epics 15, 16 and 18 (Epic 17, also in the `15-18` range, was accepted on 2026-09-21 and is excluded as already done).
- Original request and intended outcomes: `/dev-auto 15-18` (2026-09-21). Epic 15 "Attention from Any Harness" (`epics.md:767-814`), Epic 16 "A Handoff an Agent Can Ask For" (`epics.md:815-862`), Epic 18 "OpenCode, Fully Supported" (`epics.md:910-1009`). Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15-18`). `opencode upgrade` to the latest 1.18.x is authorized for Epic 18 (`epics.md:915` NFR23, owner 2026-09-21). The owner's mid-run instructions of 2026-09-21, quoted verbatim in `.dev-auto/log.md`, authorize: finishing the scope autonomously overnight; the normal per-epic dev-auto review plus extra GLM-5.3 and GLM-5.3-Flash second opinions; escalating serious issues to gpt-6-astra; and, once the reviews leave no blocking finding, pushing `main` to `origin` and running `pnpm run update:desktop`. Merge is still unauthorized. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Normal dev-auto route: each epic's strong review is gpt-6-astra/medium, with GLM-5.3/max and GLM-5.3-Flash/max read-tool runs as the owner's extra second opinions (owner, 2026-09-21: "follow normal dev-auto reviews", "GLM/GLM-Flash for EXTRA reviews!").
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `8cb84739-653a-4e46-bc7d-4329aca415c1`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). `epic-15` in-progress, both stories `review`; `epic-16` and `epic-18` and their four stories backlog; `epic-17` done. Order: 15.2, 15.1, 16.1, 16.2, 18.1, 18.2 (18 depends on 15.2).
- Baseline `73942b8` (clean tree; Epic 17's `pnpm run update:desktop` reported COMPLETE for `73942b8` at 2026-09-21T18:19:24Z). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`, the review repairs in the commit below; the file-by-file lists are in `.dev-auto/log.md`.
- Associated loop: none. Active native helpers: none. Terminal helpers: none yet.

## Decisions and findings

- Original or approved intent changes (each argued in `.dev-auto/log.md`; all four were put to the three reviewers and all three agreed): 15.2 exits 2 for an unknown agent, not 1; 15.1 adds no control-socket method, because the epic's preload/main/utility route is `CompanionService.route` here; the hooks code lives inside `bin/bmn`, which `epics.md:790` allows; and `hooks` follows `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when the owner has moved that directory.
- Material pending findings: one rejected with its reasoning, none open. Three rounds of review and two rechecks; the second recheck refused `e8f2628` for a P1 regression my own dangling-symlink fix introduced (a symlinked parent sent the write to an unrelated file) and for seven new recogniser false positives. Both closed in wave 3, which replaces the recogniser with a defined grammar and adds a differential test that runs 36 command shapes through a real bash and requires `hooks check` to agree. Astra's focused recheck of `8392017` reopened findings 5, 6 and 7 and found one new gap in the notice queue; 6, 7 and the queue gap are now closed in the second repair wave. **Finding 5 (a writer that saves between BMN's final check and its rename still wins) is rejected as unclosable**, and Astra accepted that reasoning explicitly, ruling out `RENAME_NOREPLACE`, `RENAME_EXCHANGE`, `O_TMPFILE` and advisory locks in turn. Narrowed to two adjacent syscalls and refused in the common case; the racing edit is lost and the backup does not contain it, which `docs/agent-control.md` now says plainly instead of claiming recovery. Everything else is closed with a test and a fence; the full list is in `.dev-auto/log.md`. Epic 15's three reviews raised 15 material findings between them; every one is closed with a test, and each guard with a mutation fence. The full disposition list is in `.dev-auto/log.md` (2026-09-22 entry); two reviewer suggestions were rejected there with their reasons.
- Cross-epic obligations: migrations — 12 is taken by 17.1, 16.1 takes 13 and 18.2 takes 14; Epic 10 later takes what remains. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items (cannot be automated): Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN; those claims stay UNVERIFIED until then.

## Evidence

- Checks: `checks-e8f2628.log` is the last full set against a committed revision with a clean tree — lint, typecheck, unit (1260 passed / 1 skipped), Electron and visual all exit 0, and the `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}`, which is AC5's "never refits" measured on both sides of a real second notice. Wave 3's own set is `checks-wave3.log` (lint, typecheck, unit 1277 passed / 1 skipped) pending its Electron and visual run.
- Tests: 15.2 has 56 tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including the event-list drift fence, 31 pinned recognition cases, and a differential test that runs 36 command shapes through a real bash with a stub `bmn` and requires `hooks check` to agree — a wired verdict the shell contradicts fails outright; a missed one is allowed only for two listed, explained exceptions. 15.1 has 10 parser tests and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-1.log` (15 RED), `fences-15-2.log` (12 RED, 2 GREEN, 1 NOTE over 15 probes, both GREENs explained in the log), the repair waves in `fences-15-repair*.log` (22 RED, one re-probed) and `fences-15-wave3.log` (9 RED). Astra checked four of the new tests and was right that they are coverage rather than regression fences; they are recorded as coverage in the log, not claimed as fences.
- Reviewed scope and route: `73942b8..a25ed3f` reviewed three times read-only (gpt-6-astra/medium as the normal dev-auto reviewer, GLM-5.3/max and GLM-5.3-Flash/max as the owner's extra second opinions), then two focused gpt-6-astra/medium rechecks of the repair deltas. Receipts, routes and usage in `.dev-auto/log.md`; files under `.dev-auto/evidence/epic-15/reviews/`.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `73942b8`; reviewed at `a25ed3f`; first repair wave `8392017`, rechecked and found not acceptable; second repair wave in the commit after it, which is the revision to accept. Every disposition is in `.dev-auto/log.md`.
- Unreviewed or unverified areas: Epics 16 and 18 entirely. The repair wave itself has not yet had its delta recheck.
- Pre-existing flake, reproduced at the baseline `73942b8` in a clean worktree and not caused by this scope: `companion-service.test.ts > refused agent requests > 'trims back to the newest refusals…'` times out roughly one run in four. Details and the two one-off timeouts are in `.dev-auto/log.md`.

## Measurement

- Timing: started 2026-09-21T21:25+03:00; Epic 15's review round ran 2026-09-22 overnight.
- Dispatches: three read-only Epic 15 reviews of `a25ed3f` (gpt-6-astra/medium via Codex CLI; GLM-5.3/max 101 turns $4.62 and GLM-5.3-Flash/max 89 turns $3.72, both via Claude CLI on the GLM profile with `Read,Grep,Glob` only), plus one gpt-6-astra/medium recheck of `a25ed3f..8392017`. Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: none.
- Observed usage: lead `claude-opus-5[1m]`, session `~/.claude/projects/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1.jsonl`; to be read at acceptance.

## Resume

- Next safe action: commit wave 4, run its Electron and visual set against the committed revision, and take one more focused recheck before accepting Epic 15; then implement Epic 16 from `scratchpad/epic-16-plan.md`.
- Status: ACTIVE — Epic 15 in its fourth repair wave after three rechecks refused it; Epics 16 and 18 not started.
