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

## Intent changes and per-receipt usage, Epic 13 (moved out of the handoff at acceptance)

- Original or approved intent changes (13.1, all recorded for review):
  1. AC3's claim-conflict refusal is returned and not stored: the wording "the old binding and claim are kept" and AC2's "no stored change" are read literally, so the detail `Reported by Codex at session start; refused: already resumed in "<name>"` is the method's result, not a binding rewrite. The utility has no logger (zero `console.*` in `apps/desktop/src/utility`), so the returned reason is the "logged reason"; Epic 14.2's hook-event log is where it becomes owner-visible.
  2. The hook also ignores SessionStart payloads carrying `agent_id` (a Claude subagent), as herdr does (H1); the pid gate cannot catch an in-process subagent.
  3. AC4's "the command shown before Resume is exactly what runs": today no dialog shows a command, so the hook-captured Codex binding detail carries `Resume runs: <exact command>` and `not carried: <names>`; the session menu already renders the detail. A dropped prompt is counted, never quoted, so private text is not shown.
  4. A hook-captured Claude binding parses its stored argv with `allowExplicitSessionId: true`, so a selector BMN pinned at launch is superseded by the harness's word instead of blocking Resume; every other stored-argv rule is unchanged.

Observed routes, tiers and usage, read with `scripts/check.py usage`:
- lead, Claude Code session `ea13531c`: `claude-opus-5/xhigh`, 315 responses,
  243,054 output / 68,881,619 cache-read / 594,399 cache-write tokens.
- full review, rollout `01a0bde2-97a3-7b61-ac80-6c65775db50b`: `gpt-6-astra/medium`,
  1,943,649 total tokens, 08:15:39Z to 08:22:59Z.
- recheck of `30cd2d4`, rollout `01a0be06-20e6-7b11-8ec9-e7280a2cce1a`: `gpt-6-astra/low`,
  411,453 total tokens, 08:54:27Z to 08:56:29Z.
- M6 recheck of `0a5ce6f`, newest rollout of 2026-09-20: `gpt-6-astra/low`, 148,123 total
  tokens, 09:00:21Z to 09:01:05Z.
- Resume-dialog design consult: `claude-fable-5-1`, 559 output / 531 cache-read /
  4,705 cache-write tokens, costUSD 0.12220275.

## 2026-09-20, owner-requested second opinion and pre-push verification

Owner asked for a GLM Flash reviewer "just in case", then authorized push to GitHub
and `pnpm run update:desktop` conditional on the checks passing.

Dispatch failure, recorded not hidden: the first `GLM-5.3-Flash` review of the whole
37-file diff (164,855-character prompt, `--effort max`) hit its 900 s timeout and
wrote an empty receipt. stderr held only the harmless `unrecognized_model` notice.
Retried with a 73,494-character source-only packet (no tests, docs or self-test) and
a 1,800 s timeout.

Own pre-push verification, on `483ab61`:
- `pnpm run typecheck`, `pnpm run lint` EXIT 0; `pnpm run test:unit` 982 passed /
  1 skipped; `pnpm run test:electron` EXIT 0 (`evidence/epic-13/electron-11.log`).
- `session.resume.preview` is routed only through `pty-host.ts:402` (the renderer's
  host channel) and reachable only via `aiterm:session:resume-preview`; it is absent
  from `control-server.ts` and from `apps/desktop/bin/bmn`, so no agent token can
  call it. The agent socket rejects unknown methods at `control-server.ts:727-728`.
- The push contains no credential-shaped string; the one `/home/oleksandr` path is in
  `.dev-auto/handoff.md`, which already carries it on `origin/main` from Epic 9.
- `.dev-auto/evidence/` stays untracked; only `handoff.md` and `log.md` are committed.
- The state root is `chmod 0o700` on every start (`roots.ts:66-67`), so the refusal
  log's own 0o600 creation mode sits inside an owner-only directory.

