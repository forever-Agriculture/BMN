# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 11 (story 11.1).
- Original request and intended outcomes: `/dev-auto 11` (2026-09-20, Claude Code). Epic 11 "Recognizable Workspace Identity": an optional per-workspace marker (None, Slate, Teal, Blue, Violet, Rose) stored with revision validation, shown beside workspace names and in the pane heading of the pane's own workspace, without disturbing gold selection, white focus, orange attention, terminal geometry or the four palettes. Source: `_bmad-output/planning-artifacts/epics.md:438-464`, design contract `reference-context-8-12.md:79-81`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper/review dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 11`). Push to `main` and `pnpm run update:desktop` are NOT authorized: the owner's conditional grant ("in the end you double check and if you're confident you can update local BMN and push to GH") was superseded the same day by "I think I need to verify and approve before you update local and push to GH. Because I like simplicity, so I want to make sure we don't overcomplicate and it's not ugly". The owner reviews the look himself first; both quotes are in `.dev-auto/log.md`. Local commits stay authorized. Never push the old private `feat/epic-1/2` branches. Epic 11 out of scope: colour picker, palette changes, terminal tint, new sidebar, layout changes, animations, generated artwork, harness-brand colour mapping (`epics.md:443`).
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `~/.claude/skills/dev-auto/references/models.md`. Owner 2026-09-20: "you can dispatch GLM flash and GLM as much as you want, we have a lot of limits" and "in the end let Fable reviews instead of astra (whole epic)" — the Epic 11 strong review goes to `fable`/medium, not Astra. Standing owner preference: Fable for UI/design questions.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5` (1M context), session `7b3fae16-dba0-4a6e-874e-c32d5287dc15`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9, 13, 14 `done`; `epic-11` and `11-1-choose-and-recognize-a-workspace-marker` `backlog` at start. Delivery order in that file is 13 -> 14 -> 12 -> 11 -> 10; the owner selected 11 ahead of 12. Epic 11 depends on "current app only" (`epics.md:449`), so nothing from Epic 12 is required.
- Baseline revision: `1ead48f` (clean tree). `origin/main` is at `3e40d1b`; `1ead48f` is an unrelated local commit from an earlier session (in-app close/quit question and the update-hold launcher) that this run must preserve and must not push.
- Implemented (uncommitted working tree): protocol marker enum/guards and the `marker` field on `WorkspaceRecord` and both parameter shapes (`shared/protocol/src/workspace.ts:8-21,64-73,137-152`); schema migration 10 (`store-schema.ts:353-370`); store mapping, create, update and legacy degradation (`database-workspace-store.ts`); marker names and label (`theme.ts:5-25`); the marker component and helpers (`renderer/src/workspace-marker.tsx`, new); an exclusive radio group in the action menu (`popup-menu.tsx`); the menu choice, sidebar mark and per-pane identity (`main.tsx:1177-1195,1394,1456`); the pane heading mark (`session-terminal.tsx`); swatches and menu-group CSS (`styles.css`). Tests: 31 new unit tests across protocol, store, schema and the renderer helpers, an Electron self-test marker probe with its main-process assertions and a restart re-read, and an Epic 11 visual block (8 palette/identity pairs x 2 sizes, menu, long name, 780px rail, None).
- Associated loop (optional; host and native loop/task ID): none
- Active native helpers (ID, route, scope, ownership, state): none
- Collected terminal helper results: none

## Decisions and findings

- Original or approved intent changes: the marker's form and swatches are Fable's design (receipt below), accepted after I recomputed all 60 contrast ratios myself: a 4x12px solid bar with a 2px radius — deliberately not the 7px status circle — in `#8fa3b8` slate, `#5cbfb0` teal, `#6fa8e8` blue, `#a98fe6` violet and `#e08ab8` rose, one set for all four palettes, minimum 4.92:1 against every palette ground/surface/hover/selected background (floor required: 3:1). `none` renders no element anywhere while every workspace is on None, so an untouched install is pixel-identical as AC1 requires; as soon as any workspace is marked, the unmarked sidebar rows hold a transparent slot so the names keep one left edge (Fable's refinement of my first call, taken). Fable then reviewed the built result: `approved: true`, `must_fix: []`, and called it "genuinely optional". Its two ugliness findings were both taken (the dashed None swatch removed; the jagged sidebar edge fixed). Its one optional suggestion, dropping the visible MARKER group label, was declined with a recorded reason.
- Material pending findings: none.
- Outside Epic 11, owner-requested mid-run: the failure notice bar's full-width red bottom border became a 3px left accent with a hairline seam, because the red sat flush against the gold selection outline ("red and gold touching"). Fable chose the fix; selection is untouched, so Epic 11 AC3 still holds. It ships as its own commit.
- Cross-epic obligations: story 11.1 takes schema migration 10 (13.1 took 8, 14.2 took 9). The marker is identity, never status: it must not reuse or shadow the `--verified` running dot, `--attention` orange, `--identity` gold selection or white focus, and must not alter terminal geometry, ANSI colours or rows/columns (NFR7, NFR9-NFR12).

## Evidence

- Checks run and observed results, on the working tree: `pnpm run typecheck`/`lint` EXIT 0; `pnpm run test:unit` **1,096 passed / 1 skipped** (1,065 before this epic); `pnpm run test:electron` **EXIT 0** (`.dev-auto/evidence/epic-11/electron-1.log`) with the marker probe green — both panes carried their own workspace's marker (`teal` local, `rose` foreign), the foreign pane stayed unmarked while only the local workspace had chosen, each choice bumped its workspace revision by exactly 1, the terminal grid and both pane-heading heights were identical before and after, the archived workspace kept its marker, and after a real renderer reload the stored markers were re-read and redrawn. `pnpm run test:visual` is running.
- Tests: 31 new unit tests (6 protocol, 7 store, 2 schema assertions inside existing cases, 5 renderer helper, plus fixture updates), 1 Electron probe with 4 main-process assertion blocks, 1 visual block. Untested so far: the marker under `prefers-reduced-motion` (it has no transition or animation at all, asserted in the visual block), and macOS (Linux only, as every earlier epic).
- Reviewed scope and route: not yet reviewed.
- Baseline and reviewed revisions / material finding dispositions / recheck or delta evidence: baseline `1ead48f`; nothing reviewed yet.
- Unreviewed or unverified areas: all of Epic 11.

## Measurement

- Timing: started 2026-09-20T18:2x+03:00.
- Dispatches:
  - 11.1 marker form and swatches via Claude CLI | routine | claude-fable-5-1/medium | receipt `scratchpad/epic-11/fable-marker-design.json` ($0.558) | escalated: the owner's standing instruction is that Fable decides UI/design
- Owner interventions: two mid-turn notes (GLM dispatch allowance; Fable for the whole-epic review), both folded into this handoff.
- Observed usage: not yet read.

## Resume

- Next safe action: find why `test:visual` fails at Epic 5's `needs-you` wait only with this change applied (baseline 3/3 pass, this tree 2/2 fail), then finish the visual evidence, get Fable's approval of the built design, commit, and show the owner screenshots for his approval before any push.
- Status: ACTIVE — story 11.1 implemented; typecheck, lint, unit and electron green; `test:visual` fails in a pre-existing Epic 5 phase and the cause is not yet attributed.
