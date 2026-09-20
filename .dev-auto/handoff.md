# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 13 (stories 13.1, 13.2).
- Original request and intended outcomes: `/dev-auto 13` (2026-09-20, Claude Code). Epic 13 "Conversations That Survive": capture the harness's own conversation id from the `SessionStart` hook (FR17), and write down what survives plus a printed agent brief (FR18). Source: `_bmad-output/planning-artifacts/epics.md:587-681` and `reference-context-13-14.md:76-88`.
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local work, checks, isolated Electron runs, review dispatches, board/handoff updates and checked local commits (`~/.claude/CLAUDE.md` Authority; `/dev-auto 13` request). Push to `main` and `pnpm run update:desktop` are NOT yet authorized for this run. Out of scope per the epic: installing or editing the owner's hook files, owner-token changes, new network access, resume for other harnesses, a session daemon, `bmn wait`/`subscribe`. Never push the old private `feat/epic-1/2` branches.
- Authorized provider routes: native Claude Code helpers; Codex CLI, Claude CLI and configured GLM profile per `~/.claude/skills/dev-auto/references/models.md`; minimum task-relevant payload only.
- Lead host / requested model / observed model: Claude Code; no model requested by the task; observed `claude-opus-5[1m]` (session `ea13531c-e72d-4534-8edc-d155f1750851`).
- Prior run: Epic 9 handoff (COMPLETE) is in git history at `42f1bfc`.

## Progress

- Sprint board and reconciled state: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored) has epic-13 and both stories `backlog`; epics 5-9 `done`. Reconciled against git at `85df305` (clean tree, `main` level with `origin/main`). Delivery order 13 -> 14 -> 12 -> 11 -> 10.
- Implemented: story 13.1 in `fc94cd4`, story 13.2 in `e4e27dc`, review repairs in `30cd2d4`, all on `main` (local only; not pushed). Base `85df305`.
- Associated loop (optional; host and native loop/task ID): none
- Implementation and repair inventories, file by file: `.dev-auto/log.md`.
- Active native helpers (ID, route, scope, ownership, state): none
- Collected terminal helper results: full review of `e4e27dc` by Codex CLI `gpt-6-astra/medium` returned 8 findings (7 MATERIAL) to `.dev-auto/evidence/epic-13/review-astra.md` (sha256 5261464645f5…). Focused recheck of `30cd2d4` dispatched to `gpt-6-astra/low`, in flight.

## Decisions and findings

- Original or approved intent changes (13.1, all recorded for review):
  1. AC3's claim-conflict refusal is returned and not stored: the wording "the old binding and claim are kept" and AC2's "no stored change" are read literally, so the detail `Reported by Codex at session start; refused: already resumed in "<name>"` is the method's result, not a binding rewrite. The utility has no logger (zero `console.*` in `apps/desktop/src/utility`), so the returned reason is the "logged reason"; Epic 14.2's hook-event log is where it becomes owner-visible.
  2. The hook also ignores SessionStart payloads carrying `agent_id` (a Claude subagent), as herdr does (H1); the pid gate cannot catch an in-process subagent.
  3. AC4's "the command shown before Resume is exactly what runs": today no dialog shows a command, so the hook-captured Codex binding detail carries `Resume runs: <exact command>` and `not carried: <names>`; the session menu already renders the detail. A dropped prompt is counted, never quoted, so private text is not shown.
  4. A hook-captured Claude binding parses its stored argv with `allowExplicitSessionId: true`, so a selector BMN pinned at launch is superseded by the harness's word instead of blocking Resume; every other stored-argv rule is unchanged.
- Material pending findings: none open. M1 (claim rollback), M4 (early SessionStart), M5a/b/c (Resume flow), M6 (logged refusal) and M7 (route in snapshot/list) closed in `30cd2d4`; M2 and M3 were closed in the working tree while the review ran, so the reviewer excluded them. N1 (Codex `-i` arity) closed by reading it as one value. Acceptance waits only on the focused recheck's verdict.
- Design consult on the Resume confirmation: Fable, receipt `fable-dialog.json`. Adopted its copy, kind-named dropped arguments and Resume-autofocus; rejected showing the modal only when an argument is dropped, because AC4 requires the command shown before Resume.
- Cross-epic obligations: Epic 14 takes the next free schema migration number after 13.1 (13.1 takes 8). Story 13.2's brief must not contradict the dev-auto cockpit rules (B6). Launch-time Claude pinning and the honest `unsupported` fallback stay.

## Evidence

- Checks run and observed results, on `30cd2d4` at load average 2.3: `pnpm run typecheck` and `pnpm run lint` EXIT 0; `pnpm run test:unit` 980 passed / 1 skipped (`unit-3.log`, was 960 before the repairs and 913 at Epic 9); `pnpm run test:electron` EXIT 0 (`electron-6.log`), receipt `conversationFromHook.listed` = {"sessions":1,"conversation":{"status":"bound","captureRoute":"hook-session-start"}} from the hook-reported session's own `bmn list --json`. `codex resume --help` on codex-cli 0.155.1 read by hand for the accepted resume options (AC4); `claude --version` 2.1.278.
- Tests: unit tests for the hook mapping (4 accepted sources, compact, missing/non-UUID/non-string id, subagent payload, unknown source, nested agent, refused call), control validation (owner refused, cross-session refused, 7 invalid-argument shapes, lowercasing), the Codex option table and argv split, `bindingFromObservation` details, and session-manager precedence, refusals and claim release. Electron self-test phase "conversation reported by a session hook": a synthetic `#!node` Codex harness inside a real BMN session pipes a fixture SessionStart into the real `bmn hook codex`; the binding goes `unsupported` -> `hook-session-start`, a second session reporting the same id stays `unsupported`, and Stop then Resume spawns `resume 01a0b657-… --model gpt-6` (receipt field `conversationFromHook`, contract in `scripts/test/electron-self-test.mjs`).
- Reviewed scope and route: whole epic on `e4e27dc`, `gpt-6-astra` medium via Codex CLI read-only; focused recheck of `30cd2d4`, `gpt-6-astra` low, same route.
- Finding closures: every M1/M4/M5/M6/M7 fix ships a named regression test; the M1, M4 and M6 tests were each fence-probed RED with the fix mutated away. Test names, probes and observed failures: `.dev-auto/log.md`.
- Unreviewed or unverified areas: the real Claude Code 2.1.278 and Codex 0.155.1 SessionStart payload shape stays DOCUMENTED until the owner launches each once inside BMN and reads the binding. `codex resume` accepting the carried argv is DOCUMENTED from `--help`, exercised only against the synthetic harness. macOS UNVERIFIED.

## Measurement

- Timing: started 2026-09-20T09:50+03:00; story 13.1 checks green ~11:08+03:00; repairs committed 11:56+03:00.
- Dispatches:
  - Epic 13 full review via Codex CLI | epic-review | gpt-6-astra/medium | receipt `.dev-auto/evidence/epic-13/review-astra.json` | first
  - Resume-confirmation design consult via Claude CLI | ui-design | claude-fable-5-1/medium | receipt `.dev-auto/evidence/epic-13/fable-dialog.json` | first
  - Epic 13 focused recheck via Codex CLI | recheck | gpt-6-astra/low | receipt pending | second
- Owner interventions: none.
- Observed usage: pending.

## Resume

- Next safe action: collect the focused recheck of `30cd2d4`; if it returns no open material finding, set the board's epic-13 and both stories to `done`, record routes/tiers/usage with `scripts/check.py usage`, run `scripts/check.py check` and publish the handoff. Push and `pnpm run update:desktop` need the owner's authorization for this run.
- Status: ACTIVE
