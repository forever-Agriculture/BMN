# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; **Epic 15 only** (`/dev-auto 15`, 2026-09-22 ~08:30). Epics 16 and 18 were selected by the earlier `/dev-auto 15-18` and are **out of this run's scope** until the owner selects them again; their state is untouched.
- Original request and intended outcomes: Epic 15 "Attention from Any Harness" (`epics.md:767-814`) — Story 15.2 `bmn hooks check|install`, Story 15.1 OSC notice → Needs you. Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: Epic 15 accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none — the 2026-09-22 04:10 stop ("wait no, stop everythin, but update sprint-status.yaml", verbatim in `.dev-auto/log.md`) is **cleared** by `/dev-auto 15`.
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15`). **Push, merge and `pnpm run update:desktop` are NOT authorized** — the 2026-09-21 overnight instruction allowing them died with the 04:10 stop and `/dev-auto 15` does not restore it. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Route: the epic's strong review is gpt-6-astra/medium; GLM-5.3/max read-tool runs are the owner's standing extra opinion ("GLM/GLM-Flash for EXTRA reviews!", 2026-09-21).
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `3ab48671-decc-4010-af8f-b9548f6dd157` (prior session `8cb84739-653a-4e46-bc7d-4329aca415c1`).

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). Order 15.2, 15.1; `epic-16`/`epic-18` backlog and out of scope; `epic-17` done.
- Baseline `73942b8` (clean). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f` (untouched since). Sixteen repair waves followed, the last at `60797e2`. File lists and per-wave reasoning in `.dev-auto/log.md`.
- Associated loop and native helpers: none. In flight: none.
- Current work: wave 16 is committed, gated and fenced; both reviewers accepted the wave-15 reversal, so what is open is only wave 16 itself.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by all three reviewers (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route`; the hooks code living in `bin/bmn`, which `epics.md:790` allows; `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- **The design as it now stands** (lead's calls under the owner's standing delegation; full argument in `.dev-auto/log.md`). An entry is recognised only as one of three exact strings per agent, compared whole after bash-blank trimming, never parsed; one naming `bmn hook <agent>` without being one of the three reads `missing` **with a note**. Claude's runnable and gating rules are measured against a real tool call. Codex gets cheap rules that can be wrong either way. BMN refuses a file only where it cannot merge without removing something, and every Codex report closes by saying BMN does not check the harness will load the file, pointing at `/hooks` — which is what `epics.md:787` asks for.
- **Wave 15 reversed wave 14** at the owner's prompting ("consult with Fable regarding the most complicated things"). Waves 9-14 each modelled Codex's schema from citations, wrong both ways every time; its runtime is not measurable here (three probes failed at the trust step, an owner action). `fable`/high showed the contract was an evasion — the line between `read` and `unverified` was familiarity, not evidence — and that `epics.md:785` names exactly three states. Deleted: 183 lines out, 31 in. **Both reviewers then accepted the reversal and Astra withdrew its endorsement of the old design.**
- Material pending findings: Astra refused `cf1bd81` on four defects and GLM accepted it carrying two of the same. Wave 15 fixes his P1 (`install` rewriting an integer it cannot reproduce) and **dissolves the other three by deleting the state that caused them**; all of it stays open until recheck 14 rules on the reversal itself. Everything earlier is closed with a test and a fence, except **Finding 5 (a writer saving between BMN's final check and its rename still wins), rejected as unclosable** — Astra accepted the reasoning and the doc says the racing edit is lost.
- Carried: no Codex runtime measurement at all (three attempts, all failed at the trust step), `hooks: null` reading `unusable`, the sampled differential padding, and Codex's timeout/matcher rules being cheap-safe rather than exact — each wrong only in the direction that costs a duplicate entry. Claude `timeout: 0` is no longer carried: measured dead, with a control that fired.
- Cross-epic obligations: migrations 13 and 14 belong to 16.1 and 18.2. Shared acceptance boundary: `reference-context-15-18.md:135-137`.

## Evidence

- Checks: `checks-43bac51.log` — lint, typecheck, Electron and visual exit 0 against committed `43bac51`, clean tree and the same revision at both ends. Its `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — 15.1 AC5 measured around a real second notice. `checks-43bac51-unit-reruns.log` has the unit suite green twice more at the same revision (1,430 passed / 1 skipped).
- Tests: 287 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including a differential test against real bash. 15.1 has 10 parser and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Runtime probes (untracked, under `.dev-auto/evidence/epic-15/probes/`): five Claude Code runs with fixtures, each with a control that fired; three Codex attempts whose control never fired, so nothing beside them is evidence.
- Mutation fences: `fences-15-*.log` — wave 16's set is 12 probes, 12 RED.
- **Discarded evidence and corrected claims** (`.dev-auto/log.md`): the `8a0ae46` checks log and two GLM runs read a tree that changed under them, never cited; `recheck11-prompt.md:13` wrongly called the probe files "committed"; and a first `timeout: 0` probe was invalid (its control never fired) and nothing was concluded from it.
- Reviewed scope and route: `73942b8..a25ed3f` reviewed three times read-only, then a focused gpt-6-astra/medium recheck of each repair delta. Receipts and raw transcripts in both sessions' scratchpads under `reviews/`.
- Baseline and reviewed revisions: baseline `73942b8`; reviewed at `a25ed3f`; fourteen rechecked waves. `43bac51`: GLM accepted, Astra refused on two installer defects, both fixed in the unreviewed `60797e2`.
- Unreviewed or unverified areas: wave 16; Codex's runtime behaviour entirely; Epics 16 and 18 (out of scope).
- Flakes, both timeouts under load and neither in code this epic touches: `companion-service.test.ts > 'trims back to the newest refusals…'`, reproduced at baseline `73942b8`, roughly one run in four; and `saved-output-store.test.ts:172`, which timed out in the unit step of both recent full gate runs and passed in all three isolated re-runs — 101 sequential awaited saves against a fixed 5s budget with 88 workers. In Epic 5's subsystem, untouched by `73942b8..HEAD`, so **not edited under Epic 15**; the fix is a one-line explicit timeout and needs the owner's go-ahead as its own change.

## Measurement

- Timing: 2026-09-21T21:25+03:00 to the 2026-09-22 04:10 stop; resumed 2026-09-22 ~08:30+03:00.
- Dispatches so far: three read-only reviews of `a25ed3f` (gpt-6-astra/medium; GLM-5.3/max $4.62 and GLM-5.3-Flash/max $3.72 via Claude CLI on the GLM profile, `Read,Grep,Glob` only), thirteen gpt-6-astra/medium rechecks, one gpt-6-astra/medium design question, further GLM second opinions (latest $1.43), and one `fable`/high design consultation at the owner's instruction ($1.98), which reversed the design. Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: the 04:10 stop, the 08:30 resume, and 2026-09-22 ~11:45 "if you struggle so much consult with Fable regarding the most complicated things".
- Observed usage: lead `claude-opus-5[1m]`; receipts unread (acceptance step, not reached).

## Resume

- Next safe action: dispatch the fifteenth gpt-6-astra/medium recheck of `43bac51..60797e2` plus a GLM-5.3/max extra; then the acceptance steps — board update under the existing schema, `scripts/check.py usage PATH` on every lead and helper receipt, `scripts/check.py check`, `bmn publish` the handoff.
- Status: ACTIVE — Epic 15 only; wave 16 committed at `60797e2` and fenced, gates running. Both reviewers accepted the wave-15 reversal; only wave 16 is unreviewed. Nothing pushed, nothing packaged.
