# Dev Auto handoff

- Project / selected epics: /home/oleksandr/code/BMN; Epic 31 (stories 31.1, 31.2, 31.3, 31.4), `/dev-auto 31` 2026-09-27 ~22:40 EEST.
- Original request and intended outcomes: `_bmad-output/planning-artifacts/epics.md` "Epic 31: Every Agent Under the Same Rules" (line 1816) — one agent-history limit (Claude/GLM cleanupPeriodDays, Codex/OpenCode own delete, one Start cleanup), Cursor terminal agent from measurements, Telegram multi-select / Other… / Back. Design section (Fable) binding for UI and cards.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop: none
- Restrictions and authorization boundaries: local task commits authorized (global rules); push to main and `pnpm run update:desktop` need owner authorization (AGENTS.md); never `pnpm run package` while packaged BMN is open. Epic constraints (epics.md Epic 31 "Constraints"): nothing written/deleted before Start cleanup; delete only via agent command/setting; never write agent databases (open read-only); never remove transcript files; no new daemon/unit/table; no auth file read; spikes on disposable stores only (temp CODEX_HOME / XDG_DATA_HOME). Carried from Epic 30: spike terminals unset `BMN_*` and `AITERM_*`, check `/proc/PID/environ`; never edit `~/.claude/settings.json`, `~/.codex/hooks.json`, owner OpenCode config during tests (31.1 writes cleanupPeriodDays only via the shipped Start cleanup, by the owner). Transcripts must not go to GLM (epic lead note): GLM reviews get code/diffs only.
- Decision and history log: .dev-auto/log.md (append-only)
- Authorized provider routes: `~/code/dev-auto/skills/dev-auto/references/models.md` (dev-auto execution consent, global rules).
- Lead host / requested model / observed model: Claude Code, Opus (suggested lead), observed claude-opus-5-5.

## Progress

- Sprint board and reconciled state: epic-31 backlog (set in-progress at first commit); 31-1..31-4 backlog (31.1+31.2 implemented, verified, not yet committed). Baseline cb6ea18. Cursor installed + owner logged in (log ~23:00).
- Implemented (uncommitted, 31.1+31.2 together; shared runner/UI): `bin/safe-config-write.mjs` (extracted from bin/bmn; packaged via electron-builder), protocol `agentHistory` settings + `history.status/confirm`, validator, CLI `claudeConfigDir`, server rule, `agent-history.ts` runner (confirm/limit policy, 200 cap, live/24 h/cmdline skips, schedule 30 s + 24 h), adapters codex/opencode (read-only sqlite, `codex delete --force`, `opencode session delete --pure`), Preferences History section + gear dot, docs/agent-history.md (spike), features.md, self-test phases 'agent history' (+ after restart), scripts/test/history-visual.mjs.
- Active helpers: none.

## Decisions and findings

- Original or approved intent changes: none.
- Material pending findings: none.
- Cross-epic obligations: Epic 30 answer checks (screen/epoch-verified keys, named refusals, no Codex permissions) for 31.4; archive setting keeps meaning (31.1); Epic 18 precedent for 31.3; deadline 2026-10-08 for 31.2.

## Evidence

- 31.1+31.2: unit gate 114 files / 2142 PASS, Electron self-test run 4 EXIT 0, history screenshots (log ~23:10-23:30; `.dev-auto/evidence/epic-31/`). Spike receipts log ~22:50-23:00 and docs/agent-history.md.
- 31.4 spike: Claude and Codex done (log ~23:30-23:55, screens `.dev-auto/evidence/epic-31/spike-31-4/`); OpenCode pending.
- Untested so far: Claude's own deletion after cleanupPeriodDays (agent behaviour); OpenCode TUI idle on an old session without the id on its command line (documented residual).

## Measurement

- Timing: started 2026-09-27 22:40 EEST.
- Dispatches: none.
- Review yield: n/a.
- Owner interventions: none.
- Observed usage: pending.

## Resume

- Next safe action: OpenCode 31.4 spike (disposable XDG, free model); docs/remote-answers.md cells; kill tmux -L e31; commit 31.1+31.2 (board 31-1/31-2 review); implement 31.4; then 31.3 Cursor measurement.
- Status: ACTIVE — 31.1+31.2 verified, 31.4 spike in progress.
