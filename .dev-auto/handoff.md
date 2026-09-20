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
- Implemented and committed: `56b7cb1` (Epic 13 refusal-log fix), `78c2423` (14.1), `97c9183` (14.2), `e1ed8ca` (repair of the eight review findings), `6c91099` (log), `e9a1d04` (repair of the recheck's findings).
- Uncommitted: this handoff and `.dev-auto/log.md` only.
- Story 14.2's contents, by layer, are listed in `.dev-auto/log.md` under "Story 14.2 contents".
- Associated loop (optional; host and native loop/task ID): none
- `e1ed8ca` closes all eight Astra findings and `e9a1d04` closes the first recheck's: immediate Working restored (the cap no longer holds a session entering Working), a repeated identical open reports `changed: false` so the hook records no effect, the `RULES.source` event shape with the origin back at 64 characters, colon-safe provenance wording, the compact 800 px rail, and one refusal per caller per minute. Closure lists with file:line are in `.dev-auto/log.md`.
- Active native helpers (ID, route, scope, ownership, state): none native. Terminal helper in flight: the second focused recheck, of `e9a1d04`, Codex CLI `gpt-6-astra`/low, read-only, prompt `scratchpad/review/recheck2-prompt.md`, receipt `scratchpad/review/astra-recheck2.json`.
- Collected terminal helper results: the full review (Astra/medium, `astra-review.json`) — eight findings, "I would not accept `97c9183` yet"; the first recheck (Astra/low, `astra-recheck.json`) — five closed, three partly, one regression, "I would not accept Epic 14 yet". Both closed out in `.dev-auto/log.md`. Earlier: GLM-5.3-Flash on Epic 13; Fable on the 14.1 mark.

## Decisions and findings

- Original or approved intent changes: the resting live mark is a 2px ring, not 1px, and no pulse (Fable, `evidence/epic-14/fable-mark.json`); AC3 allows either, and the epic asks for the choice to be recorded.
- Material pending findings: everything both reviews raised is repaired; acceptance waits on the second recheck. Recorded not fixed: the self-test's `openRequestsUnchanged` counts attention rows, not desktop or Telegram notifications, which it cannot count because it disables them; and "no partial batch" is not atomicity — a hook timeout after an accepted call can still skip the observation (predates Epic 14). The 14.1 activation decision (every live pane activates on mount, `session-terminal.tsx:822-838`) is taken and reasoned in `.dev-auto/log.md`.
- Non-blocking Epic 13 items recorded not fixed: three, listed in `.dev-auto/log.md` under the second opinion.
- Cross-epic obligations: 14.2 takes schema migration 9 (13.1 took 8). Derived state stays display-only: it never opens, resolves or withdraws a request, never writes to a PTY, never notifies (NFR13-NFR17). Epic 13's agent brief and the cockpit rules must keep matching what 14.2 records.

## Evidence

- Checks run and observed results, on `e9a1d04`: `pnpm run typecheck`/`lint` EXIT 0; `test:unit` **1,062 passed / 1 skipped**; `test:electron` **EXIT 0** (`evidence/epic-14/electron-14.log`) with both receipts, `PostToolUse` effects `["answered"]` and `otherSessionEvents [{"event":"Isolation-Probe","effects":[]}]`; `test:visual` **EXIT 0** (`evidence/epic-14/visual-10.log`), 16 measurements with visible-word flags, sidebar word contrast (minimum 5.57 against 4.5 required), palette marks, attention precedence and the 780x600 rail check in `evidence/epic-5/runtime-evidence.json`. Earlier green runs are in `.dev-auto/log.md`.
- Recorded flake: `visual-1.log` timed out on Epic 5's own `.status-dot.needs-you` wait and passed on every later run of the same build (details in the log).
- Regression fences: twelve, all FAILS as required — findings 1-5 and 8 of the review, and all six changes in `e9a1d04` (results in `.dev-auto/log.md`). Finding 6 is covered by the visual script's `shown` flags and the rail check rather than a fence.
- Tests: 7 for 14.1, 25 for 14.2, 33 more across the two repairs, plus the two Electron phases and the visual phase's 16 measurements and rail check. Untested: the Needs you popover's rendered provenance line (its wording function is tested); the visual script does not screenshot the popover or the Hook events dialog.
- Reviewed scope and route: Epic 14 reviewed whole by Astra (Codex CLI, gpt-6-astra/medium) over `99e3832..97c9183`, rechecked at gpt-6-astra/low over `97c9183..e1ed8ca`; the second recheck over `e1ed8ca..e9a1d04` is in flight.
- Reviewed revision / material finding closures / recheck or delta evidence: `97c9183` reviewed, `e1ed8ca` rechecked; eight findings closed in `e1ed8ca`, the recheck's six in `e9a1d04`, each with file:line and a test; second recheck evidence pending.
- Unreviewed or unverified areas: the repair itself until the recheck returns. Astra left native PTY behaviour, transport/backpressure, token cryptography, the Telegram lease machinery, OS notification behaviour and activation-failure recovery unexamined. AC5 screenshots have now been eyeballed at both sizes in four palettes.

## Measurement

- Timing: started 2026-09-20T12:35+03:00; paused ~13:35+03:00.
- Dispatches:
  - Epic 14 full review via Codex CLI | whole-epic | gpt-6-astra/medium | receipt `scratchpad/review/astra-review.json` | first
  - Epic 14 focused recheck via Codex CLI | focused follow-up | gpt-6-astra/low | receipt `scratchpad/review/astra-recheck.json` | first
  - Epic 14 second recheck via Codex CLI | focused follow-up | gpt-6-astra/low | receipt `scratchpad/review/astra-recheck2.json` | first
  - 14.1 mark design via Claude CLI | routine | claude-fable-5-1/medium | receipt `.dev-auto/evidence/epic-14/fable-mark.json` | first
  - (previous session) Epic 13 second opinion via Claude CLI + GLM profile | routine | GLM-5.3-Flash/max | receipt `.dev-auto/evidence/epic-13/glm2-review.json` | first
- Owner interventions: six mid-turn notes, all answered without rework.
- Observed usage: Fable $0.175; GLM-5.3-Flash $0.421; Astra full review gpt-6-astra/medium 1,670,115 in / 9,576 out. Lead and the two rechecks to be read with `scripts/check.py usage` at acceptance.

## Resume

- Next safe action: collect the second recheck (`scratchpad/review/astra-recheck2.json`); if it closes the findings, move the board to done, run `scripts/check.py usage` on the lead and helper receipts and `scripts/check.py check`, then `git push origin main`, `pnpm run update:desktop`, and give the owner the summary they asked for.
- Status: ACTIVE — second repair committed (`e9a1d04`) and green on typecheck, lint, 1,062 unit tests, `test:electron` and `test:visual`; the second recheck is in flight.
