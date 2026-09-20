# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 12 (stories 12.1 and 12.2).
- Original request and intended outcomes: `/dev-auto 12` (2026-09-20). Epic 12 "Inspectable Progress Evidence": `bmn progress --evidence-id` links already-published ready artifacts to the latest observation (12.1), and a modal detail shows that evidence in wording that never certifies the claim (12.2). Source: `epics.md:466-516`, contract `reference-context-8-12.md:85-87`.
- Mode: build
- Stopping condition: selected scope accepted — met.
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 12`). Owner 2026-09-20 (verbatim in `.dev-auto/log.md`) authorized push to `origin/main` and `pnpm run update:desktop` for this run's Epic 12 work, once everything is complete and the reviews are clean. Never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Carried from the Epic 11 run: GLM and GLM Flash may be dispatched freely; Fable does design and the whole-epic review.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `c190fca0-f764-4d0d-876d-937012c0b71c`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9, 11, 12, 13, 14 `done`, both Epic 12 stories `done` at `3757221`. Order 13 -> 14 -> 12 -> 11 -> 10; only Epic 10 remains.
- Baseline `70c2d4c` (clean tree, `origin/main` identical). Accepted head `3757221`, four commits: `da5ea9a` (12.1), `5b217c6` (12.2), `69342e6` (the four review repairs), `3757221` (the three tests closing review gaps).
- 12.1 ships the protocol type, migration 11's `progress_evidence` table, store eligibility/snapshot/replacement, the purge entry, `evidenceIds` on `progress.report`, repeatable `--evidence-id` and the docs. 12.2 ships the reporter's-voice words, one `progress-strip.tsx` for all four sites with the state word as a button, the extracted `artifact-presentation.tsx`, the evidence dialog and its two Electron probes. File lists in `.dev-auto/log.md`.
- Pushed `70c2d4c..e83ceba` to `origin/main` under the owner's grant, then ran `pnpm run update:desktop`. Epic 11's queued worker is still waiting for packaged BMN to exit and will package `e83ceba`, not the `87c2d7b` it logged: `runWorker` re-reads `gitState()` after the wait. Log `~/.local/state/bmn/source-update/latest.log`.
- Associated loop: none. Active native helpers: none. Collected terminal helper results: both reviews collected and dispositioned.

## Decisions and findings

- Original or approved intent changes: none. Carried prepared decisions (2026-09-20, owner-delegated): eligibility is `ready` AND same session AND `direction='output'`; `bmn publish --key K` keeps a referenced ID stable; migration 11; the detail is a modal dialog, not an inline expansion, because a `ResizeObserver` on `.terminal-surface` makes in-flow growth a real PTY resize. My three deliberate departures from Fable's design are in `.dev-auto/log.md`.
- Material pending findings: none. Fable's four findings CLOSED with evidence; GLM's four test gaps dispositioned — two CLOSED with fenced tests, one ACCEPTED as end-to-end-only coverage, one REJECTED as pre-existing and unrelated. Coordinates in `.dev-auto/log.md`.
- Cross-epic obligations: 12.1 took migration 11 (13.1 took 8, 14.2 took 9, 11.1 took 10), so Epic 10 takes 12. Evidence is provenance, never certification: no verification engine, no scoring, no auto-discovery; the detail emits zero PTY input and resolves no attention (NFR7, NFR9-NFR12). Epic 5's four state colours, Epic 11's marker and Epic 14's activity word and `attentionProvenance()` all still work; the self-test reads `.progress-strip` text.

## Evidence

- Checks on the accepted head `3757221`: `typecheck`/`lint` EXIT 0; `test:unit` **1,124 passed / 1 skipped** (83 files); `test:electron` **EXIT 0** (`electron-6.log`); `test:visual` **EXIT 0** (`visual-2.log`). The two suites were run at `69342e6`; no production file has changed since, confirmed by `git diff --name-only 69342e6 | grep -v '\.test\.ts$'` returning nothing, so they carry to this head.
- The receipt's two Epic 12 blocks (`.dev-auto/evidence/epic-12/electron-receipt-epic12.json`): `progressEvidence` — same artifact ID on the `--key` retry, one accepted report, four refusals in order each leaving it standing, links intact after an application restart. `progressEvidenceSurface` — `Reported verified` + `Evidence attached (1)`, the detail opened from the word and from the pane More menu, the file previewed, focus restored on both routes, **0** PTY input events, surface 510px and grid 43x30 unchanged, measured inks matching their tokens at 8.4 and 7.65 contrast against a 4.5 floor. Quoted in `.dev-auto/log.md`.
- Tests: 28 new unit tests plus assertions inside existing cases, and 2 Electron probe blocks. 27 regression fences, each run red-then-green — lists in `.dev-auto/log.md`. Two 12.1 fences started green and exposed real test gaps, both closed.
- Reviewed scope and route: two against `5b217c6` — `claude-fable-5-1`/medium with read tools for the whole epic against original intent, and `GLM-5.3-Flash`/max with read tools plus three check commands for the 12.1 persistence/CLI boundary and the tests. Both returned intent met with no blocking finding. Receipts under `.dev-auto/evidence/epic-12/reviews/`.
- Baseline and reviewed revisions / dispositions: baseline `70c2d4c`; reviewed revision `5b217c6`; accepted head `3757221`. Fable: four findings, all CLOSED — the stale doc sentence fixed; the menu-route focus loss fixed in `popup-menu.tsx` and fenced red-then-green through the real app (`electron-fence-menu-focus.log` EXIT 1 with `focusReturnedToMenuButton: false`, `electron-6.log` EXIT 0 with it true); the replacement comparison and the frozen age both fixed with unit cover; the earlier-incarnation note accepted as the decided contract and documented. GLM: gaps 1 and 3 CLOSED with fenced tests at `3757221`, gap 2 ACCEPTED as Electron-only coverage, gap 4 REJECTED as a pre-existing unrelated doc-drift guard. The repairs and tests sit outside the reviewed revision and carry that delta evidence.
- Unreviewed or unverified: macOS unrun, as in every earlier epic. Backup carries the new table by construction — `VACUUM INTO` copies the whole database and the restore health check compares the table list against `STORY_SCHEMA_TABLES`, which includes `progress_evidence` — but no test reads evidence back from a restore. The replacement banner, `Show newest` and `progressDetailGone` have no runtime exercise: the logic is unit-covered and read-only, but nothing has driven a newer report arriving while the detail is open, so those paths are UNVERIFIED. The owner-token-across-sessions refusal is covered end-to-end by the Electron run only. GLM did not read the 12.2 renderer surfaces, `artifact-files.ts` internals or `control-auth.ts` beyond the revocation gate; Fable listed its own boundaries in the log. Neither reviewer re-ran the Electron or visual suites. `bin/bmn` USAGE and `docs/agent-control.md:34` have no automated drift guard (pre-existing).

## Measurement

- Timing: 2026-09-20T23:00+03:00 to 2026-09-21T00:15+03:00, about 4.5 hours.
- Dispatches: two, both against `5b217c6`. `whole-epic review | epic-review | claude-fable-5-1/medium | reviews/fable-epic-review.json | escalated: the owner named Fable in place of Astra, and Fable wrote the 12.2 design being checked`. `persistence/CLI review and check run | routine | GLM-5.3-Flash/max | reviews/glm-flash-12-1.json | first`.
- Owner interventions: one, mid-run, in two messages: the review-and-push instruction and its clarification that it applies once everything is complete. Verbatim in `.dev-auto/log.md`. No rework.
- Observed usage: read with `scripts/check.py usage`. Lead `claude-opus-5/xhigh`, 231 responses, 174,550 output and 58,002,835 cache-read tokens. Fable `claude-fable-5-1` $3.75896775, 85 turns. GLM `GLM-5.3-Flash` $2.471235, 70 turns. Helper spend $6.23.

## Resume

- Next safe action: none for Epic 12; it is pushed and the local update is queued. Reopening BMN after it exits runs the new build. Epic 10 is the only unfinished planned epic and takes migration 12.
- Status: COMPLETE — Epic 12 accepted at `3757221`; both reviews returned no blocking finding and every finding is dispositioned.
