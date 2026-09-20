# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 12 (stories 12.1 and 12.2).
- Original request and intended outcomes: `/dev-auto 12` (2026-09-20). Epic 12 "Inspectable Progress Evidence": `bmn progress --evidence-id` links already-published ready artifacts to the latest observation (12.1), and a modal detail shows that evidence in wording that never certifies the claim (12.2). Source: `epics.md:466-516`, contract `reference-context-8-12.md:85-87`.
- Mode: build
- Stopping condition: selected scope accepted
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 12`). Owner 2026-09-20 (verbatim in `.dev-auto/log.md`) authorized push to `origin/main` and `pnpm run update:desktop` for this run's Epic 12 work, once everything is complete and the reviews are clean — and only then. Never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Carried from the Epic 11 run (`.dev-auto/log.md`): GLM and GLM Flash may be dispatched freely; Fable does design and the whole-epic review.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `c190fca0-f764-4d0d-876d-937012c0b71c`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9, 11, 13, 14 `done`; `epic-12` now `in-progress`, both stories `review` pending acceptance. Order 13 -> 14 -> 12 -> 11 -> 10; only Epic 10 remains after this.
- Baseline `70c2d4c` (clean tree, `origin/main` identical). Epic 11's `update:desktop` is still QUEUED for `87c2d7b`, waiting for packaged BMN to exit (`~/.local/state/bmn/source-update/latest.log`); this run's own update supersedes it once pushed.
- Implemented 12.1, committed at `da5ea9a`: the protocol type, schema migration 11's `progress_evidence` table, store eligibility/snapshot/replacement, the purge entry, `evidenceIds` on `progress.report`, repeatable `--evidence-id` and the docs. File list in `.dev-auto/log.md`.
- Repairs after review, uncommitted: the stale `docs/agent-control.md` sentence, `popup-menu.tsx` returning focus to its anchor on selection (both branches), `receivedAt` on `ProgressPresentation` with a replacement check that cannot miss, and `agedProgress()` so an open detail keeps telling the truth about age. Plus, from my own re-read, the strip's state-colour measurements in the Electron probe.
- Implemented 12.2, committed at `5b217c6`: `evidenceWord` and the reporter's-voice words (`session-presentation.ts`); one `progress-strip.tsx` for all four sites with the state word as a button; the extracted `artifact-presentation.tsx`, now shared with `files-panel.tsx`; `progress-evidence-dialog.tsx`; the dialog variant, opener, gone-detection and menu entry (`main.tsx`); CSS; the Electron probes. File list in `.dev-auto/log.md`.
- Associated loop: none
- Active native helpers: none
- Collected terminal helper results: none

## Decisions and findings

- Original or approved intent changes: none. Carried prepared decisions (2026-09-20, owner-delegated, in `epics.md` and `reference-context-8-12.md`): eligibility is `ready` AND same session AND `direction='output'`; `bmn publish --key K` keeps a referenced ID stable; migration 11; the detail is a modal dialog, not an inline expansion, because a `ResizeObserver` on `.terminal-surface` makes in-flow growth a real PTY resize. Source: `reviews/fable-epic12-evidence-surface.md`. My three deliberate departures from that design are in `.dev-auto/log.md`.
- Material pending findings: none. Fable's four findings are all closed with evidence (dispositions with coordinates in `.dev-auto/log.md`); the GLM-5.3-Flash review of the 12.1 boundary is still outstanding and blocks acceptance until its findings are disposed of.
- Cross-epic obligations: 12.1 took migration 11 (13.1 took 8, 14.2 took 9, 11.1 took 10), so Epic 10 takes 12. Evidence is provenance, never certification: no verification engine, no scoring, no auto-discovery; the detail emits zero PTY input and resolves no attention (NFR7, NFR9-NFR12). Epic 5's four state colours, Epic 11's marker and Epic 14's activity word and `attentionProvenance()` all still work; the self-test reads `.progress-strip` text.

## Evidence

- Checks run on the repaired tree (`5b217c6` + the review repairs): `typecheck`/`lint` EXIT 0; `test:unit` **1,121 passed / 1 skipped**; `test:electron` **EXIT 0** (`electron-6.log`); `test:visual` **EXIT 0** (`visual-2.log`, rerun after the shared `PopupMenu` change). The Electron receipt now also carries `focusReturnedToMenuButton: true` and the strip's measured inks (`verifiedInk === --verified`, `failedInk === --error`, `evidenceInk === --muted`, contrast 8.4 and 7.65 against a 4.5 floor). Extracted to `.dev-auto/evidence/epic-12/electron-receipt-epic12.json`.
- The receipt's two Epic 12 blocks: `progressEvidence` — same artifact ID on the `--key` retry, one accepted report, four refusals in order each leaving it standing, links intact after an application restart. `progressEvidenceSurface` — `Reported verified` + `Evidence attached (1)`, the detail opened from the word and from the pane More menu, the file previewed, focus restored on both routes, **0** PTY input events, surface 510px and grid 43x30 unchanged throughout. All four strip sites carry the evidence word. Quoted in `.dev-auto/log.md`.
- Tests: 25 new unit tests plus assertions inside existing cases, and 2 Electron probe blocks. 24 regression fences, each run red-then-green — 15 for 12.1, 8 for 12.2, and the menu-focus repair fenced through the real app. Lists in `.dev-auto/log.md`. Two 12.1 fences started green and exposed real test gaps, both closed.
- Reviewed scope and route: two against `5b217c6` — `claude-fable-5-1`/medium with read tools for the whole epic against original intent and its own 12.2 surface consultation, (returned: intent met, no blocking finding, four findings all closed) and `GLM-5.3-Flash`/max with read tools plus three allowed check commands for the 12.1 persistence/CLI boundary and the tests (still running). Receipts under `.dev-auto/evidence/epic-12/reviews/`.
- Baseline and reviewed revisions / dispositions: baseline `70c2d4c`; reviewed revision `5b217c6` (12.1 at `da5ea9a`, 12.2 at `5b217c6`). Fable: four findings, all CLOSED with evidence — the stale doc sentence fixed; the menu-route focus loss fixed in `popup-menu.tsx` and fenced red-then-green through the real app (`electron-fence-menu-focus.log` EXIT 1 with `focusReturnedToMenuButton: false`, `electron-6.log` EXIT 0 with it true); the replacement comparison and the frozen age both fixed with unit cover; the earlier-incarnation note accepted as the decided contract and documented. The repairs sit outside the reviewed revision and carry that delta evidence. GLM: outstanding.
- Unreviewed or unverified: macOS unrun, as in every earlier epic. Fable listed the boundaries it did not read (log). Backup carries the new table by construction — `VACUUM INTO` copies the whole database and the restore health check compares the table list against `STORY_SCHEMA_TABLES`, which the receipt confirms includes `progress_evidence` — but no test reads evidence back from a restore. The replacement banner and `Show newest` have no runtime exercise — the logic is read-only and unit-shaped, but nothing has driven a newer report arriving while the detail is open, so that path is UNVERIFIED. `progressDetailGone` likewise. Neither reviewer re-ran the Electron or visual suites.

## Measurement

- Timing: started 2026-09-20T23:00+03:00; still running.
- Dispatches: two, both against `5b217c6`. `whole-epic review | epic-review | claude-fable-5-1/medium | reviews/fable-epic-review.json | escalated: the owner named Fable in place of Astra, and Fable wrote the 12.2 design being checked`. `persistence/CLI review and check run | routine | GLM-5.3-Flash/max | reviews/glm-flash-12-1.json | first`.
- Owner interventions: one, mid-run, in two messages: the review-and-push instruction and its clarification that it applies once everything is complete. Verbatim in `.dev-auto/log.md`. No rework.
- Observed usage: Fable $3.759 (85 turns) so far; GLM Flash and the lead not yet read with `scripts/check.py usage`.

## Resume

- Next safe action: collect the GLM-5.3-Flash receipt and dispose of its findings, confirm `test:visual`, commit the repairs, then — only if acceptance is clean — flip the board to `done`, push to `origin/main` and run `pnpm run update:desktop` under the owner's grant.
- Status: ACTIVE — both stories built and green, Fable's four findings closed; the GLM review of the 12.1 boundary is outstanding.