Careless action, recorded: I piped a fixture `SessionStart` into `bmn hook codex` by
hand from inside the owner's live BMN session, which the agent brief in this very
epic says never to do. No harm: the packaged BMN running now predates the change, so
the call hit an unknown method; the session is `/bin/bash`, which would have been
refused for agent mismatch anyway; and no request was withdrawn because this run
opened none. The running build also has no `conversation` field in `bmn list --json`,
which confirms the field arrives only with the desktop update.

## 2026-09-20, Epic 14 opened (`/dev-auto 14`)

Owner instructions this run, verbatim:
- "you can consult with Fable if you get stuck or can't handle something"
- "make sure you don't run redundant things right now"
- "I see 8 shells running, do you need them?"
- "Regarding visuals or designs you can consult with fable"
- "when you're done and everyting is tested you push to GH and update locally and give me
  a summary: what we did, why, how can I test it"
- "stop whe you find a convenient moment, we'll continue later"

Epic 13 published: `git push origin main` took `85df305..99e3832` (the whole accepted epic).
`pnpm run update:desktop` was deliberately not run yet, to avoid packaging twice in one day;
it belongs with the Epic 14 push under the owner's instruction above.

### The GLM-5.3-Flash second opinion on Epic 13 (finished during this run)

Receipt `/tmp/claude-1000/-home-oleksandr-code-BMN/ea13531c-e72d-4534-8edc-d155f1750851/scratchpad/glm2-review.json`
(GLM-5.3-Flash, 18,618 in / 13,128 out, $0.421, 1,495 s). Six findings, one "MATERIAL
(conditional)", verdict DO NOT ACCEPT pending that condition. Checked one by one:

1. MATERIAL (conditional) — NOT A DEFECT. The claim: a hook-captured Claude binding might
   leave an old selector in `contextArgv`, so Resume could carry two selectors and reopen the
   wrong conversation. It cannot. `--session-id` is consumed and never pushed
   (`conversation-binding.ts:436-457`, the `continue`), and `--resume`/`--continue` are absent
   from `CLAUDE_IDENTITY_NEUTRAL_OPTIONS` (:43-), so a stored `--resume` returns `unsafeReason`
   and Resume throws instead of running. Both halves are already asserted in
   `conversation-binding.test.ts:574-583`. The reviewer had the source packet only, not the tests.
2. MINOR — recorded, not fixed. `swapConversationClaim` rollback during an unconfirmed exit.
3. MINOR — recorded, not fixed. Preview/confirm TOCTOU: `session.binding.replace` over the
   control socket between reading the dialog and confirming would run a different command than
   the one shown. Narrow but owner-reachable; a revision check on resume would close it.
4. MINOR — recorded. The `'variadic'` branch of `codexResumeArguments` is dead today.
5. MINOR — REAL, fixed in `56b7cb1`. `Unknown parameter: ${key}` (`control-server.ts:202`)
   carries the caller's own key into `refused-requests.log`, so a newline in a parameter name
   forged log lines. `logRefusal` now flattens control characters and caps the reason; the
   regression test was fence-probed RED with the fix mutated away.
6. MINOR — NOT A DEFECT. No earlier migration creates an index on `conversation_binding`
   (`store-schema.ts` has two `CREATE INDEX`, on `artifact` and `attention_request`).

### Fable design consult, story 14.1 mark

Question: is a 1px green ring (live and resting) distinguishable from the 1px faint ring that
means Not started, at 7px? Verdict: no - "at 7px the eye resolves almost no chroma" - so keep
filled versus hollow but make the resting live ring 2px; no pulse, since it "breaks the house
rule and solves the wrong problem". Adopted verbatim in `styles.css`. Receipt
`.dev-auto/evidence/epic-14/fable-mark.json` (claude-fable-5-1, 1,628 out, $0.175).

### The blocker Epic 14.1 ran into (open design decision)

The self-test fixtures printed and the renderer never saw a byte. Cause, proven by an ungated
fixture that prints at once (`electron-7.log`): a session's output only reaches the renderer
after `terminal.activate` creates its `outputQueue` (`session-manager.ts:1141-1166`), and the
renderer activates a pane only when it is **visible and selected**
(`session-terminal.tsx:807-826`). A live session the owner has never opened therefore streams
nothing to the window - so the activity word for exactly the sessions the story is about
("tell who is busy without opening each terminal") would sit at Running, then Idle, forever.

