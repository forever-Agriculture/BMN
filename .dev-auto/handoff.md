# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; **Epic 15 only** (`/dev-auto 15`, 2026-09-22 ~08:30). Epics 16 and 18 were selected by the earlier `/dev-auto 15-18` and are **out of this run's scope** until the owner selects them again; their state is untouched.
- Original request and intended outcomes: Epic 15 "Attention from Any Harness" (`epics.md:767-814`) — Story 15.2 `bmn hooks check|install` (`epics.md:775-793`), Story 15.1 OSC notice → Needs you (`epics.md:795-814`). Design: `reference-context-15-18.md:84-123`.
- Mode: build
- Stopping condition: Epic 15 accepted; no automatic time limit.
- Explicit user stop (if any; only a later user instruction clears it): none — the 2026-09-22 04:10 stop ("wait no, stop everythin, but update sprint-status.yaml", verbatim in `.dev-auto/log.md`) is **cleared** by `/dev-auto 15`.
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, helper dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 15`). **Push, merge and `pnpm run update:desktop` are NOT authorized** — the 2026-09-21 overnight instruction that allowed them was superseded by the 04:10 stop and `/dev-auto 15` does not restore it. `main` only; never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: Codex CLI, Claude CLI and the configured GLM profile per `references/models.md`. Route: the epic's strong review is gpt-6-astra/medium; GLM-5.3/max read-tool runs are the owner's standing extra opinion ("GLM/GLM-Flash for EXTRA reviews!", 2026-09-21).
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]`, session `3ab48671-decc-4010-af8f-b9548f6dd157` (prior session `8cb84739-653a-4e46-bc7d-4329aca415c1`).

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored). Order: 15.2, 15.1. `epic-16`/`epic-18` stay backlog and out of scope; `epic-17` done.
- Baseline `73942b8` (clean). 15.2 shipped in `ac400aa`, 15.1 in `a25ed3f`, then six repair waves ending at `88eee46`. File lists in `.dev-auto/log.md`.
- Associated loop and native helpers: none. In flight: none.
- Wave 7 (the narrowing) is the current work: applying it, rewriting the recognition table and differential test in `apps/desktop/src/utility/control-cli.test.ts` and the grammar section of `docs/agent-control.md:208-240`, re-fencing, then one Astra recheck plus one GLM extra.

## Decisions and findings

