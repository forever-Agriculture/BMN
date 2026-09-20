# Dev Auto log (append-only)

## 2026-09-20 — Epic 13 run start

- Owner command: `/dev-auto 13` (Claude Code, Opus 5 1M, session `ea13531c-e72d-4534-8edc-d155f1750851`).
- Board reconciled at `85df305`: epics 5-9 done, 13 next in the owner-decided order 13 -> 14 -> 12 -> 11 -> 10.
- `codex resume --help` on codex-cli 0.155.1 read by hand on 2026-09-20 for AC4; the accepted option
  table equals the top-level interactive options plus `--last`, `--all`, `--include-non-interactive`
  (resume-only, so a plain `codex` launch can never carry them). `--help`/`--version` deliberately
  excluded from the carried set.
- Codex rollout ids observed as UUIDv7 (`~/.codex/sessions/2026/09/19/rollout-*-01a0b657-21a8-7f00-addd-b73646828f5b.jsonl`)
  and Claude session ids as UUIDv4, both admitted by the existing `UUID_PATTERN`.

## 2026-09-20, consolidated repair round (Astra review of e4e27dc)

Full review verdict: `.dev-auto/evidence/epic-13/review-astra.md`
(sha256 recorded at dispatch). Eight findings, seven MATERIAL. Closures:

- M2 (equal stored reference bypasses the holder check) and M3 (exit-unconfirmed
  releases its claim) were already fixed in the working tree while the review ran;
  the reviewer explicitly excluded uncommitted edits from its verdict.
- M1, M4, M5, M6, M7 and N1 closed in `30cd2d4`.

Accidental revert during the round: a fence-probe of the M6 change ended with
`git checkout apps/desktop/src/utility/control-server.ts`, which discarded the
uncommitted `reportRefusal` edit. Recovered by reading the session transcript
(`ea13531c-….jsonl`): every other edit to that file was already in `fc94cd4`, and
the one lost edit was reapplied verbatim. No other file was touched by the checkout.

Fence probes (each mutated the fix away, re-ran the test, observed RED):
- rollback made unconditional again -> "leaves a conversation released mid-swap to
  the session that took it" FAILED (accepted true, expected false); "does not
  resurrect the claim of a session that ended while its swap was uncommitted"
  FAILED (accepted false, expected true).
- `await live.recordReady` removed -> "waits for the session record a hook beat"
  FAILED (accepted false, expected true). The first version of this test passed
  without the barrier because the fake store wrote its record synchronously; the
  store gained a `createGate` so the window is really open, and only then did the
  probe go red.
- `handlers.reportRefusal(...)` removed from the dispatch catch -> "records the
  refusal reason, which the hook itself throws away" FAILED.

Design consult on the Resume confirmation: Fable (`claude-fable-5-1`, effort
medium, tools disabled), receipt `.dev-auto/evidence/epic-13/fable-dialog.json`.
Adopted: name dropped arguments by kind ("1 positional argument", not "1 other
argument"); say why they are dropped; autofocus Resume rather than Cancel, since
Resume is not destructive and is the action just asked for; tighten the copy and
quote the session name. Rejected: showing the modal only when something is
dropped — AC4 requires the command shown before Resume, not only when an argument
is lost. Not taken up this run: a "Copy command" affordance on the command block
(outside the epic; the block is selectable).

Verbose results of the round: `pnpm run test:unit` 980 passed / 1 skipped
(`.dev-auto/evidence/epic-13/unit-3.log`); `pnpm run test:electron` EXIT 0
(`electron-6.log`), receipt field `conversationFromHook.listed` =
{"sessions":1,"conversation":{"status":"bound","captureRoute":"hook-session-start"}}.

## Implementation inventory, Epic 13 (moved out of the handoff at acceptance)

- Story 13.1: New capture route `hook-session-start` (`shared/protocol/src/binding.ts:22`, `workspace.ts:189-199`), schema migration 8 rebuilding `conversation_binding` with the widened CHECK (`store-schema.ts:305-350`), control method `conversation.observe` with session-only scope, closed params, UUID and absolute-path rules (`control-server.ts:648-675`), companion handler (`companion-service.ts:233`), `SessionManager.observeConversation` with precedence, refusals and an atomic claim swap (`session-manager.ts:530-645`), `bmn hook` SessionStart report (`apps/desktop/bin/bmn:427-447,505-512`), Codex resume option table + argv split + detail composition (`conversation-binding.ts:615-810`), docs row and enforcement bullet (`docs/agent-control.md:106,150-153`).
- Story 13.2: `bmn help agents` prints a 34-line brief (longest line 99 characters) held in `AGENT_BRIEF` (`apps/desktop/bin/bmn:50-86`), repeated verbatim in `docs/agent-control.md` "## A brief for agents" with a drift test; `## What survives` table in `docs/architecture.md:105-131` with the seven endings and six columns, linked from `README.md:27`; self-test `survivalTable` receipt asserts the renderer-crash and Quit rows.
- Repairs (`30cd2d4`): identity-checked claim rollback and `await live.recordReady` in `session-manager.ts:593,652-666`; `reportRefusal` on every `conversation.observe` throw (`control-server.ts:689-700`) and on a non-accepted result (`companion-service.ts:236-243`); `conversation: {status, captureRoute}` on `session.list`/`state.snapshot` from one bulk read (`companion-service.ts:481-500`, `database-binding-store.ts:141-158`); `session.resume.preview` sharing `prepareResumeLaunch` with the real resume (`session-manager.ts:771-841`, `pty-host.ts:400`), a `ResumeDialog` confirmation (`shell-dialogs.tsx:101-128`) and a `conversations` app event that reloads a binding a hook changed (`main.tsx:248-250,386-393`); `-i`/`--image` arity `required` (`conversation-binding.ts:648`).