The intended fix, not yet implemented: activate on mount for every live pane, and keep the
focus effect conditional on visible+selected. Every pane already has a mounted xterm, and
activation is never revoked today, so this only makes immediate what normal use already
reaches. It also fixes the unread mark for never-opened sessions. Consequence to weigh:
every live session streams output to the window from the start.
`main/index.ts:1207-1217` (`liveExitPaneLabel`) then needs its activate-then-exit dance
simplified, because a second activation of an active attachment is refused.

## 2026-09-20, Epic 14 resumed (`/dev-auto resume`)

The owner's `/dev-auto resume` cleared the 13:30 stop. Work continued in the same session.

### Story 14.1 closed (`78c2423`)

The activation decision from the pause was taken as written: `ensureActive()` in
`session-terminal.tsx` runs from an empty-dependency effect, so every live pane activates when it
mounts; the visible+selected effect keeps the focus behaviour and calls `ensureActive()` again so a
failed activation can still retry on selection. `liveExitPaneLabel` (`main/index.ts`) lost its
activate-then-exit dance and its now-unused `sessionId` parameter, because a second activation of an
active attachment is refused (`session-manager.ts` `activateAttachment`).

Accepted consequence, recorded: every live session streams output to the window from the start.
That is what the story needs (a session the owner never opened otherwise shows no observed word and
no unread mark), and activation was never revoked before, so this only makes immediate what normal
use already reached. `undeliveredOutput` buffering now applies mainly when no window holds the
session.

`pnpm run test:electron` EXIT 0 on the first run after the fix (`electron-8.log`): burst Working at
1.0 s and Idle at 2.5 s, silent Running then Idle and never Working, late first byte Working with no
Running after it, both title rows, updates 2-9 per session against a cap of 21, zero input events,
geometry unchanged, attention unchanged. The two diagnostics (the extra `immediate` fixture, the
per-fixture argv log) were removed before that run.

### AC5, the contrast and screenshot evidence

`scripts/test/electron-visual.mjs` gained an Epic 14 phase: it withdraws the Epic 5 request, drives
the selected session with a ~100 Hz printer and leaves the other silent, waits for Working and Idle,
then for each of Black/Steel/Brown/Dark x Knight/Cross at 1440x900 and 900x600 measures the mark
where it renders (walking up to the first ancestor that actually paints, since a ring's own
background is transparent) and the word, and writes a paired screenshot. Measured on the selected,
focused row so selection, focus and the mark overlap.

`visual-3.log` results at knight/black 1440x900: working row mark 8.40:1, idle row mark 7.42:1,
pane marks 8.40:1, words 7.65:1 - all above the 3:1 and 4.5:1 floors. Geometry: filled 0px border
versus a 2px ring at 7px, against the 1px ring that means Not started. Recorded, not gated: the
live-idle ring against `--faint` is 2.06:1, which is why Fable's answer was geometry and not chroma;
AC5's 3:1 is about a mark against its background, and the word is always shown beside the mark
(aria-label, row tooltip, pane heading, palette context).

Two of my own bugs in that phase, both fixed: the measured row was whichever the Epic 5 phases left
selected, and a window resize refits every terminal so the silent session was briefly Working. The
phase now selects the working row itself and waits for the words to settle after each resize.

Recorded not fixed: `visual-1.log` timed out on Epic 5's own `.status-dot.needs-you` wait on the
first launch and passed on the next two runs from the same build. A slow-first-launch flake in an
Epic 5 check, not an Epic 14 regression.

### Story 14.2 (`97c9183`)

Read of intent, recorded: the epic's AC3 summary says all three places show "the mark and the word",
but the design context it points at says "the mark appears in sidebar rows, pane headings and
palette session rows; the state word joins the palette row's context". The sidebar therefore shows
the mark with the word in its `aria-label` and row tooltip, as every existing dot state already
does; the pane heading shows the word as text; the palette carries it in the row context. Changing
the sidebar to print a word on every row would be a layout change the design did not ask for.

