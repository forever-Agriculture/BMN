# Dev Auto handoff

- Project / selected epics: /home/oleksandr/code/BMN; Epic 31 (stories 31.1, 31.2, 31.3, 31.4), `/dev-auto 31` 2026-09-27 ~22:40 EEST.
- Original request and intended outcomes: `_bmad-output/planning-artifacts/epics.md` "Epic 31: Every Agent Under the Same Rules" (line 1816) — one agent-history limit (Claude/GLM cleanupPeriodDays, Codex/OpenCode own delete, one Start cleanup), Cursor terminal agent from measurements, Telegram multi-select / Other… / Back. Design section (Fable) binding for UI and cards.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop: none
- Restrictions and authorization boundaries: owner asleep — "finish autonomously"; owner-bound decisions go to Fable as consultant, not the owner (log 2026-09-28 ~00:10). Local task commits authorized (global rules); push to main and `pnpm run update:desktop` need owner authorization (AGENTS.md; not implied by "finish autonomously"); never `pnpm run package` while packaged BMN is open. Epic constraints (epics.md Epic 31 "Constraints"): nothing written/deleted before Start cleanup; delete only via agent command/setting; never write agent databases (open read-only); never remove transcript files; no new daemon/unit/table; no auth file read; spikes on disposable stores only (temp CODEX_HOME / XDG_DATA_HOME). Carried from Epic 30: spike terminals unset `BMN_*` and `AITERM_*`, check `/proc/PID/environ`; never edit `~/.claude/settings.json`, `~/.codex/hooks.json`, owner OpenCode config during tests (31.1 writes cleanupPeriodDays only via the shipped Start cleanup, by the owner). Transcripts must not go to GLM (epic lead note): GLM reviews get code/diffs only.
- Decision and history log: .dev-auto/log.md (append-only)
- Authorized provider routes: `~/code/dev-auto/skills/dev-auto/references/models.md` (dev-auto execution consent, global rules).
- Lead host / requested model / observed model: Claude Code, Opus (suggested lead), observed claude-opus-5-5.

## Progress

- Board: epic-31 in-progress; 31-1, 31-2 review (793b157); 31-4 review (a6b0606); 31-3 review (commit after a6b0606, log ~02:10). Baseline cb6ea18.
- All four stories implemented and self-checked; acceptance reviews next.
- Active helpers: none.

## Decisions and findings

- Original or approved intent changes: none.
- Material pending findings: none.
- Cross-epic obligations: Epic 30 answer checks kept for 31.4; archive setting keeps meaning (31.1); Epic 18 precedent for 31.3; deadline 2026-10-08 for 31.2.
- Deviations to state at acceptance: 31.3 AC1 measured in tmux (BMN_* unset, then fake BMN_* for env/process chain), not inside a live BMN; Cursor Needs you for permissions/questions UNSUPPORTED (no event); parity diff = aggregate `hooks check` exit code only.

## Evidence

- 31.1+31.2: unit 114/2142, Electron run 4, history screenshots (log ~23:10–23:30).
- 31.4: unit 114/2178 (log ~01:35), Electron run 7 fullerAnswers.
- 31.3: unit 114/2211, Electron run 12 EXIT 0 (cursorAcceptance), parity before/after, real-copy migration (log ~02:10).
- Untested: Claude's own deletion after cleanupPeriodDays; OpenCode TUI idle on an old session without the id on its command line; 31.4 on the owner's real phone; Cursor on the packaged build (owner check; owner does not use Cursor).

## Measurement

- Timing: started 2026-09-27 22:40 EEST.
- Dispatches: none yet in Epic 31.
- Review yield: n/a.
- Owner interventions: cursor login; "finish autonomously" (log ~00:10).
- Observed usage: pending.

## Resume

- Next safe action: freeze candidate; GLM pre-review (sanitised git-archive export, code/diffs only) alongside final checks + Fable visual review of History screenshots; one repair; Astra medium epic review; repair/recheck; acceptance; push/update decision via Fable.
- Status: ACTIVE — all stories in review; acceptance reviews next.
