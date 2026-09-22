# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; **Epic 15 only** (`/dev-auto 15`, 2026-09-22 ~08:30). Epics 16 and 18, selected by the earlier `/dev-auto 15-18`, stayed out of this run's scope and are untouched.
- Original request and intended outcomes: Epic 15 "Attention from Any Harness" (`epics.md:767-814`) — Story 15.2 `bmn hooks check|install`, Story 15.1 OSC notice → Needs you. Design: `reference-context-15-18.md:84-123`. Both delivered.
- Mode: build
- Stopping condition: Epic 15 accepted — met at `8bd263e`.
- Explicit user stop (if any; only a later user instruction clears it): none — the 2026-09-22 04:10 stop was cleared by `/dev-auto 15`; quoted verbatim in `.dev-auto/log.md`.
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits. **Push, merge and `pnpm run update:desktop` were NOT authorized** and none were done; `73942b8..HEAD` sits unpushed on local `main`, accepted code through `8bd263e`. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Epic review is gpt-6-astra/medium; GLM read-tool runs are the owner's standing extra opinion ("GLM/GLM-Flash for EXTRA reviews!", 2026-09-21).
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5/xhigh` (`claude-opus-5[1m]`), sessions `3ab48671-decc-4010-af8f-b9548f6dd157` and `8cb84739-653a-4e46-bc7d-4329aca415c1` under `~/.claude/projects/-home-oleksandr-code-BMN/`.

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored) — `epic-15`, `15-2-check-and-install-the-hooks-with-one-command` and `15-1-a-terminal-notification-becomes-a-notice` all `done` under the existing schema.
- Baseline `73942b8` (clean). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`; sixteen repair waves followed, last code wave `60797e2`, documentation corrections `95c9e3b`, `924f467`, `8bd263e`. Per-wave reasoning in `.dev-auto/log.md`.
- Associated loop and native helpers: none. In flight: none.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by every reviewer (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route`; the hooks code living in `bin/bmn`, which `epics.md:790` allows; `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- Final design (lead's calls under the owner's standing delegation; full argument in `.dev-auto/log.md`): an entry is recognised only as one of three exact strings per agent, compared whole after bash-blank trimming, never parsed; one naming `bmn hook <agent>` without being one of the three reads `missing` with a note. Claude's runnable and gating rules are measured against a real tool call; Codex gets cheap rules. BMN refuses a file only where it cannot merge without removing something, and every Codex report closes by saying BMN does not check that the harness will load the file, pointing at `/hooks` (`epics.md:787`).
- **Wave 15 reversed wave 14** at the owner's prompting ("consult with Fable regarding the most complicated things"). Waves 9-14 each modelled Codex's schema from citations and were wrong in both directions every time; `fable`/high showed the contract was an evasion — the `read`/`unverified` line was drawn by familiarity, not evidence — and that `epics.md:785` names exactly three states. 183 lines out, 31 in. Astra then withdrew his endorsement of the old design.
- Findings: every material finding from all reviews has a disposition at `8bd263e` in `.dev-auto/log.md`. One is rejected rather than closed — **Finding 5**, a writer saving between BMN's final check and its rename still wins; unclosable without a lock, Astra accepted the reasoning, and `docs/agent-control.md` states the racing edit is lost.
- Carried limitations: no Codex runtime measurement (three probes died at the trust step, an owner-only action), `hooks: null` reading `unusable`, sampled differential padding, and Codex's cheap timeout/matcher rules, which can be wrong either way — too strict costs a duplicate entry, too loose calls an entry wired that Codex will not load.
- Cross-epic obligations retained: migrations 13 and 14 belong to 16.1 and 18.2; shared acceptance boundary `reference-context-15-18.md:135-137`.

## Evidence

- Checks at the accepted revision: `.dev-auto/evidence/epic-15/checks-8bd263e.log` — lint, typecheck, Electron and visual exit 0; clean tree and `8bd263e` at both ends. The unit step exited 1 on the known flake alone; `checks-8bd263e-unit-reruns.log` records the re-runs at the same revision.
- Tests: 288 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including a differential test against real bash; 15.1 has 10 parser and 17 service tests. The Electron receipt's `terminalNotice` carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — 15.1 AC5 measured around a real second notice. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Runtime probes (untracked, `.dev-auto/evidence/epic-15/probes/`): five Claude Code runs, each with a control that fired; three Codex attempts whose control never fired, so nothing beside them is evidence.
- Mutation fences: `fences-15-*.log` — the final set is 12 probes, 12 RED.
- Discarded evidence and corrected claims are listed in `.dev-auto/log.md`.
- Baseline and reviewed revisions: baseline `73942b8`; full read-only review at `a25ed3f` three times; fifteen focused rechecks of the repair deltas; accepted at `924f467` by both reviewers with no blocking conditions. `8bd263e` fixes their five named follow-ups and changes documentation, comments and tests only — no behaviour change, re-gated and re-fenced.
- Unverified: Codex's runtime behaviour entirely; Epics 16 and 18 (out of scope).
- Flakes, all timeouts under load and none an assertion failure: `companion-service.test.ts > 'trims back to the newest refusals…'`, reproduced at baseline `73942b8`; `saved-output-store.test.ts:172` — 101 sequential awaited saves against a fixed 5s budget with 88 workers, in Epic 5's subsystem and untouched by `73942b8..HEAD`, so not edited under Epic 15, and its fix is a one-line explicit timeout needing the owner's go-ahead as its own change; and one visual fixture answered 69ms after opening, recorded as not attributed rather than not caused.

## Measurement

- Timing: 2026-09-21T21:25+03:00 to the 2026-09-22 04:10 stop; resumed ~08:30, accepted ~13:10+03:00. Receipts are under each session's scratchpad `reviews/`; paths and hashes in `.dev-auto/log.md`.
- Dispatches:
  - full epic review of `a25ed3f` | epic-review | gpt-6-astra/medium | reviews/epic-15-astra.stdout | first
  - fifteen focused rechecks | epic-review | gpt-6-astra/medium | reviews/recheck15-astra.stdout | first
  - owner's standing extra opinion | complex | GLM-5.3/max | reviews/extra15-glm53.json | first
  - first-pass extra opinion | routine | GLM-5.3-Flash/max | reviews/epic-15-glmflash.json | first
  - design consultation on the Codex model | consult | claude-fable-5-1/high | reviews/fable-design.json | first
- Owner interventions: the 04:10 stop, the 08:30 resume, and ~11:45 "if you struggle so much consult with Fable regarding the most complicated things".
- Observed usage: lead `claude-opus-5/xhigh`, 507 and 706 responses across the two sessions. Helpers: 17 `gpt-6-astra/medium` Codex rollouts totalling 9,891,064 tokens; Claude-CLI runs on the GLM profile costing $29.36 (GLM-5.3 and GLM-5.3-Flash) and one `claude-fable-5-1` consultation at $1.98.

## Resume

- Next safe action: none required for Epic 15. Push, `pnpm run update:desktop` and the `saved-output-store.test.ts:172` timeout fix each need the owner's word before anyone does them.
- Status: COMPLETE — Epic 15 accepted at `8bd263e`; both reviewers cleared `924f467` with no blocking conditions and `8bd263e` only corrects wording. Nothing pushed, nothing packaged.
