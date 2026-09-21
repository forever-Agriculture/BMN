# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epics 15, 16 and 18 (Epic 17, also in the `15-18` range, was accepted on 2026-09-21 and is excluded as already done).
- Original request and intended outcomes: `/dev-auto 15-18` (2026-09-21). Epic 15 "Attention from Any Harness" (`epics.md:767-814`): 15.2 `bmn hooks check|install`, 15.1 OSC 9/99/777 notices. Epic 16 "A Handoff an Agent Can Ask For" (`epics.md:815-862`): 16.1 `bmn handoff` prepares an owner-delivered draft, 16.2 truthful provenance and bounded receipts. Epic 18 "OpenCode, Fully Supported" (`epics.md:910-1009`): 18.1 plugin + `bmn hook opencode`, 18.2 conversation capture and Resume. Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15-18`). `opencode upgrade` to the latest 1.18.x is authorized for Epic 18 (`epics.md:915` NFR23, owner 2026-09-21). The owner's mid-run instructions of 2026-09-21, quoted verbatim in `.dev-auto/log.md`, authorize: finishing the scope autonomously overnight; the normal per-epic dev-auto review plus extra GLM-5.3 and GLM-5.3-Flash second opinions; escalating serious issues to gpt-6-astra; and, once the reviews leave no blocking finding, pushing `main` to `origin` and running `pnpm run update:desktop`. Merge is still unauthorized. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Normal dev-auto route: each epic's strong review is gpt-6-astra/medium, with GLM-5.3/max and GLM-5.3-Flash/max read-tool runs as the owner's extra second opinions (owner, 2026-09-21: "follow normal dev-auto reviews", "GLM/GLM-Flash for EXTRA reviews!").
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `8cb84739-653a-4e46-bc7d-4329aca415c1`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). `epic-15` is `in-progress` with both stories `review`; `epic-16` and `epic-18` and their four stories are `backlog`; `epic-17` is `done`. Delivery order: 15.2, 15.1, then 16.1, 16.2, then 18.1, 18.2 (18 depends on 15.2 for the installer).
- Baseline `73942b8` (clean tree; Epic 17's `pnpm run update:desktop` reported COMPLETE for `73942b8` at 2026-09-21T18:19:24Z). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`, the review repairs in the commit below; the file-by-file lists are in `.dev-auto/log.md`.
- Associated loop: none. Active native helpers: none. Terminal helpers: none yet.

## Decisions and findings

- Original or approved intent changes (each argued in `.dev-auto/log.md`; all four were put to the three reviewers and all three agreed): 15.2 exits 2 for an unknown agent, not 1; 15.1 adds no control-socket method, because the epic's preload/main/utility route is `CompanionService.route` here; the hooks code lives inside `bin/bmn`, which `epics.md:790` allows; and `hooks` follows `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when the owner has moved that directory.
- Material pending findings: one rejected with its reasoning, none open. Astra's focused recheck of `8392017` reopened findings 5, 6 and 7 and found one new gap in the notice queue; 6, 7 and the queue gap are now closed in the second repair wave. **Finding 5 (a writer that saves between BMN's final check and its rename still wins) is rejected as unclosable**: there is no POSIX operation for "rename only if the target still holds these bytes", and closing it would need the other writer to take a lock that neither harness offers. Narrowed to the gap between two adjacent syscalls, refused in the common case, backup kept, and stated plainly in `docs/agent-control.md`. Everything else is closed with a test and a fence; the full list is in `.dev-auto/log.md`. Epic 15's three reviews raised 15 material findings between them; every one is closed with a test, and each guard with a mutation fence. The full disposition list is in `.dev-auto/log.md` (2026-09-22 entry); two reviewer suggestions were rejected there with their reasons.
- Cross-epic obligations: migrations — 12 is taken by 17.1, 16.1 takes 13 and 18.2 takes 14; Epic 10 later takes what remains. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items (cannot be automated): Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN for the permission flow and resting titles; until then those claims stay DOCUMENTED/UNVERIFIED.

## Evidence

- Checks on the repair revision: `pnpm run lint` and `pnpm run typecheck` exit 0 (`lint-15r.log`, `typecheck-15r.log`); `pnpm run test:unit` 88 files, 1248 passed / 1 skipped (`unit-15r.log`); `pnpm run test:electron` exit 0 (`electron-15r.log`); `pnpm run test:visual` PASS (`visual-15r.log`). The `terminalNotice` receipt reads `openedBy: osc:9`, `provenance: "from the terminal (OSC 9)"`, `ptyInputEvents: 0`, `hookedSessionRows: 1`, the suppressed `{agent: terminal, event: osc:9, effects: []}` row, `resolvedBy: input`, and now `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — AC5's "never refits" measured on both sides of a real second notice rather than asserted nowhere.
- Tests: 15.2 has 41 tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including the drift fence that drives `bmn hook` with every event `bmn hooks check --json` lists and the 15 hook-recognition cases. 15.1 has 10 parser tests and 17 service tests. Untested: `writeAtomically`'s crash window (no test-observable difference from a direct write; argued structurally) and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-2.log` (12 RED, 2 GREEN, 1 NOTE over 15 probes; one GREEN was re-probed to RED after its assertion was fixed, the other is the atomic-write claim recorded as structurally untestable), `fences-15-1.log` (15 RED), and for the two repair waves `fences-15-repair.log`, `-repair2.log` and `-repair3.log`.
- Reviewed scope and route: `73942b8..a25ed3f`, reviewed three times read-only — gpt-6-astra/medium as the normal dev-auto strong reviewer, plus GLM-5.3/max and GLM-5.3-Flash/max as the owner's extra second opinions — then a focused gpt-6-astra/medium recheck of the repair delta `a25ed3f..8392017`. Receipts and sha256 in `.dev-auto/log.md`; files under `.dev-auto/evidence/epic-15/reviews/`.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `73942b8`; reviewed at `a25ed3f`; first repair wave `8392017`, rechecked and found not acceptable; second repair wave in the commit after it, which is the revision to accept. Every disposition is in `.dev-auto/log.md`.
- Unreviewed or unverified areas: Epics 16 and 18 entirely. The repair wave itself has not yet had its delta recheck.
- Pre-existing flake, reproduced at the baseline `73942b8` in a clean worktree and not caused by this scope: `companion-service.test.ts > refused agent requests > 'trims back to the newest refusals…'` times out roughly one run in four. Details and the two one-off timeouts are in `.dev-auto/log.md`.

## Measurement

- Timing: started 2026-09-21T21:25+03:00; Epic 15's review round ran 2026-09-22 overnight.
- Dispatches: three read-only Epic 15 reviews of `a25ed3f` (gpt-6-astra/medium via Codex CLI; GLM-5.3/max 101 turns $4.62 and GLM-5.3-Flash/max 89 turns $3.72, both via Claude CLI on the GLM profile with `Read,Grep,Glob` only), plus one gpt-6-astra/medium recheck of `a25ed3f..8392017`. Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: none.
- Observed usage: lead `claude-opus-5[1m]`, session `~/.claude/projects/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1.jsonl`; to be read at acceptance.

## Resume

- Next safe action: finish the second repair wave's fences, re-run the full evidence set, commit, and take one more focused recheck before accepting Epic 15; then implement Epic 16 from `scratchpad/epic-16-plan.md`.
- Status: ACTIVE — Epic 15's recheck of `8392017` refused acceptance; the second repair wave closes everything it reopened except the one finding rejected as unclosable. Epics 16 and 18 not started.
