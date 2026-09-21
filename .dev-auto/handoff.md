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

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9, 11-14 `done`; `epic-17` and both its stories `backlog`. Order 17 -> 15 -> 16 -> 18 -> 10.
- Baseline `a3c92ae` (clean tree, `origin/main` identical).
- Implemented: nothing yet. Reading the code baseline for 17.1 (cohort, coordinator, dialog) and 17.2 (DECSET tracking, view recreation).
- Associated loop: none. Active native helpers: none. Collected terminal helper results: none.

## Decisions and findings

- Original or approved intent changes: none.
- Material pending findings: none.
- Cross-epic obligations: 17.1 needs the next free schema version after 11, so it takes migration 12 (Epic 10 then takes 13). 17.1's `resumeCohort` coordinator is the one Epic 10.2 later shares, so it must live in `session-manager.ts` and reuse `resume`/`relaunch`, never `session.create`. B3: nothing starts without the owner's button. 17.2 must never write mode sequences to the PTY, never remount or refit a terminal, and never ask the program to redraw twice. Docs pinned by tests change in the same story as the code.

## Evidence

- Checks run and observed results: none yet.
- Tests: none yet.
- Reviewed scope and route: none yet.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `a3c92ae`; nothing reviewed yet.
- Unreviewed or unverified areas: everything.

## Measurement

- Timing: started 2026-09-21T15:20+03:00.
- Dispatches: none yet.
- Owner interventions: none.
- Observed usage: not read yet.

## Resume

- Next safe action: finish reading the 17.1 and 17.2 code baseline, then implement 17.1 (cohort + coordinator + IPC + dialog) before 17.2.
- Status: ACTIVE — Epic 17 selected, baseline read, no edits yet.
