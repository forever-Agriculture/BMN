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
- Baseline `73942b8` (clean). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f` (untouched since). Fourteen repair waves followed, the last at `cf1bd81`. File lists and per-wave reasoning in `.dev-auto/log.md`.
- Associated loop and native helpers: none. In flight: none.
- Current work: wave 14 is committed, gated and fenced; the thirteenth Astra recheck and a GLM-5.3/max extra are reading `cf1bd81`.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by all three reviewers (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route`; the hooks code living in `bin/bmn`, which `epics.md:790` allows; `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- **The narrowing (2026-09-22, lead's call under the owner's standing delegation).** The ~330-line shell grammar is deleted; an entry is recognised only as one of three exact strings per agent, compared whole after bash-blank trimming, never parsed. One naming `bmn hook <agent>` without being one of the three reads `missing` **with a note**. Cost: a duplicate beside a hand-written variant; `install` never removes or rewrites (AC2).
- **AC1 variance:** the narrowing changes what `epics.md:785` describes. Astra ruled recording it sufficient for technical acceptance; reconciling `epics.md` is an owner task, not done here.
- **Harness behaviour is measured, not reasoned.** The probe harness (temp settings file, real `claude` CLI, a hook appending to a marker file) answers a question in a minute and found two false `wired`s no review round had. Claude Code's rules are measured.
- **The Codex contract (wave 14, lead's call, endorsed by the epic's reviewer as option D).** Waves 9-13 were each a defect in code modelling Codex's schema from citations, both directions, and its runtime is not measurable here (three probes failed at the per-entry trust step, an owner action). So BMN stopped reimplementing Codex's parser: a Codex file reads `read`, `unusable` (BMN is sure Codex refuses it; `install` writes nothing) or `unverified` (holds something BMN has no rules for: entries listed, nothing called `wired`, non-zero exit, `install` still adds). Accepted cost, Astra's words: warnings and a failing status for configurations that may be valid. Codex `timeout` is judged on the literal token, since parsing hides `1.0`, `1e3` and `2^64`.
- Material pending findings: both reviewers refused `b98a8d2` on one class — BMN's partial reimplementation of Codex's schema, too lax and too strict at once. Wave 14 answers it by contract; **those findings stay open until recheck 13 confirms it**. Everything earlier is closed with a test and a fence, except **Finding 5 (a writer saving between BMN's final check and its rename still wins), rejected as unclosable** — Astra accepted the reasoning and the doc says the racing edit is lost.
- Carried items both reviewers accepted: the unmeasured Codex runtime, `hooks: null` reading `unusable`, the sampled differential padding, an unheard-of Codex event, and Claude `timeout: 0` (untried, treated as dead). Since wave 14, every Codex schema constraint BMN does not model is the contract's subject, not a gap in it.
- Cross-epic obligations (not this run's work): migrations 13 and 14 belong to 16.1 and 18.2. Shared acceptance boundary: `reference-context-15-18.md:135-137`.

## Evidence

- Checks: `checks-cf1bd81.log` — lint, typecheck, Electron and visual exit 0 against committed `cf1bd81`, clean tree and the same revision at both ends. Its `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — 15.1 AC5 measured around a real second notice. The unit step timed out once in `saved-output-store.test.ts`; `checks-cf1bd81-unit-rerun.log` has the whole suite green at the same revision, 1,457 passed / 1 skipped over 88 files.
- Tests: 305 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including a differential test against real bash. 15.1 has 10 parser and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Runtime probes (untracked, under `.dev-auto/evidence/epic-15/probes/`): four Claude Code runs with fixtures, and three Codex attempts whose control hook never fired — inconclusive, so nothing beside them is read as evidence.
- Mutation fences: `fences-15-*.log` — wave 14's set is 15 probes, 15 RED.
- **Discarded evidence and one corrected claim** (`.dev-auto/log.md`): the `8a0ae46` checks log and two GLM runs read a tree that changed under them and are never cited — `who-reads-the-tree.sh` now runs in the same shell command as every patch; and `recheck11-prompt.md:13` wrongly called the probe files "committed" when `.gitignore:43` ignores `/.dev-auto/evidence/`.
- Reviewed scope and route: `73942b8..a25ed3f` reviewed three times read-only, then a focused gpt-6-astra/medium recheck of each repair delta. Receipts under `.dev-auto/evidence/epic-15/reviews/`; raw transcripts in both sessions' scratchpads.
- Baseline and reviewed revisions: baseline `73942b8`; reviewed at `a25ed3f`; twelve rechecked repair waves, each refused. `cf1bd81` is under recheck 13.
- Unreviewed or unverified areas: wave 14; Codex's runtime behaviour entirely; Epics 16 and 18 (out of scope).
- Flakes, both timeouts under load and neither in code this epic touches: `companion-service.test.ts > 'trims back to the newest refusals…'`, reproduced at baseline `73942b8`, roughly one run in four; and `saved-output-store.test.ts > 'prunes the oldest records…'`, seen once at `cf1bd81` and green on re-run.

## Measurement

- Timing: 2026-09-21T21:25+03:00 to the 2026-09-22 04:10 stop; resumed 2026-09-22 ~08:30+03:00.
- Dispatches so far: three read-only reviews of `a25ed3f` (gpt-6-astra/medium; GLM-5.3/max $4.62 and GLM-5.3-Flash/max $3.72 via Claude CLI on the GLM profile, `Read,Grep,Glob` only), thirteen gpt-6-astra/medium rechecks, one gpt-6-astra/medium design question, further GLM second opinions (latest $1.54), and one `fable`/high design consultation at the owner's instruction. Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: the 04:10 stop, the 08:30 resume, and 2026-09-22 ~11:45 "if you struggle so much consult with Fable regarding the most complicated things".
- Observed usage: lead `claude-opus-5[1m]`; receipts unread (acceptance step, not reached).

## Resume

- Next safe action: read recheck 13 (`reviews/recheck13-astra.stdout`) and the GLM extra (`reviews/extra13-glm53.json`) in the session scratchpad, disposition every finding against `cf1bd81`; then the acceptance steps — board update under the existing schema, `scripts/check.py usage PATH` on every lead and helper receipt, `scripts/check.py check`, `bmn publish` the handoff.
- Status: ACTIVE — Epic 15 only; wave 14 committed at `cf1bd81`, gated and fenced, under recheck 13. Nothing pushed, nothing packaged.