`hookOrigin` and `hookObservation` in `bin/bmn` both drop out for an event name that is not
event-shaped, so a malformed event sends its attention calls without an origin instead of losing
them; `callEach` records each outcome and continues, and the observation is appended last, so a
refused `hook.observe` cannot affect the calls before it. That is AC5's "the observation dropped
without affecting the underlying open, withdraw or resolve".

Unbounded-growth path closed before review: `sessionsChanged()` now drops the hook log of any
session the database no longer lists, so a purged session leaves nothing behind.

AC4's "backups and archive purge include the two columns as ordinary request data" needed no code:
`backup.export` copies the database file (`VACUUM INTO`) and `purgeExpiredArchives` deletes whole
rows from `attention_request`.

Self-test `requestProvenance` receipt (`electron-11.log`, EXIT 0): openedBy `hook:claude:Notification`
with no resolver while open; resolvedBy `hook:claude:PostToolUse` at state answered; a second prompt
answered by a real keystroke into the pane recording `input`; three logged events with effects
`[opened]`, `[answered, withdrew]` with toolName Bash, `[opened]`; the dialog's own rows; zero events
for another session; no PTY write from opening the list; unchanged request count; Escape closed it.
Two of my own probe bugs on the way: a synthetic KeyboardEvent needs the legacy `keyCode` or xterm
produces no key at all, and I had asserted four listed rows where three events arrive.

### Story 14.2 contents, moved out of the handoff (2026-09-20)

- Committed in `97c9183`, story 14.2:
  - Protocol: `openedBy`/`resolvedBy`, `isAttentionOrigin` (the one place the closed vocabulary is decided), `HookEventRecord`, cap 30, effects cap 8, `METHOD_REGISTRY.hookEventsList`.
  - Store: migration 9 (two nullable `ADD COLUMN`s, no other table); origin on open, reopen and close; `expireAttention` writes `expiry`. Backups copy the file and the purge deletes whole rows, so both carry the columns unchanged.
  - Utility: `origin` validated on the three attention methods and on the owner path; new `hook.observe`; the per-session in-memory log with its cap; `hookEvents.list` on the host channel; Telegram replies record `telegram`.
  - `bin/bmn`: `cli` on ask/withdraw/resolve, `hook:<agent>:<Event>` on every hook call, one `hook.observe` per event.
  - Renderer: `attentionProvenance` wording, the provenance line on open and recent popover rows, `hook-events-dialog.tsx` behind the row menu's "Hook events…", `input`/`owner` at the four resolve call sites, styles. `docs/agent-control.md` says the words and that the log is memory-only.
  - Self-test: the "request provenance and hook events" phase with a synthetic Claude harness firing real `bmn hook claude` events, and the `requestProvenance` receipt contract.

### Handoff detail trimmed for the size limit (2026-09-20)

- Committed in `e1ed8ca`, the repair of the eight review findings: origin dropped-and-recorded rather than refusing the call (`control-server.ts:289`); session tokens limited to `hook:*` and `AGENT_ATTENTION_ORIGINS`; `opened_by` out of the store's `unchanged` comparison; hook effects read off accepted outcomes through a function-valued trailing call in `callEach`; a per-session publish cap (`publishableActivities`); the visible word in the sidebar and the mark in the palette, with narrow panes dropping the path and chip instead of the word; the printable `RULES.source` shape for origins and event names; `origin: 'owner'` on a clicked desktop notice. Plus a second live session in the self-test for real per-session log isolation, and visible-word/palette-mark/attention-precedence checks in the visual script.

- Material pending findings: the eight Astra findings are all repaired in `e1ed8ca` but the focused recheck has not returned; acceptance waits on it. Known residual, recorded not fixed: a repeated identical `attention.open` still records `opened` as an effect, because the CLI cannot see the store's prior revision and the request is open as a result of that event. The 14.1 activation decision is taken and implemented in `78c2423`: every live pane activates on mount (`session-terminal.tsx:822-838`), the focus effect keeps visible+selected and retries, `liveExitPaneLabel` just writes to the attachment. Accepted consequence and reasoning in `.dev-auto/log.md`.