- Original or approved intent changes: four, each argued in `.dev-auto/log.md` and agreed by all three reviewers (15.2's exit code for an unknown agent; 15.1 routing through `CompanionService.route`; the hooks code living inside `bin/bmn`, which `epics.md:790` allows; `hooks` following `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
- **Narrowing decided 2026-09-22 on resume (lead's call under the owner's standing delegation of design and methodology decisions).** Seven review rounds each found commands `hooks check` called `wired` that cannot report — the direction that leaves the owner with no hook and no warning. The ~330-line shell grammar (`bin/bmn:663-998`) is deleted; an entry is recognised only as one of three exact strings per agent, compared whole after trimming and never parsed: the documented entry, its `$AITERM_CONTROL_SOCKET` wording, and the bare `bmn hook <agent>`. Verified the same day: the owner's real `~/.claude/settings.json` and `~/.codex/hooks.json` entries match the `AITERM_` string byte-for-byte, so `epics.md:785`'s named case still reports `wired (older wording)`. Addition over the drafted patch: an entry that mentions `bmn hook <agent>` but is not recognised reads `missing` **with a note naming it**, so neither direction is silent. Cost: a duplicate entry beside a hand-written variant; `install` never removes or rewrites what is there (AC2). Reversible from git history.
- Material pending findings: the two refusals of `88eee46` (Astra recheck 6, GLM-5.3 extra 6 — both naming the first-word allowlist and the construct counting) are the reason for the narrowing and are dispositioned by it; **they stay open until a recheck of the narrowed revision confirms it.** Earlier rounds' findings are each closed with a test and a mutation fence, except **Finding 5 (a writer saving between BMN's final check and its rename still wins), rejected as unclosable** — Astra accepted that reasoning and `docs/agent-control.md` says the racing edit is lost. Dispositions in `.dev-auto/log.md`.
- Cross-epic obligations (not this run's work, kept for the record): migrations 13 and 14 belong to 16.1 and 18.2. Shared acceptance boundary (`reference-context-15-18.md:135-137`): no new network access or listener, no owner-token broadening, closed params and `RULES` sizes on every new control method, no derived signal opening a `question`/`permission`, no PTY write, no remount or refit, nothing starts a process without an owner action.

## Evidence

- Checks: `.dev-auto/evidence/epic-15/checks-88eee46.log` — lint, typecheck, unit (1,368 passed / 1 skipped over 88 files), Electron and visual all exit 0 against committed `88eee46`, tree clean at both ends. Its `terminalNotice` receipt carries `aroundSecondNotice: {sameSize: true, sameElement: true, refits: 0, inputEvents: 0}` — 15.1 AC5's "never refits" measured around a real second notice.
- **Discarded evidence:** `DISCARDED-checks-8a0ae46-tree-edited-mid-run.log` and the two GLM runs of 02:17 read a tree that changed under them; treated as leads verified independently, never cited. `who-reads-the-tree.sh` now runs in the same shell command as every patch.
- Tests: 15.2 has 216 CLI tests through the real binary against temp fixtures and a temporary HOME (no owner data, AC5), including a differential test whose stub holds the binary's argv/stdin contract. 15.1 has 10 parser and 17 service tests. Untested: `writeAtomically`'s crash window and a real `pnpm run update:desktop` cycle.
- Mutation fences: `fences-15-*.log` — 94 RED probes; wave 6's set is 17 probes, 14 RED, captured whole.
- Reviewed scope and route: `73942b8..a25ed3f` reviewed three times read-only (gpt-6-astra/medium, plus GLM-5.3/max and GLM-5.3-Flash/max extras), then a focused gpt-6-astra/medium recheck of each repair delta. Receipts under `.dev-auto/evidence/epic-15/reviews/`; prior-session raw transcripts under `/tmp/claude-1000/-home-oleksandr-code-BMN/8cb84739-653a-4e46-bc7d-4329aca415c1/scratchpad/reviews/`.
- Baseline and reviewed revisions: baseline `73942b8`; reviewed at `a25ed3f`; repair waves `8392017`, `e8f2628`, `c5ef4d7`, `36a89d8`, `b342658`, `88eee46` each rechecked and each refused. Wave 7 is unreviewed.
- Unreviewed or unverified areas: the wave-7 narrowing; Epics 16 and 18 entirely (out of scope).
- Pre-existing flake, reproduced at baseline `73942b8`: `companion-service.test.ts > 'trims back to the newest refusals…'` times out roughly one run in four; details in `.dev-auto/log.md`.

## Measurement

- Timing: first run 2026-09-21T21:25+03:00 to the 2026-09-22 04:10 stop; resumed 2026-09-22 ~08:30+03:00.
- Dispatches so far: three read-only reviews of `a25ed3f` (gpt-6-astra/medium via Codex CLI; GLM-5.3/max $4.62 and GLM-5.3-Flash/max $3.72 via Claude CLI on the GLM profile, `Read,Grep,Glob` only), six gpt-6-astra/medium rechecks and four further GLM second opinions (latest $1.69). Routes and receipts in `.dev-auto/log.md`.
- Owner interventions: the 04:10 stop and the 08:30 resume.
- Observed usage: lead `claude-opus-5[1m]`; receipts unread (acceptance step, not reached).

## Resume

- Next safe action: apply the wave-7 narrowing to `apps/desktop/bin/bmn` (delete `:663-998`, add the three-string recogniser), with `who-reads-the-tree.sh` in the same shell command; then rewrite the recognition table and differential test in `apps/desktop/src/utility/control-cli.test.ts`, rewrite `docs/agent-control.md:208-240`, re-fence, re-run checks, commit, then one gpt-6-astra/medium recheck plus one GLM-5.3/max extra.
- Status: ACTIVE — resumed at `/dev-auto 15`; Epic 15 only; the narrowing is decided and being applied. Tree at `88eee46` plus this handoff and the log. Nothing pushed, nothing packaged.
