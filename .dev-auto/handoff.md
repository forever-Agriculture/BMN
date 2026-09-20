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

- Sprint board: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored) now has epic-13 and both stories `done`; epics 5-9 `done`. Reconciled against git at `85df305` (clean tree, `main` level with `origin/main`). Delivery order 13 -> 14 -> 12 -> 11 -> 10.
- Implemented and ACCEPTED: story 13.1 in `fc94cd4`, story 13.2 in `e4e27dc`, review repairs in `30cd2d4`, the reachable refusal log in `0a5ce6f`, wording in `9a8e8ca`; all on `main`, local only, NOT pushed. Base `85df305`.
- Associated loop (optional; host and native loop/task ID): none
- Implementation and repair inventories, file by file: `.dev-auto/log.md`.
- Active native helpers (ID, route, scope, ownership, state): none
- Collected terminal helper results: full review of `e4e27dc` by Codex CLI `gpt-6-astra/medium` returned 8 findings (7 MATERIAL) to `evidence/epic-13/review-astra.md`. Focused recheck of `30cd2d4` (`recheck-astra.md`) closed 7 of 8, left M6 PARTIALLY CLOSED, DO NOT ACCEPT. M6 fixed in `0a5ce6f`; the M6 recheck (`recheck2-astra.md`) returned "Finding 6: CLOSED", "No material blocking defect found in this diff" and ACCEPT.

## Decisions and findings

- Original or approved intent changes (13.1), four of them, each reviewed and accepted: `.dev-auto/log.md`.
- Material pending findings: none. All eight review findings are CLOSED by an independent recheck; no new defect was introduced by the repairs. M6 needed two rounds: the utility's stderr is captured into a bounded in-memory buffer (`pty-host-client.ts:156-158,297-305`) and printed only if the host dies, so `0a5ce6f` writes refusals to `refused-requests.log` in the state root instead.
- Non-blocking notes the recheck left open, recorded not fixed: a failed refusal write is swallowed (the stderr line is written first and survives); existing directory and file permissions are not tightened, only creation modes; a sustained flood of refusals grows the pending write queue, since the size cap gives no backpressure.
- Design consult on the Resume confirmation: Fable, receipt `fable-dialog.json`. Adopted its copy, kind-named dropped arguments and Resume-autofocus; rejected showing the modal only when an argument is dropped, because AC4 requires the command shown before Resume.
- Cross-epic obligations: Epic 14 takes the next free schema migration number after 13.1 (13.1 takes 8). Story 13.2's brief must not contradict the dev-auto cockpit rules (B6). Launch-time Claude pinning and the honest `unsupported` fallback stay.

## Evidence

- Checks run and observed results, on `0a5ce6f` (earlier numbers were `30cd2d4`), load average 2.3: `pnpm run typecheck` and `pnpm run lint` EXIT 0; `pnpm run test:unit` 982 passed / 1 skipped (`unit-5.log` on `9a8e8ca`, `unit-4.log` on `0a5ce6f`, was 960 before the repairs and 913 at Epic 9); `pnpm run test:electron` EXIT 0 (`electron-7.log`), receipt `conversationFromHook.listed` = {"sessions":1,"conversation":{"status":"bound","captureRoute":"hook-session-start"}} from the hook-reported session's own `bmn list --json`, and `conversationFromHook.refusalReason` read from `refused-requests.log` while the app ran. `codex resume --help` on codex-cli 0.155.1 read by hand for the accepted resume options (AC4); `claude --version` 2.1.278.
- Tests: unit tests for the hook mapping (4 accepted sources, compact, missing/non-UUID/non-string id, subagent payload, unknown source, nested agent, refused call), control validation (owner refused, cross-session refused, 7 invalid-argument shapes, lowercasing), the Codex option table and argv split, `bindingFromObservation` details, and session-manager precedence, refusals and claim release. Electron self-test phase "conversation reported by a session hook": a synthetic `#!node` Codex harness inside a real BMN session pipes a fixture SessionStart into the real `bmn hook codex`; the binding goes `unsupported` -> `hook-session-start`, a second session reporting the same id stays `unsupported`, and Stop then Resume spawns `resume 01a0b657-… --model gpt-6` (receipt field `conversationFromHook`, contract in `scripts/test/electron-self-test.mjs`).
- Reviewed revision and route: whole epic on `e4e27dc`, `gpt-6-astra/medium` via Codex CLI read-only; focused rechecks of `30cd2d4` and `0a5ce6f`, `gpt-6-astra/low`, same route. Accepted at `0a5ce6f`; `9a8e8ca` changes only a comment, a test name and a doc sentence.
- Finding closures: every M1/M4/M5/M6/M7 fix ships a named regression test; the M1, M4 and M6 tests were each fence-probed RED with the fix mutated away. Test names, probes and observed failures: `.dev-auto/log.md`.
- Unreviewed or unverified areas: the real Claude Code 2.1.278 and Codex 0.155.1 SessionStart payload shape stays DOCUMENTED until the owner launches each once inside BMN and reads the binding. `codex resume` accepting the carried argv is DOCUMENTED from `--help`, exercised only against the synthetic harness. macOS UNVERIFIED.

## Measurement

- Timing: started 2026-09-20T09:50+03:00; story 13.1 checks green ~11:08+03:00; repairs 11:56+03:00; M6 refusal log 12:02+03:00; accepted 12:06+03:00.
- Dispatches:
  - Epic 13 full review via Codex CLI | epic-review | gpt-6-astra/medium | receipt `.dev-auto/evidence/epic-13/review-astra.json` | first
  - Resume-confirmation design consult via Claude CLI | ui-design | claude-fable-5-1/medium | receipt `.dev-auto/evidence/epic-13/fable-dialog.json` | first
  - Epic 13 focused recheck of `30cd2d4` via Codex CLI | recheck | gpt-6-astra/low | receipt `evidence/epic-13/recheck-astra.json` | second
  - Epic 13 M6 recheck of `0a5ce6f` via Codex CLI | recheck | gpt-6-astra/low | receipt `evidence/epic-13/recheck2-astra.json` | third
- Owner interventions: none.
- Observed usage: read with `scripts/check.py usage`; lead `claude-opus-5/xhigh` 243k out / 68.9M cache-read over 315 responses; review `gpt-6-astra/medium` 1,943,649 tok; rechecks `gpt-6-astra/low` 411,453 and 148,123 tok; design consult `claude-fable-5-1` 559 out, $0.122. Requested and observed routes matched throughout; no substitution, no dispatch failure. Per-receipt detail in `.dev-auto/log.md`.

## Resume

- Next safe action: none required for Epic 13. To publish it, the owner must authorize `git push origin main` and then `pnpm run update:desktop` (AGENTS.md), neither of which is authorized for this run. The next planned epic is 14.
- Status: COMPLETE — Epic 13 accepted; nothing authorized remains.