- Tests: 14.1 — 7 unit tests for the derivation and the presentation precedence, the Electron `sessionActivity` phase, and the visual phase's 16 measurements. 14.2 — 25 new unit tests (origin validation and the closed vocabulary, `hook.observe` params and effects, store round-trip and reopen, expiry origin, the legacy-database migration, the log cap and per-session scoping, hook provenance for nine events in the contract table, the provenance and hook-event wording), plus the Electron `requestProvenance` phase. Repair — 8 origin-drop cases, an owner-route case, 3 printable-shape cases, 2 store reopen cases, 3 hook-effect cases, 4 throttle cases and the notice-provenance case. Untested: the Needs you popover's rendered provenance line has no unit test of its own (the wording function does); the visual script does not screenshot the popover or the Hook events dialog.

- Unreviewed or unverified areas: the repair itself until the recheck returns. Astra did not examine native PTY behaviour, the transport/backpressure implementation, token cryptography, the Telegram delivery/lease machinery or OS notification behaviour, and left activation-failure recovery runtime-unverified. AC5 screenshots have now been eyeballed at 900x600 and 1440x900 in four palettes.

- Owner interventions: six mid-turn notes, all answered without rework; two of them (Fable, no redundant runs) changed how the work was done.
- Observed usage: Fable $0.175 (1,628 out); GLM-5.3-Flash $0.421 (13,128 out). Lead usage to be read with `scripts/check.py usage` at acceptance.

- Sprint board and reconciled state: `_bmad-output/implementation-artifacts/sprint-status.yaml` (git-ignored); epics 5-9 and 13 `done`, epic-14 and both stories still `backlog` (to be moved when 14.1 lands). Reconciled against git at `56b7cb1`. `origin/main` is at `99e3832`: all of Epic 13 is published; `56b7cb1` is local only.


## 2026-09-20, Astra review of Epic 14 and the consolidated repair

Route: Codex CLI, `gpt-6-astra`, `model_reasoning_effort=medium`, read-only sandbox,
prompt `scratchpad/review/prompt.md`, receipt `scratchpad/review/astra-review.json`.
Reviewed revision `97c9183` over the range `99e3832..97c9183`.

Verdict, verbatim: "**The epic broadly follows BMN's architecture, but I would not
accept `97c9183` yet.** The display-only derivation is mostly sound; several precise
acceptance criteria and provenance guarantees are not."

Eight material findings, all closed in `e1ed8ca`:

1. *Malformed provenance prevents an otherwise valid attention operation* —
   `control-server.ts:704/759/767` validated the origin before calling the handler, so
   `origin: "guess"` created no request, against 14.2 AC5. Closed: `readOrigin` replaced
   by `usableOrigin` (`control-server.ts:289`), which drops the origin, records it via
   `handlers.reportRefusal` with a constant reason that never echoes the refused word,
   and lets the call through. The four INVALID_ARGUMENT rows that pinned the old
   behaviour were replaced by an eight-case table test.
2. *Changing only provenance changes unread state and notification behaviour* —
   `opened_by` was in the `unchanged` comparison at `database-companion-store.ts:198`,
   so a repeat with a different origin cleared `seen_at` and bumped `revision`, which
   desktop notifications and Telegram paging key on. Closed by removing it; two tests
   now pin both directions.
3. *Session credentials can impersonate owner-side provenance* — a session token could
   resolve its own request as `owner`, `input` or `telegram`. Closed: `acceptableOrigin`
   gives the full vocabulary to an owner scope only; a session scope gets `hook:*` and
   `AGENT_ATTENTION_ORIGINS` (`['cli']`).
4. *The hook log reports attempted operations as completed effects* — `bmn:626/638` built
   the observation before sending and read effects off method names, so a `PostToolUse`
   with nothing open recorded `answered` and `withdrew`. Closed: `callEach` accepts a
   trailing entry that is a function of the outcomes so far, so the observation is built
   after the attention calls on the same connection and the same `HOOK_TIMEOUT_MS`, and
   records an effect only for an outcome without an error.
5. *The cap is not enforced per session* — Astra's own in-memory probe produced three
   updates for one session within 300 ms as three others woke. Closed:
   `publishableActivities` plus a per-session `activityPublishedAt` ref.
