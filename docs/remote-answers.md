# Remote answers: how each agent is answered

BMN can answer an agent's question or permission prompt from Telegram (Epic 30). This page records,
per agent version and prompt shape, exactly how that answer is delivered, how BMN recognises the
dialog on screen, and what proves the answer landed. Code follows this table: a shape that is not
**VERIFIED** here gets a card without buttons. Cursor's terminal agent reports no question or permission
prompt through its hooks, so it has no row here: its only card is the finished-turn notice
([agent-control.md](agent-control.md#cursors-terminal-agent)).

Measured 2026-09-27 (Epic 30; multi-select, typed answers and Back in Epic 31, same night, same versions) against Claude Code 2.1.283, codex-cli 0.157.1 and OpenCode 1.18.32, each driven
in a real terminal (tmux, 200×50 and 80×40) with BMN's control variables removed. Raw captures and a
SHA-256 manifest are under `.dev-auto/evidence/remote-answers/` (not committed). Sanitised hook
payloads and screen text are the test fixtures in
`apps/desktop/src/utility/test-fixtures/remote-answers/`.

## Shape matrix

| Shape | Claude Code 2.1.283 | Codex 0.157.1 | OpenCode 1.18.32 |
| --- | --- | --- | --- |
| One question, one choice | **VERIFIED** keys | **VERIFIED** keys (Plan mode only) | **VERIFIED** API |
| Several questions in one dialog | **VERIFIED** keys | **VERIFIED** keys | **VERIFIED** API (same call) |
| Async question | — | **UNSUPPORTED**: no picker; printed as a message, answered by typing a prompt | — |
| Permission, allow once | **VERIFIED** keys (`Bash` only; other tools not driven) | out of scope (Auto Review) | **VERIFIED** API |
| Permission, deny | **VERIFIED** keys (`Bash` only), never confirmed | out of scope | **VERIFIED** API, only when it is the session's single pending permission |
| Sandbox network prompt | **UNSUPPORTED**: not driven (sandbox off on this machine); prompt-less, so no buttons | — | — |
| Multi-select | **VERIFIED** keys (Epic 31) | **UNSUPPORTED**: the tool has no multi-select field | **VERIFIED** API (Epic 31) |
| Typed ("Other…") answer | **VERIFIED** keys, single- and multi-select (Epic 31) | **VERIFIED** keys, as "None of the above" plus a note (Epic 31) | **VERIFIED** API, unless the question sets `custom: false` (Epic 31) |
| Back to a previous question | **VERIFIED**: card only, no keys (Epic 31) | **VERIFIED**: card only, no keys (Epic 31) | **VERIFIED**: card only, no API call (Epic 31) |
| Subagent prompts | — | — | **UNSUPPORTED** (version 1) |

## Claude Code 2.1.283

### Hooks

- `AskUserQuestion` fires `PreToolUse` (with `tool_use_id`), then `PermissionRequest` for the same
  tool (no `tool_use_id`), then — only if still unanswered about 6 s later — `Notification` with
  `notification_type: "permission_prompt"` and the message "Claude needs your permission". So a
  *question* reaches BMN through the events that today open a *permission* request; the mapper must
  file both under the question.
- A string matcher works: a `PreToolUse` entry with `"matcher": "AskUserQuestion"` fired for the
  question and not for `Bash`. BMN's `PreToolUse` entry is gated to it.
- A permission prompt (here `Bash`) fires `PreToolUse`, `PermissionRequest` (with `tool_input` and
  `permission_suggestions`), then the same delayed `Notification`. Answered within a second, the
  `Notification` never fires: no late notification was observed, so no guard for one is built.
- Proof of an answer: `PostToolUse` for `AskUserQuestion` carries
  `tool_response.answers = { "<question text>": "<chosen label>" }` for every question. An allowed
  tool fires `PostToolUse` with the same `tool_input` and the `tool_use_id` of its `PreToolUse`.
- A deny fires **no hook at all** (no `PostToolUseFailure`, no `Stop`); the transcript shows
  "Interrupted · What should Claude do instead?" and the prompt waits for the owner. A deny sent from
  Telegram is therefore always *sent, not confirmed*. Esc on a question ("User declined to answer
  questions") also fires no hook.
- The tool accepts 1–4 questions with 2–4 options each (the `AskUserQuestion` schema); the dialog
  adds "Type something." and "Chat about this" after the options.

### Keys

| Shape | Screen | Keys |
| --- | --- | --- |
| One question | `☐ <header>`, the question (wrapped lines at 80 columns start with `│ `), options `N. <label>` each with its description on the next line | the option's digit `N`; it selects and submits at once |
| Several questions | a tab row `←  ☐ H1  ☐ H2  ☐ H3  ✔ Submit  →`; answered tabs turn `☒`; one question shown at a time | the digit for each question in order; each digit answers and moves on. After the last one a **Review your answers** screen lists `● <question>` / `→ <label>` and `1. Submit answers` / `2. Cancel`; press `1` |
| Permission | a tool title (`Bash command`), the command indented under it, `Do you want to proceed?`, options `1. Yes`, `2. Yes, and always allow …`, `3. No` | allow once: the digit of the option labelled exactly `Yes`; deny: the digit of the option labelled exactly `No`. The option list varies by tool, so the digits are read from the screen, never assumed |

### Multi-select, typed answers and Back (Epic 31)

Screens: `.dev-auto/evidence/epic-31/spike-31-4/screens/claude-*` (80 and 200 columns).

- **Multi-select** (`multiSelect: true`): options show as `N. [ ] <label>`, then `N+1. [ ] Type something`,
  a last row that reads `Next` on an earlier question and `Submit` on the last, and `Chat about this`
  below the rule. A digit toggles its option to `[✔]` and does not submit or move the cursor, which
  starts on option 1. BMN leaves the question by pressing **Down** once per option plus once for
  `Type something` (the cursor lands on `❯ Next` or `❯ Submit`) and **Enter**: on to the next
  question, or after the last to **Review your answers**, where `1` submits. (Right also leaves a
  question but is not used, because inside a text field it moves the text cursor.) `PostToolUse` reports the question's answer as one
  string, the chosen labels joined by `, ` **in the order they were toggled** (`"SSO, Rate
  limiting"`; toggling 3 then 1 gave `"Webhooks, Rate limiting"`), so BMN toggles in option order
  and expects that order.
- **Typed answer, single choice:** the digit of `Type something.` puts the cursor in its text field;
  the typed text replaces the label in place (`❯ 3. Passkeys first, JWT as fallback`); **Enter**
  submits a one-question dialog or moves to the next question. `PostToolUse` reports the text as the
  answer. A 2,699-character answer arrived intact; BMN clips at 2,000.
- **Typed answer, multi-select:** a digit only ticks `Type something`; typing needs the cursor on
  that row. From a freshly shown question the cursor is on option 1, so after the toggles BMN presses
  **Down** once per option, types (the row ticks itself and shows the text: `❯ 4. [✔] Passkeys`),
  then **Down** to `Next`/`Submit` and **Enter**. Inside the text field Right moves the text cursor and a
  digit is typed into the answer, so neither is used there. Reported as `"Audit log, Passkeys"`
  (typed text last); on the first of two questions the same keys moved on to question 2 and the
  review listed `Rate limiting, GraphQL`.
- **Back:** **Left** returns to the previous question with its earlier choice marked `✔`; the tab row
  is `←  ☒ H1  ☐ H2  ☐ H3  ✔ Submit  →`. BMN never needs it: a card sends nothing until its last
  answer, so a card's Back only changes the card.

## Codex 0.157.1

- The blocking `request_user_input` exists only in **Plan mode** ("The blocking request_user_input
  tool is unavailable in Default mode"). Its `PreToolUse` carries
  `tool_input.questions[] = { header, id, question, options[{ label, description }] }` and a
  `tool_use_id`; `PostToolUse` carries `tool_response` as a JSON **string**
  `{"answers": {"<id>": {"answers": ["<label>"]}}}` — proof of the exact answer.
- Screen: `Question i/N (k unanswered)`, the question, options `› 1. <label>   <description>` (the
  description sits in a column to the right and wraps within it at 80 columns), then
  `None of the above`. The header is not shown.
- Keys: the option's digit answers the current question; with several questions each digit answers
  and advances, and the digit on the last question submits them all (no review screen).
- `request_user_input_async` renders as an ordinary message with bulleted options and returns
  `{"accepted": true}` at once; there is no picker to answer. No buttons.
- Codex's hooks read `CODEX_HOME`; hooks in a new file need trusting once (`/hooks`).

### Multi-select, typed answers and Back (Epic 31)

Screens: `.dev-auto/evidence/epic-31/spike-31-4/screens/codex-*` (200 columns). Receipt: the spike
thread's rollout, `function_call_output` of `request_user_input`.

- **Multi-select: UNSUPPORTED.** The tool's question has `header`, `id`, `question`, `isOther` and
  `options`, and no multi-select field; Codex cannot ask one.
- **Typed answer:** every question ends with `None of the above  Optionally, add details in notes
  (tab)`, whether or not the call set `isOther`. BMN presses **Down** to that row (one per option
  from option 1), **Tab** to open `› Add notes`, types the text, then **Enter** (`enter to submit
  answer`; on the last question it submits all). `PostToolUse` reports
  `{"answers":{"auth":{"answers":["None of the above","user_note: Passkeys first, JWT as fallback"]}}}`,
  which is the proof.
- **Back:** **Left**/**Right** move between questions and keep earlier choices and notes
  (`←/→ to navigate questions`). As for Claude, a card's Back presses nothing.

## OpenCode 1.18.32

- `question.asked` carries `id` (`que_…`), `sessionID`, `questions[] = { question, header,
  options[{ label, description }] }` and the tool's `callID`. `permission.asked` carries `id`
  (`per_…`), `permission` (for example `bash`), `patterns`, `metadata.command` (the exact command)
  and `always`.
- **Answer by API, not keys.** The plugin receives `serverUrl` (for example
  `http://localhost:4096/`) and a client whose `_client.getConfig().fetch` reaches the running
  server. `POST question/<id>/reply?directory=<dir>` with `{"answers": [["<label>"], …]}` (one
  array per question) and `POST permission/<id>/reply?directory=<dir>` with
  `{"reply": "once" | "reject"}` each returned `200 true`, closed the dialog in the TUI, and emitted
  `question.replied { requestID, answers }` / `permission.replied { requestID, reply }` — proof of
  the exact answer. The installed plugin client is the v1 SDK (no `question` namespace), so the raw
  route is used.
- **A reject cascades.** With two bash permissions pending in one session, rejecting the first
  also rejected the second (`permission.replied … reply: "reject"` for both). Deny is offered only
  when the card's permission is the only one pending in that session.
- The dialog: `△ Permission required`, the command, and `Allow once   Allow always   Reject`;
  questions show numbered options and "Type your own answer". Keys are not needed.

### Multi-select, typed answers and Back (Epic 31)

Screens and events: `.dev-auto/evidence/epic-31/spike-31-4/opencode/`. Disposable
`XDG_*` folders, free model, BMN's variables removed.

- **Multi-select:** `question.asked` carries `multiple: true` on the question (the tool's schema:
  "Allow selecting multiple choices"). The TUI shows `N. [ ] <label>` and `(select all that apply)`.
  `POST question/<id>/reply` with `{"answers": [["SSO", "Rate limiting"], …]}` returned `200 true`,
  emitted `question.replied` with exactly those arrays, and the model received "SSO, Rate limiting".
- **Typed answer:** the schema's `custom` ("Allow typing a custom answer (default: true)") adds
  `Type your own answer`; the event omits it unless the model set it. A label that is not an option,
  `[["Passkeys first, JWT as fallback"]]`, was accepted the same way and reached the model as the
  answer. BMN offers **Other…** only when `custom` is not `false`.
- **Back:** all questions are answered in one call, so a card's Back is card-only.

## How BMN uses this

The answer function lives in the utility process (`apps/desktop/src/utility/remote-answer.ts`) and is
called only by the Telegram tap handler. No control-socket method, owner route or `bmn` command
reaches it (a unit test reads the sources to keep it that way).

- **Routes.** Claude questions of shape `choice` or `multi-select` and Codex questions of shape
  `choice` (at most 8 options each), and Claude `Bash` permissions with an exact command, are answered
  by keys. OpenCode questions and permissions are answered through the plugin. A shape must agree with
  its questions (`multi-select` exactly when one is). Every other shape is refused as `unsupported`, so
  its card never shows buttons.
- **Answer forms (Epic 31).** Per question: an option index; for a multi-select question the set of
  indices, ascending, optionally with a typed answer; or a typed answer alone. A typed answer is sent
  exactly as cleaned (controls and whitespace runs folded to one space, trimmed, at most 2,000
  characters) and only where it is verified: Claude and Codex always, OpenCode unless the question has
  `custom: false`. Claude keys: ticks by digit in option order, each tick seen before the next; Down one
  row at a time to the typed-entry row, the text in pieces of at most 32 characters, each seen whole in the field before the next, Down to
  `Next`/`Submit`, Enter; each move is read back from the screen before the next key. A multi-select
  question must first show with nothing ticked and the cursor on option 1. Codex keys: Down to "None of
  the above", Tab, the text, Enter. Proof: Claude's one string per question (labels joined by `, `,
  typed text last), Codex `["None of the above", "user_note: <text>"]`, OpenCode's label arrays. Claude permissions for other tools (`Edit`, `Write`, …) were not driven
  and are not recognised.
- **Screen mirror.** Each live session keeps its last 64 KB of output. A headless terminal copy
  (`screen-mirror.ts`) starts only once a Claude or Codex hook reports from that session, seeded from
  that tail, and stops on the agent's `SessionEnd` or the session's exit. Measured 2026-09-27: one
  50 MB flood through the session manager cost a median 1,963 ms CPU without a mirror and 2,932 ms
  with one (1.49×), above the 1.10× budget, so plain shells never pay for it.
- **Recognition.** A dialog is on screen only when its option list appears in order at one column,
  followed by the harness's own extra entry (`Type something.` for Claude, `None of the above` for
  Codex), with the question text directly above it. Codex steps must also show `Question i/N`.
  Claude's review must list exactly the answers sent. A permission must show `Bash command`, every
  line of the exact command each ending on a row boundary, nothing else before
  `Do you want to proceed?` but the command's own description (Claude's `tool_input.description`,
  kept in the prompt), and the digits of the
  plain `Yes` and `No` entries read from the screen. Frame and cursor glyphs and whitespace runs are
  normalised; soft-wrapped rows are joined. A typed answer counts as shown only when its field, with the
  rows it wrapped onto, holds all of it, read the same way (frame glyphs and whitespace aside); a start of
  it is not enough. So a lost frame glyph in an answer goes unnoticed; every other character is checked,
  and an answer made only of frame glyphs is refused as `unsupported` before any key.
- **Epoch.** Every open, resolve or withdraw a hook sends for a session raises the epoch of each of
  its followed requests before the store is touched, and so does the recognised dialog leaving the
  screen, checked on every screen change, so even a brief departure counts. Only the request BMN is
  typing into, from its first key to its last, is not counted meanwhile (its own keys move it through
  its steps); every other request in the session is, including during the wait for a report. One
  answer types into a session at a time; a second is refused as `changed`. A card is bound to the epoch at send time. This is what refuses an allow for a prompt whose
  identical successor now shows. To the store the successor is the same request at the same revision.
- **Checks before a key.** The request is claimed before any await, so a second tap loses as
  `claimed`. Then: the process that asked is live (`gone`); revision and epoch match (`changed`); the
  shape has a route and the answer fits it (`unsupported`); permissions are allowed by the
  **Answer permission prompts from Telegram** setting (`permissions-off`); an OpenCode deny is the
  session's only pending permission (`unsupported`); and the dialog is on screen with that choice
  (`not-on-screen`). Each question of a stepped dialog is re-checked just before its own key. A
  failure after the first key stops at once as `partial`.
- **OpenCode.** The answer waits for the session's own plugin to collect it through `answer.take`
  (5 s, else `not-delivered` and nothing was sent). A queued Deny is dropped as `changed` if another
  permission has opened meanwhile, and any queued answer is dropped as `changed` if the epoch rose
  before pickup. The plugin posts it to its own server, rechecks that a reject answers only that one
  permission, and reports the server's response: accepted is `confirmed`; a refused request (4xx) is
  `api-refused` — nothing was applied, so the request is free for another tap (never resent by BMN),
  even when it arrives after the answer was reported `sent-unconfirmed`. A server error or a lost
  connection stays uncertain.
- **Outcomes.** `confirmed` only when the harness reports exactly that answer within 10 s: the
  question tool's answers, the permitted tool with the same input, or OpenCode's replied event for
  that request id, or the plugin's accepted report for it. A report counts only for the prompt's own
  process, and after the request has closed (by a hook, expiry or the owner) only when it names the
  prompt's own id, so an identical
  successor's report never confirms an earlier answer. The request then closes as answered by `telegram`. Otherwise the answer is
  `sent-unconfirmed`: never retried, and still upgraded to `confirmed` if the report comes within ten
  minutes. A Claude deny is always `sent-unconfirmed`, and BMN closes its request itself with
  "Deny sent from Telegram, not confirmed", because no hook will.
