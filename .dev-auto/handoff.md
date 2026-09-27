# Dev Auto handoff

- Project / selected epics: /home/oleksandr/code/BMN; Epic 30 (stories 30.1, 30.2, 30.3), `/dev-auto 30` 2026-09-27.
- Original request and intended outcomes: `_bmad-output/planning-artifacts/epics.md` "Epic 30: Answer Your Agents from Telegram" (from line 1573) — Telegram cards with tap-to-answer buttons for agent questions and permissions; seven experience lines; shape matrix (decision 7).
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit.
- Explicit user stop: none
- Restrictions and authorization boundaries: local task commits authorized (global rules); push to main and `pnpm run update:desktop` need owner authorization (AGENTS.md); never `pnpm run package` while packaged BMN is open. Spike runs of real agents must not touch the owner's BMN or Telegram: unset `BMN_*` AND legacy `AITERM_*` in spike terminals and check `/proc/PID/environ` before prompting (leak 2026-09-27, log); never edit `~/.claude/settings.json`, `~/.codex/hooks.json` or the owner's OpenCode config (use `--settings`, temp CODEX_HOME / OPENCODE_CONFIG_DIR). Epic constraints: no blocking hooks, no "always allow", nothing on the control socket can create or change an answer.
- Decision and history log: .dev-auto/log.md (append-only)
- Authorized provider routes: `~/code/dev-auto/skills/dev-auto/references/models.md` (dev-auto execution consent, global rules).
- Lead host / requested model / observed model: Claude Code, Opus (suggested lead), observed claude-opus-5-5.

## Progress

- Sprint board and reconciled state: epic-30 in-progress; 30-1, 30-2, 30-3 all `review` (implemented, awaiting epic review). Commits 251b1e2 (30.1), 8ee22dd (30.2 engine), next commit = 30.2 Electron phase + 30.3 (candidate for review).
- Implemented: 30.1 (spike, structured prompt, v17, CLI mappers, setting, docs); 30.2 (mirror, engine, evidence, `answer.take`, plugin polling); 30.3 telegram-cards.ts, telegram-card-keeper.ts, connector HTML/edit/toast/callback_query/apiOrigin, schema v18 card columns, companion wiring, structured-dialog drafts, docs telegram.md/features.md, Electron fake Bot API phase (main/fake-bot-api.ts).
- Active helpers: none.

## Decisions and findings

- Original or approved intent changes: none.
- Material pending findings: none.
- 30.2 AC1 FAIL recorded (1.49×) → mirror gated to Claude/Codex hook sessions (log 2026-09-27 ~18:05).
- Known residuals (log ~18:35-19:00): OpenCode record may keep resolvedBy `hook:opencode:session.*` when session.status/idle closes it before the replied evidence (outcome still confirmed); under heavy CPU load the plugin's 3 s hook deadline can lose a replied report → honest sent-unconfirmed. Final cards stay in the keeper's memory until restart (small).
- Cross-epic obligations: Epic 29 hook origin reused for card headers (flag seen in Electron header); old `bmn` CLI ↔ new server; Remote Control sessions stay skipped; text-reply path unchanged except structured-dialog drafts.

## Evidence

- Unit gate 30.3: typecheck+lint+vitest 110 files / 2056 PASS (`.dev-auto/evidence/e30-unit-30.3a.log`); structured-draft RED/GREEN `e30-structured-draft-{red,green}.log`; earlier 30.2 gate/RED-GREEN in log.
- Electron self-test incl. "remote answers" (30.2) and "telegram cards" (30.3, fake Bot API taps a three-question card; edits in order; keys 1,2,1,1; resolvedBy telegram): EXIT 0, `e30-electron-30.3-run1.log` sha 20a3b134a7a18d3b.
- Real agents through the internal answer function, isolated BMN (log ~18:35-19:00): Claude 4/4 as designed, Codex 2/2 confirmed, OpenCode 3/3 confirmed on a quiet machine (run 1 under load: 1 confirmed, 2 sent-unconfirmed).
- Reviewed scope and route: none yet. Baseline ec7c517.
- Review allowance at the current boundary: rechecks 0 / consultation 0 / final repair 0.
- Unverified: owner real-phone run on the packaged build (needs push + `pnpm run update:desktop` authorization and the owner's phone); Telegram's real rendering of the HTML cards.

## Measurement

- Timing: started 2026-09-27 ~17:30.
- Dispatches: none yet (planning reviews predate the run).
- Review yield: n/a.
- Owner interventions: none during build.
- Observed usage: pending.

## Resume

- Next safe action: commit the candidate; dispatch GLM pre-review (prompt `.dev-auto/evidence/e30-glm-prereview-prompt.md`, diff `e30-candidate.diff`); one consolidated repair; Astra medium epic review; then ask the owner to authorize push + update:desktop for the phone walk-through.
- Status: ACTIVE — Epic 30 implemented and self-tested; reviews next.