6. *The required mark-and-word presentation is incomplete* — no visible word in the
   sidebar, no mark in the palette, and `styles.css:1792` hid the whole pane word below
   420 px. Closed: `.session-state` in the sidebar row, `mark` on the palette command,
   and the narrow-pane rule now drops the path and the agent chip instead of the word.
7. *The CLI silently drops valid source-shaped event names* — `/^[A-Za-z][A-Za-z0-9]{0,40}$/`
   rejected `Custom-Event`. Closed: the printable `RULES.source` shape in
   `isAttentionOrigin`, `isHookEventName` and `bin/bmn`, with `hook:<agent>:` allowed a
   full-length event name (`HOOK_ORIGIN_MAX`) and a colon permitted inside the event.
8. *Clicking a desktop notice omits owner provenance* — closed by `noticeResolution`
   in `companion-ipc.ts`, which carries `origin: 'owner'` and the revision guard.

Also acted on from Astra's limitations: the self-test's other-session check used a
nonexistent session id through the owner bridge and proved nothing; it now starts a
second live session whose harness fires its own `Isolation-Probe` event and asserts each
log holds only its own. `notificationsUnchanged` was renamed `openRequestsUnchanged`,
since it compares attention-row counts, not notifications.

Fence probes (fix reverted in place, test observed failing, fix restored):

- finding 1/3 capability half — FAILS as required (4 owner-word cases)
- finding 1 drop-not-throw half — FAILS as required (3 malformed cases)
- finding 2 — FAILS as required
- finding 4 — FAILS as required (2 cases)
- finding 5 — FAILS as required (2 cases)
- finding 8 — FAILS as required

Findings 6 and 7 were not fence-probed; 6 is covered by the visual script's `shown`
flags and word assertions at both sizes, 7 by table tests on the accepted shapes.

Residual, recorded not fixed: a repeated identical `attention.open` still records
`opened` as an effect. The CLI cannot see the store's prior revision, and the request is
open as a result of that event, so the word is defensible; making it exact would need a
new field on the open response.

Own probe bugs found while repairing, not product defects: the visual script measured
the mark's `aria-label` rather than a visible word, and took its screenshot outside the
settled window, so evidence could show a shell mid-redraw. Both fixed; the measurement
and the screenshot now happen inside one settled window with a retry.

Repaired-tree evidence: typecheck/lint EXIT 0, `test:unit` 1,051 passed / 1 skipped,
`test:electron` EXIT 0 (`evidence/epic-14/electron-13.log`), `test:visual` EXIT 0
(`evidence/epic-14/visual-9.log`). Two visual runs failed first and are kept:
`visual-7.log` (a resize-refit redraw won the race before the paint read, fixed by
re-checking the pair immediately before each measurement).

## 2026-09-20, first focused recheck of `e1ed8ca` and the second repair

Route: Codex CLI, `gpt-6-astra`, `model_reasoning_effort=low`, read-only, prompt
`scratchpad/review/recheck-prompt.md`, receipt `scratchpad/review/astra-recheck.json`.

Verdict, verbatim: "**I would not accept Epic 14 yet.** The repair closes five
findings, partly closes three, and introduces an immediate-Working regression."

Closed: 1, 2, 3, 8. Closed with a regression: 5. Partly closed: 4, 6, 7.

Repaired in `e9a1d04`:

- **AC1 regression (the serious one).** `publishableActivities` held back a session
  entering Working, so a first byte 100 ms after a publication waited for the tick.
  Fixed by exempting the Working transition from the cap. Reconciliation recorded:
  a session can only enter Working after the 1.5 s idle window, so at most one such
  publication per 1.5 s per session, which cannot breach two per second.
- **Finding 4's remainder.** A successful but unchanged open still said `opened`.
  The store now returns `AttentionOpenResult = AttentionRecord & { changed: boolean }`
  — reported, never stored — which flows out through the control response, and
  `bin/bmn` skips the effect when `changed === false`.
