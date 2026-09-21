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

- Original or approved intent changes (reasoning in `.dev-auto/log.md`; all four were put to the three reviewers and all three agreed with each):
  1. 15.2: an unknown agent name exits 2, not 1 — `epics.md` AC1 extends exit 1 only to "missing or unreadable", against the looser prose at `reference-context-15-18.md:86`.
  2. 15.1: no control-socket method. The epic's preload/main/utility route is `CompanionService.route` here, not the agents' socket; a socket method would have let any token open `osc:`-labelled rows.
  3. 15.2: the hooks code lives inside `bin/bmn`, which `epics.md:790` allows; `electron-builder.yml:17-20` ships only the two CLI files.
  4. 15.2: `hooks` follows `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when the owner has moved that directory, not only `~/.claude` and `~/.codex` as the AC spells them.
- Material pending findings: none open. Epic 15's three reviews raised 15 material findings between them; every one is closed with a test, and each guard with a mutation fence. The full disposition list is in `.dev-auto/log.md` (2026-09-22 entry); two reviewer suggestions were rejected there with their reasons.
- Cross-epic obligations: migrations — 12 is taken by 17.1; 16.1 takes the next free number and 18.2 the one after. Epic 10 later takes what remains. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items (cannot be automated): Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN for the permission flow and resting titles; until then those claims stay DOCUMENTED/UNVERIFIED.

## Evidence

- Checks on the repair revision: `pnpm run lint` and `pnpm run typecheck` exit 0 (`lint-15r.log`, `typecheck-15r.log`); `pnpm run test:unit` 88 files, 1248 passed / 1 skipped (`unit-15r.log`); `pnpm run test:electron` exit 0 (`electron-15r.log`); `pnpm run test:visual` PASS (`visual-15r.log`). The `terminalNotice` receipt reads `openedBy: osc:9`, `provenance: "from the terminal (OSC 9)"`, `ptyInputEvents: 0`, `hookedSessionRows: 1`, the suppressed `{agent: terminal, event: osc:9, effects: []}` row, `resolvedBy: input`, and now `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — AC5's "never refits" measured on both sides of a real second notice rather than asserted nowhere.
- Tests: 15.2 has 34 tests through the real binary against temp-folder fixtures and a temporary HOME (no owner data, AC5), including the drift fence that drives `bmn hook` with every event `bmn hooks check --json` lists. 15.1 has 10 parser tests and 16 service tests. Untested behavior: `writeAtomically`'s crash window (no test-observable difference from a direct write; argued structurally and fenced through the leftover-temp assertion) and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-2.log` (12 RED, 2 GREEN, 1 NOTE across 15 probes — one GREEN was re-probed to RED after its assertion was fixed, the other is the atomic-write claim recorded as structurally untestable at the unit layer), `fences-15-1.log` (15 RED), and for the repair wave `fences-15-repair.log` (9/9 on the `bin/bmn` guards), `fences-15-repair2.log` (7/7 on the service guards) and `fences-15-repair3.log` (2/2 on the socket guards) — 18/18 RED.
- Reviewed scope and route: `73942b8..a25ed3f`, reviewed three times read-only — gpt-6-astra/medium as the normal dev-auto strong reviewer, plus GLM-5.3/max and GLM-5.3-Flash/max as the owner's extra second opinions. Receipts and sha256 in `.dev-auto/log.md`; files under `.dev-auto/evidence/epic-15/reviews/`.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `73942b8`; reviewed at `a25ed3f`; repairs land in the commit below, which is the revision to accept. Every disposition is in `.dev-auto/log.md`.
- Unreviewed or unverified areas: Epics 16 and 18 entirely. The repair wave itself has not yet had its delta recheck.
- Pre-existing flake, reproduced at the baseline and not caused by this scope: `companion-service.test.ts > refused agent requests > 'trims back to the newest refusals once an append carries it past the cap'` times out at ~5s in roughly one run in four; reproduced 1-in-4 in a clean worktree at `73942b8`. Two other ~5s timeouts (`voice-engine.test.ts` speech check, `saved-output-store.test.ts` ENOENT race) appeared once each under load and passed on the clean rerun.

## Measurement

- Timing: started 2026-09-21T21:25+03:00; Epic 15's review round ran 2026-09-22 overnight.
- Dispatches: three Epic 15 reviews of `a25ed3f`, all read-only. gpt-6-astra/medium via Codex CLI (the normal dev-auto strong review). GLM-5.3/max, 101 turns, $4.62, and GLM-5.3-Flash/max, 89 turns, $3.72, both via the Claude CLI on the GLM profile with `Read,Grep,Glob` only (the owner's extra second opinions). All three emitted only the harmless `[claude-code:unrecognized_model]` stderr line where applicable and returned complete JSON receipts.
- Owner interventions: none.
- Observed usage: lead `claude-opus-5[1m]`, session `~/.claude/projects/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1.jsonl`; to be read at acceptance.

## Resume

- Next safe action: run the focused Astra delta recheck of the repair commit, then accept Epic 15 and set both stories `done` on the board; then implement Epic 16 from `scratchpad/epic-16-plan.md`.
- Status: ACTIVE — Epic 15's three reviews are in and every finding is closed; the repair wave is committed and the full evidence set is green on it, delta recheck outstanding. Epics 16 and 18 not started.
