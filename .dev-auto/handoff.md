# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 12 (stories 12.1 and 12.2).
- Original request and intended outcomes: `/dev-auto 12` (2026-09-20). Epic 12 "Inspectable Progress Evidence": `bmn progress --evidence-id` links already-published ready artifacts to the latest progress observation (12.1), and a modal progress-details dialog shows that evidence with honest wording that never certifies the claim (12.2). Source: `epics.md:466-516`, contract `reference-context-8-12.md:85-87`.
- Mode: build
- Stopping condition: selected scope accepted
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 12`). Push, merge and `pnpm run update:desktop` need separate authorization each time (the Epic 11 push grant covered that push only; log). Never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Carried from the Epic 11 run (`.dev-auto/log.md`): GLM and GLM Flash may be dispatched freely; Fable does design and the whole-epic review.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `c190fca0-f764-4d0d-876d-937012c0b71c`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9, 11, 13, 14 `done`; `epic-12` and both stories `backlog` at start. Delivery order 13 -> 14 -> 12 -> 11 -> 10; 11 was taken early by the owner, so 12 is next as planned. 12.2 depends on 12.1; both depend on the current app otherwise.
- Baseline `70c2d4c` (clean tree, `origin/main` identical). Epic 11 shipped through `87c2d7b`; `pnpm run update:desktop` is still QUEUED for `87c2d7b` waiting for packaged BMN to exit (`~/.local/state/bmn/source-update/latest.log`). That packaging is the owner's, not this run's.
- Implemented 12.1, committed at `da5ea9a`: `ProgressEvidence` and `MAX_PROGRESS_EVIDENCE` (`shared/protocol/src/companion.ts`); schema migration 11's `progress_evidence` table (`store-schema.ts`); eligibility, snapshotting, replacement and read-back in the store (`database-companion-store.ts`); the purge entry (`database-archive-purge.ts`); `evidenceIds` on `progress.report` with a bounded identifier-array reader (`control-server.ts`); the pass-through (`companion-service.ts`); repeatable `--evidence-id` and its help (`apps/desktop/bin/bmn`); and `docs/agent-control.md`.
- Implemented 12.2, uncommitted: `evidenceWord`, the reporter's-voice words and the two stale prefixes (`session-presentation.ts`); one `progress-strip.tsx` for all four strip sites with the state word as a button; `artifact-presentation.tsx` (the extracted `formatBytes`, `originalStateLabel`, `artifactIcon`, `ImageViewport` and a shared `useArtifactPreview`, now also used by `files-panel.tsx`); `progress-evidence-dialog.tsx`; the dialog variant, opener, gone-detection and `Progress details` menu entry (`main.tsx`); the pane prop (`session-terminal.tsx`); CSS (`styles.css`).
- Associated loop: none
- Active native helpers: none
- Collected terminal helper results: none

## Decisions and findings

- Original or approved intent changes: none yet. Carried prepared decisions (2026-09-20, owner-delegated, recorded in `epics.md` and `reference-context-8-12.md`): artifact eligibility is `state='ready'` AND `session_id = addressed session` AND `direction='output'`; the `bmn publish --key K` retry contract keeps a referenced ID stable; schema migration 11; the 12.2 surface is a modal dialog, not an inline expansion, because a `ResizeObserver` on `.terminal-surface` makes in-flow growth a real PTY resize (`session-terminal.tsx:158`, `199-211`, `1040`). Source: `reviews/fable-epic12-evidence-surface.md`.
- Material pending findings: none.
- Cross-epic obligations: 12.1 takes schema migration 11 (13.1 took 8, 14.2 took 9, 11.1 took 10). Evidence is provenance, never certification: no verification engine, no scoring, no auto-discovery; opening the detail must emit zero PTY input and resolve no attention (NFR7, NFR9-NFR12). Epic 11's workspace marker and Epic 14's working/idle mark and `attentionProvenance()` wording must keep working; the self-test reads `.progress-strip` text (`session-terminal.tsx:361-366`, `592-598`).

## Evidence

- Checks run on the working tree: `typecheck`/`lint` EXIT 0; `test:unit` **1,119 passed / 1 skipped** (1,097 at the Epic 11 baseline). `test:electron` and `test:visual` not yet run for this epic.
- Tests: 23 new unit tests (9 store, 3 schema/purge assertions inside existing cases, 6 control-server shape rows plus one handler assertion, 2 CLI cases plus 3 usage rows, 1 presentation case, 5 dialog-helper cases). 23 regression fences, each run red-then-green (15 for 12.1, 8 for 12.2); the lists are in `.dev-auto/log.md`. Two 12.1 fences started green and exposed real test gaps, both closed.
- Reviewed scope and route: none yet. Fable is to review the built result and the whole epic, per the carried owner instruction.
- Baseline and reviewed revisions / dispositions: baseline `70c2d4c`; 12.1 at `da5ea9a`; nothing reviewed yet.
- Unreviewed or unverified: every runtime claim. No Electron or visual run yet, so the dialog's focus behaviour, the zero-PTY-write claim, the no-resize claim and the CLI-through-restart path are all UNVERIFIED. macOS unrun as in every earlier epic.

## Measurement

- Timing: started 2026-09-20T23:00+03:00.
- Dispatches: none yet.
- Owner interventions: none yet.
- Observed usage: not yet read.

## Resume

- Next safe action: add the Electron self-test probes for both stories (an isolated shell publishing then reporting with the ID and reading it back after restart; the dialog opened from the strip button and the More menu with zero PTY writes and unchanged `.terminal-surface` height), then run `test:electron` and `test:visual`.
- Status: ACTIVE — 12.1 committed at `da5ea9a` and 12.2 built; runtime verification and both reviews still to come.