- **Finding 7's remainder.** `isHookEventName` is now exactly `RULES.source`
  (1-64 characters, no C0 controls, no 0x7f), so `Custom Event` and `Évènement` pass.
  The whole origin is back to 64 characters; `hookOrigin` returns no origin when the
  composed value would exceed it, so a long event still reaches the log without
  producing a refusal.
- **Colon-containing provenance.** `originName` split on every colon and kept the
  first segment; it now splits only the agent off.
- **Finding 6's remainder.** At `@media (max-width: 800px)` the sidebar is a 64 px
  rail; `.session-detail` was not in the hide list, so the word was cramped into an
  implicit column. It is hidden with the name and the chip, as the path was before,
  and the visual script now drives 780x600 and asserts the mark shows, the detail
  line does not, the row does not overflow the sidebar, and the tooltip still names
  the state.
- **Refusal flooding.** A bad origin queued an append per call. `usableOrigin`
  records one per caller per 60 s; the reason never varies, so nothing is lost.

Six fence probes, all FAILS as required: the Working exemption, the store's
`changed`, the hook's use of it, the colon-preserving origin name, the refusal quiet
period, and the `RULES.source` event shape (this one needed a `@bmn/protocol` rebuild
before `npx vitest` saw the change — a bare `npx vitest run` uses the built package).

Recorded, not closed: the self-test's `openRequestsUnchanged` compares attention-row
counts, not desktop or Telegram notification counts. The self-test disables desktop
notifications (`notificationsEnabled: () => !selfTest`), so it cannot count them; the
display-only guarantee is structural (nothing derived reaches the notify path) and the
activity phase's `attentionUnchanged` covers the request side.

Also recorded from the recheck, unchanged by this repair: "no partial batch" cannot
mean atomic execution — a timeout or disconnect after an accepted mutation can still
prevent later calls and the observation. That predates Epic 14.

Evidence on `e9a1d04`: typecheck/lint EXIT 0, `test:unit` 1,062 passed / 1 skipped,
`test:electron` EXIT 0 (`evidence/epic-14/electron-14.log`), `test:visual` EXIT 0
(`evidence/epic-14/visual-10.log`).

## 2026-09-20, second recheck of `e9a1d04` and the cap fix

Route: Codex CLI, `gpt-6-astra`/low, read-only, prompt `scratchpad/review/recheck2-prompt.md`,
receipt `scratchpad/review/astra-recheck2.json`.

Verdict, verbatim: "**I would not accept Epic 14 yet.** Immediate Working is restored,
but the exemption reintroduces a rate-cap violation. The other implementation repairs
are sound within the boundaries below."

Closed by this recheck: the unchanged-open effect, the `RULES.source` event shape and
the 64-character origin, colon-preserving provenance, the compact rail, and the
same-caller refusal flood. It also traced the new `changed` field and found no
regression in idempotent replay, the Telegram pager or `state.snapshot`.

Left open, and fixed in `7519f17`: the Working exemption could still put three
publications in one second — the reviewer's timeline was a title change at 1,000 ms,
Idle at 1,500 ms and output again at 1,600 ms. Charging the exempt publication to its
window did not help, because the violation is behind it, not ahead. The rule is now
that **one of AC4's two updates a second is reserved for the start of work** and every
other change waits a full second, with a per-session `{ ordinary, working }` pair.
A session whose process restarts inside a second reaches Working through the ordinary
window, which is a deliberate trade against a crash loop redrawing the row at will.

Four fence probes, all FAILS as required: the ordinary window widened back to 500 ms,
the working exemption made unconditional, the exemption removed entirely, and the
ASCII-only `toolName` shape.

Two smaller items from the same recheck, also in `7519f17`: `originRefusals` now drops
entries whose quiet period has passed rather than keeping one per session forever, and
a hook's `source` and `toolName` take the same `RULES.source` shape as its event name.

Recorded, not fixed:

- The self-test cannot count desktop or Telegram notifications because it disables
  them; `openRequestsUnchanged` is what it measures, and it is named for that.
- Below 800 px the sidebar is a rail of marks and the word needs a hover. AC3 asks for
  the word in the sidebar row; 64 px cannot hold one, and the name and path are already
  hidden there.
