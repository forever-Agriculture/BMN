# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 14 (stories 14.1, 14.2).
- Original request and intended outcomes: `/dev-auto 14` (2026-09-20, Claude Code), resumed the same day. Epic 14 "Live State You Can See": a display-only working/idle state with a title refinement in sidebar, pane heading and palette (14.1); request provenance and a bounded in-memory hook event log with a read-only view (14.2). Source: `_bmad-output/planning-artifacts/epics.md:635-681`, `reference-context-13-14.md:90-98`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit
- Explicit user stop (if any; only a later user instruction clears it): none — the 2026-09-20 ~13:30+03:00 stop was cleared by the owner's `/dev-auto resume` (2026-09-20, same day).
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, review dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 14`). Push to `main` plus `pnpm run update:desktop` are authorized **once Epic 14 is finished and tested** (owner, 2026-09-20: "when you're done and everyting is tested you push to GH and update locally and give me a summary"), not before. Out of scope per the epic: screen scraping, rule downloads, sounds, sidebar reordering, a status column on the control socket, notifications from derived state, `bmn wait`/`subscribe`, OSC 9/777 notices. Never push the old private `feat/epic-1/2` branches.
- Decision and history log: `.dev-auto/log.md`
- Authorized provider routes: native Claude Code helpers; Codex CLI, Claude CLI and the configured GLM profile per `~/.claude/skills/dev-auto/references/models.md`. Owner twice named Fable for design and for being stuck.
- Lead host / requested model / observed model: Claude Code; none requested; observed `claude-opus-5[1m]` (session `6e51a794-afa3-4791-9959-a67faca37a29`).

## Progress

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9 and 13 `done`, epic-14 and both stories still `backlog`, to be moved at acceptance. `origin/main` is at `99e3832`; `56b7cb1`, `78c2423`, `97c9183` and `e1ed8ca` are local only.
- Implemented and committed: `56b7cb1` (Epic 13 refusal-log fix), `78c2423` (story 14.1), `97c9183` (story 14.2), `e1ed8ca` (the consolidated repair of all eight review findings).
- Uncommitted: this handoff and `.dev-auto/log.md` only.
- Story 14.2's contents, by layer, are listed in `.dev-auto/log.md` under "Story 14.2 contents".
- Associated loop (optional; host and native loop/task ID): none
- `e1ed8ca` closes all eight Astra findings, one per finding with a test each; the file:line closure list is in `.dev-auto/log.md` under "Astra review of Epic 14". It also gives the self-test a second live session for real per-session log isolation and the visual script visible-word, palette-mark and attention-precedence checks.
- Active native helpers (ID, route, scope, ownership, state): none native. Terminal helper in flight: the focused recheck of `e1ed8ca`, Codex CLI `gpt-6-astra`/low, read-only, prompt `scratchpad/review/recheck-prompt.md`, receipt `scratchpad/review/astra-recheck.json`.
- Collected terminal helper results: the Epic 14 full review (Astra, gpt-6-astra/medium, `scratchpad/review/astra-review.json`) — eight findings, verdict "I would not accept `97c9183` yet"; all eight closed in `e1ed8ca` and listed in `.dev-auto/log.md`. Earlier: GLM-5.3-Flash on Epic 13; Fable on the 14.1 mark.

## Decisions and findings

- Original or approved intent changes: the resting live mark is a 2px ring, not 1px, and no pulse (Fable, `evidence/epic-14/fable-mark.json`); AC3 allows either, and the epic asks for the choice to be recorded.
- Material pending findings: all eight Astra findings repaired in `e1ed8ca`; acceptance waits on the focused recheck. Residual, recorded not fixed: a repeated identical `attention.open` still records `opened`, because the CLI cannot see the store's prior revision. The 14.1 activation decision (every live pane activates on mount, `session-terminal.tsx:822-838`) is taken, implemented in `78c2423`, and reasoned in `.dev-auto/log.md`.
- Non-blocking Epic 13 items recorded not fixed: three, listed in `.dev-auto/log.md` under the second opinion.
- Cross-epic obligations: 14.2 takes schema migration 9 (13.1 took 8). Derived state stays display-only: it never opens, resolves or withdraws a request, never writes to a PTY, never notifies (NFR13-NFR17). Epic 13's agent brief and the cockpit rules must keep matching what 14.2 records.

## Evidence

- Checks run and observed results, on the repaired tree `e1ed8ca`: `pnpm run typecheck`/`lint` EXIT 0; `test:unit` **1,051 passed / 1 skipped**; `test:electron` **EXIT 0** (`evidence/epic-14/electron-13.log`) with the `sessionActivity` and `requestProvenance` receipts, the latter now showing `PostToolUse` effects `["answered"]` only and `otherSessionEvents [{"event":"Isolation-Probe","effects":[]}]`; `test:visual` **EXIT 0** (`evidence/epic-14/visual-9.log`), 16 measurements with visible-word flags, sidebar word contrast (minimum 5.57 against 4.5 required), palette marks and attention precedence in `evidence/epic-5/runtime-evidence.json`. Earlier green runs at `78c2423` and `97c9183` are in `.dev-auto/log.md`.
- Recorded flake: `visual-1.log` timed out on Epic 5's own `.status-dot.needs-you` wait and passed on every later run of the same build (details in the log).
- Regression fences: findings 1, 2, 3, 4, 5 and 8 were each fence-probed — the fix reverted in place, the matching test observed failing, the fix restored (results in `.dev-auto/log.md`). Findings 6 and 7 are covered by the visual script and by table tests but were not fence-probed.
- Tests: 7 for 14.1, 25 for 14.2, 22 more for the repair, plus the two Electron phases and the visual phase's 16 measurements; the breakdown is in `.dev-auto/log.md`. Untested: the Needs you popover's rendered provenance line (its wording function is tested); the visual script does not screenshot the popover or the Hook events dialog.
- Reviewed scope and route: Epic 14 reviewed whole by Astra (Codex CLI, gpt-6-astra/medium) over `99e3832..97c9183`; the focused recheck of `e1ed8ca` is in flight at gpt-6-astra/low.
- Reviewed revision / material finding closures / recheck or delta evidence: reviewed `97c9183`; all eight findings closed in `e1ed8ca` with file:line and a test each; recheck evidence pending.
- Unreviewed or unverified areas: the repair itself until the recheck returns. Astra left native PTY behaviour, transport/backpressure, token cryptography, the Telegram lease machinery, OS notification behaviour and activation-failure recovery unexamined. AC5 screenshots have now been eyeballed at both sizes in four palettes.

## Measurement

- Timing: started 2026-09-20T12:35+03:00; paused ~13:35+03:00.
- Dispatches:
  - Epic 14 full review via Codex CLI | whole-epic | gpt-6-astra/medium | receipt `scratchpad/review/astra-review.json` | first
  - Epic 14 focused recheck via Codex CLI | focused follow-up | gpt-6-astra/low | receipt `scratchpad/review/astra-recheck.json` | first
  - 14.1 mark design via Claude CLI | routine | claude-fable-5-1/medium | receipt `.dev-auto/evidence/epic-14/fable-mark.json` | first
  - (previous session) Epic 13 second opinion via Claude CLI + GLM profile | routine | GLM-5.3-Flash/max | receipt `.dev-auto/evidence/epic-13/glm2-review.json` | first
- Owner interventions: six mid-turn notes, all answered without rework.
- Observed usage: Fable $0.175; GLM-5.3-Flash $0.421. Lead and Astra usage to be read with `scripts/check.py usage` at acceptance.

## Resume

- Next safe action: collect the focused recheck (`scratchpad/review/astra-recheck.json`); if it closes the findings, move the board to done, run `scripts/check.py usage` on the lead and helper receipts and `scripts/check.py check`, then `git push origin main`, `pnpm run update:desktop`, and give the owner the summary they asked for.
- Status: ACTIVE — repair committed (`e1ed8ca`) and green on typecheck, lint, 1,051 unit tests, `test:electron` and `test:visual`; the focused recheck is in flight.
