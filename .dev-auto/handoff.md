# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epics 15, 16 and 18 (Epic 17, also in the `15-18` range, was accepted on 2026-09-21 and is excluded as already done).
- Original request and intended outcomes: `/dev-auto 15-18` (2026-09-21). Epic 15 "Attention from Any Harness" (`epics.md:767-814`): 15.2 `bmn hooks check|install`, 15.1 OSC 9/99/777 notices. Epic 16 "A Handoff an Agent Can Ask For" (`epics.md:815-862`): 16.1 `bmn handoff` prepares an owner-delivered draft, 16.2 truthful provenance and bounded receipts. Epic 18 "OpenCode, Fully Supported" (`epics.md:910-1009`): 18.1 plugin + `bmn hook opencode`, 18.2 conversation capture and Resume. Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15-18`). `opencode upgrade` to the latest 1.18.x is authorized for Epic 18 (`epics.md:915` NFR23, owner 2026-09-21). Owner, 2026-09-21, mid-run: "finish everything autonomously, I'm going to bed. Double check everything with GLM and GLM flash models. just ot be sure. when you're confident you can update local and push to GH", "if you face serious issues - consult with Astra", then "follow normal dev-auto reviews" and "GLM/GLM-Flash for EXTRA reviews!" — this authorizes autonomous completion, the normal per-epic Astra review plus extra GLM/GLM-Flash second opinions, pushing `main` to `origin` and `pnpm run update:desktop` once the reviews leave no blocking finding, with gpt-6-astra as the escalation. Merge is still unauthorized. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Normal dev-auto route: each epic's strong review is gpt-6-astra/medium, with GLM-5.3/max and GLM-5.3-Flash/max read-tool runs as the owner's extra second opinions (owner, 2026-09-21: "follow normal dev-auto reviews", "GLM/GLM-Flash for EXTRA reviews!").
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `8cb84739-653a-4e46-bc7d-4329aca415c1`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). `epic-15`, `epic-16` and `epic-18` and all six stories are `backlog`; `epic-17` is `done`. Delivery order: 15.2, 15.1, then 16.1, 16.2, then 18.1, 18.2 (18 depends on 15.2 for the installer).
- Baseline `73942b8` (clean tree; Epic 17's `pnpm run update:desktop` reported COMPLETE for `73942b8` at 2026-09-21T18:19:24Z).
- Implemented: nothing yet.
- Associated loop: none. Active native helpers: none. Terminal helpers: none yet.

## Decisions and findings

- Original or approved intent changes: none yet.
- Material pending findings: none yet.
- Cross-epic obligations: migrations — 12 is taken by 17.1; 16.1 takes the next free number and 18.2 the one after. Epic 10 later takes what remains. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening beyond `handoff.prepare`'s one destination address, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no terminal remount or refit, nothing starts a process without an owner action.
- Owner-presence items (cannot be automated): Epic 18.1 AC5 and 18.2 AC4 need one real OpenCode run inside BMN for the permission flow and resting titles; until then those claims stay DOCUMENTED/UNVERIFIED.

## Evidence

- Checks run and observed results: none yet.
- Tests: none yet.
- Reviewed scope and route: none yet.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `73942b8`.
- Unreviewed or unverified areas: everything in scope.

## Measurement

- Timing: started 2026-09-21T21:25+03:00.
- Dispatches: none yet.
- Owner interventions: none.
- Observed usage: lead `claude-opus-5[1m]`, session `~/.claude/projects/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1.jsonl`; to be read at acceptance.

## Resume

- Next safe action: read the current `bin/bmn` hook code and `control-cli.test.ts` harness, then implement story 15.2 (`bmn hooks check|install`).
- Status: ACTIVE — Epics 15, 16 and 18 selected; baseline `73942b8`; no code changes yet.