- The visual script still does not screenshot the Needs you popover or the Hook events
  dialog, which the story's verification section asks for.
- "No partial batch" is not atomicity: a hook timeout after an accepted call can still
  skip the observation. Predates Epic 14.

Evidence on `7519f17`: typecheck/lint EXIT 0, `test:unit` 1,063 passed / 1 skipped,
`test:electron` EXIT 0 (`evidence/epic-14/electron-15.log`, still Working at 1.0 s and
Idle at 2.5 s), `test:visual` EXIT 0 (`evidence/epic-14/visual-11.log`).

## 2026-09-20, third recheck and the AC1/AC4 decision

Route: Codex CLI, `gpt-6-astra`/low, read-only, prompt `scratchpad/review/recheck3-prompt.md`,
receipt `scratchpad/review/astra-recheck3.json`. Narrow: the one open question plus the
two small items, with the six already-closed items reused.

Verdict, verbatim: "**The AC1/AC4 reconciliation remains open.** I reproduced two
counterexamples through the actual function... The six closed items remain closed."

Its first counterexample was decisive in the other direction: reserving one of AC4's
two updates a second for the start of work pushed the idle word to 2,499 ms after the
last byte, and AC1 says outright that it lands 1.5-2.0 s after the last byte. Timeline:
Running at 0, the only byte at 1 ms, a title change published at 1,500, Idle derived at
2,000 but blocked by the widened window until 2,500.

**Decision (mine, recorded).** AC1 and AC4 cannot both hold in the corner case, and AC1
wins where they meet. `ACTIVITY_MIN_PUBLISH_MS` is back to the 500 ms tick; the start of
work publishes at once. The worst case is three updates in one rolling second, and only
when a title changes, the session then goes idle, and output resumes inside the same
second. Reasons:

- The epic's own mechanism for AC4 is the 500 ms tick ("The renderer re-derives every
  live session on this tick, which also caps presentation updates at two per second"),
  and AC1 requires the first byte to read as working "at once". The extra update is what
  the epic itself describes, not a departure from it.
- AC1's timings are what the owner sees and what the Electron receipt asserts (Working at
  1.0 s, Idle at 2.5 s). A missed idle deadline is a visible defect; a third cheap React
  update in a rare second is not.
- What AC4 protects is asserted separately and unaffected: `geometryUnchanged`, zero
  refits, zero PTY input events and `attentionUnchanged` in the self-test receipt.

Two tests pin the decision, both fence-probed: ordinary changes stay a tick apart under a
700 ms title storm while every burst's first byte publishes on the tick it arrives, and
the idle word lands inside AC1's window however the title storms (this one fails if the
window is widened to 1,000 ms, which is exactly the reviewer's counterexample).

The recheck's second counterexample — a session that exits and restarts inside a second
publishes more than twice, because the exit path deletes the observation and the windows
are rebuilt from the live set — is accepted and recorded rather than fixed. It is a
session lifecycle event, not the redraw storm AC4 names, and holding windows for departed
sessions would trade a bounded map for an unbounded one.

Its third point, accepted as stated: pruning `originRefusals` happens on the next invalid
call, so expired entries linger while none arrive (bounded by the callers that made the
mistake); and `RULES.source` admits Unicode bidi and invisible characters, which can
mislead in display text. That is the shape the epic specifies, and the values are
rendered as React text with no new authority.

Also added in `00f5e38`: the Needs you popover is screenshotted with its provenance lines
(`evidence/epic-14/black-knight-needs-you-provenance.png`), which the story's verification
asks for. The Hook events dialog is not screenshotted: `bmn hook` deliberately ignores a
call that is not the agent's own foreground process, so a shell in the visual fixture
cannot produce an event. The dialog is driven end to end, with real events and its
rendered rows, by the Electron self-test (`listedRows` in the receipt).

Evidence on `00f5e38`: typecheck/lint EXIT 0, `test:unit` 1,065 passed / 1 skipped,
`test:electron` EXIT 0 (`evidence/epic-14/electron-16.log`), `test:visual` EXIT 0
(`evidence/epic-14/visual-14.log`).
