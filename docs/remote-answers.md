<!-- MODULE: remote-answers.md - agent question and permission delivery -->
# Remote answers: how each agent is answered

BMN can answer an agent's question or permission prompt from Telegram (Epic 30). This page records,
per agent version and prompt shape, exactly how that answer is delivered, how BMN recognises the
dialog on screen, and what proves the answer landed. Native dialog routes follow this table. Codex
Default has a separate ordinary-message route approved by the owner on 2026-09-30; its receipt never
claims native question consumption.

Measured 2026-09-27 (Epic 30; multi-select, typed answers and Back in Epic 31, same night, same versions) against Claude Code 2.1.283, codex-cli 0.157.1 and OpenCode 1.18.32, each driven
in a real terminal (tmux, 200×50 and 80×40) with BMN's control variables removed. OpenCode was retired
on 2026-11-20 (Epic 123); its column and sections (1.18.32 and 2.0.28) are kept at the git tag
`opencode-support-final`. Raw captures and a
SHA-256 manifest are under `.dev-auto/evidence/remote-answers/` (not committed). Sanitised hook
payloads and screen text are the test fixtures in
`apps/desktop/src/utility/test-fixtures/remote-answers/`.

## Shape matrix

| Shape | Claude Code 2.1.283 | Codex 0.157.1 |
| --- | --- | --- |
| One question, one choice | **VERIFIED** keys | **VERIFIED** keys (Plan mode only) |
| Several questions in one dialog | **VERIFIED** keys | **VERIFIED** keys |
| Default async question | — | Choices/Other submit ordinary session messages; native consumption remains **UNVERIFIED** |
| Permission, allow once | **VERIFIED** hook on 2.1.302 (`Bash`; Epic 78), keys as fallback (`Bash` only) | out of scope (Auto Review) |
| Permission, deny | **VERIFIED** hook on 2.1.302 (`Bash`; Epic 78), keys as fallback; never confirmed | out of scope |
| Sandbox network prompt | **UNSUPPORTED**: not driven (sandbox off on this machine); prompt-less, so no buttons | — |
| Multi-select | **VERIFIED** keys (Epic 31) | **UNSUPPORTED**: the tool has no multi-select field |
| Typed ("Other…") answer | **VERIFIED** keys, single- and multi-select (Epic 31) | **VERIFIED** keys, as "None of the above" plus a note (Epic 31) |
| Back to a previous question | **VERIFIED**: card only, no keys (Epic 31) | **VERIFIED**: card only, no keys (Epic 31) |

## Claude Code 2.1.283

### Hooks

- `AskUserQuestion` fires `PreToolUse` (with `tool_use_id`), then `PermissionRequest` for the same
  tool (no `tool_use_id`), then — only if still unanswered about 6 s later — `Notification` with
  `notification_type: "permission_prompt"` and the message "Claude needs your permission". So a
  *question* reaches BMN through the events that today open a *permission* request; the mapper must
  file both under the question.
- A string matcher works: a `PreToolUse` entry with `"matcher": "AskUserQuestion"` fired for the
  question and not for `Bash`. Since Story 83.4 BMN's `PreToolUse` entry is gated to
  `AskUserQuestion|Bash` instead: on 2.1.302 that matcher fired for both tools, and the Bash half
  serves only the command guard (docs/agent-control.md, "The command guard").
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

## Claude Code 2.1.302: permissions answered by the hook (Epic 78)

Measured 2026-10-17 (Story 78.1) on Claude Code 2.1.302 in an isolated profile, 115 recorded runs: a
`PermissionRequest` command hook that waits for an outside answer, driven in tmux, the screen sampled every
~150 ms. Records and the per-case table: `plan/references/reference-78-phone-permissions/measure/`
(`RESULT.md`), kept with the plan, not committed.

- **The dialog is not delayed or hidden.** It appears within −21…+166 ms of the hook starting and stays drawn and
  answerable through waits of 3–20 s, for Bash (default and auto mode, including "This shell -c script runs rm and
  could not be checked"), Write and Edit.
- **The desk wins.** Yes, No or Esc at the desk decides the prompt (15/15); a hook answer after that, after the
  hook's timeout, after the hook was killed or after a countdown expiry changes nothing (15/15, 5/5, 5/5, 2/2). No
  and Esc end the hook (SIGTERM); Yes and an expiry do not signal it, so BMN ends the wait itself when the request
  closes (`PostToolUse` resolves it) or at its own bound.
- **Sessions stay independent** (5/5). A hook that fails, exits 1 or 2, decides nothing or is killed leaves the
  dialog as it was (25/25). An 8,685-character command reached the hook whole.
- **Precedence.** A matching deny rule never reaches the hook (3/3). Of two hooks that decide, the first decision
  written wins (10/10), so a second deciding `PermissionRequest` hook can preempt BMN either way.
- **The countdown** (auto mode, critical-path removals and unchecked scripts) is 120.05–120.20 s, keeps running
  while the hook waits, and stops on one key press; after three expiries the next removal is denied with no
  `PermissionRequest` at all. A hook allow does approve a critical-path removal (3/3). BMN keeps the countdown on
  and never presses a key to extend it (owner, 2026-10-17).
- The hook input carries `session_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input` and
  `permission_suggestions`, and no `tool_use_id`.

**The route (owner card 2026-10-17: the hook only if proven; proven above).** For a Bash permission in the typed
agent's main conversation whose input holds only `command`, `description`, `timeout` and `run_in_background`, and
whose command is at most 100,000 characters (Story 78.4) and needs no cleaning to be shown (no carriage return, control
character or surrounding blank), `bmn hook claude` gives the request a random single-use ref and then asks BMN for
the answer (`answer.take` with that ref, 25 s at a time, up to 590 s; the entry's timeout is 600 s). It prints
exactly `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` for Allow once
and `behavior: "deny"` with a short message for Deny; never `updatedInput`, `updatedPermissions`, a mode or a rule.
It stops with no decision as soon as BMN says the request is over (closed, replaced by another prompt in the slot,
another process, or Claude's own countdown ran out), Telegram is off or permission answers are off, or BMN cannot be
reached; from then on BMN counts it as gone at once. A Bash card's buttons then use the keys route below, as before.

- **Only deciding hook.** The hook gives no ref when it sees another `PermissionRequest` hook that could decide the
  request (the first decision wins): in the managed, user, project or local settings, in the `--settings` file or JSON
  Claude was started with (read from its process's command line), or in a plugin a settings file enables, whose
  matcher could match the tool. An entry, or a `--settings` file, it cannot read counts as another hook, and so does a
  launch line it cannot read (then no hook can be ruled out).
- **No ref, no buttons.** Every other input (another field such as `dangerouslyDisableSandbox`, a command that needs
  cleaning or is too long, a subagent, another tool) and every request with another deciding hook gets no ref, and a
  Claude permission without a ref gets no buttons: some approval-relevant part would not be on the card.
- **Claude's countdown.** Claude fires no hook event when its countdown denies a request; its next step does (measured
  on 2.1.302, 2/2: `Stop` 2.4 s and 3.3 s after the dialog went). BMN closes the request on that step as on any other
  (`Stop`, `UserPromptSubmit`, the next tool's `PostToolUse`, or a new `PermissionRequest` in the slot), which ends the
  hook's wait and the card's buttons. A tap in between reaches a hook whose allow Claude ignores after expiry (78.1,
  2/2), so the card says it was sent, unconfirmed (the owner's choice, 2026-10-17: a card stays while the question
  waits for him and closes when the agent goes on). The deadline the card shows (Story 78.5) is read off Claude's
  countdown and only informs: BMN follows the screen for every open Claude permission, buttons or not, draws the card
  again when a countdown appears after it was sent, and says there is none once a key at the desk takes the countdown
  away while the dialog stays. A prompt that replaced another in the slot takes only a countdown that ends later than
  the earlier one's (each starts afresh at two minutes), so the earlier dialog's countdown still drawn is never its
  deadline; until then it is "unknown". A prompt that replaces another also never inherits
  its pending answer: an identical successor's report never confirms the earlier tap. If an expired request is
  followed by a long tool that needs no permission, its card stays until that tool ends.

**Tool families with buttons:** `Bash`; `Write` and `Edit` through the hook only (Story 78.3), when their input
holds only `file_path` and `content`, or `file_path`, `old_string`, `new_string` and `replace_all`. The card shows the
whole change as one text, each part after its length in characters so no content can pass for another part:
`Write <path>, the whole file (N characters):` then the content and `(end of file)`; `Edit <path>, replacing one
occurrence|every occurrence of (N characters):` then the old text, `with (M characters):` then the new and
`(end of change)`. The end mark keeps a closing line break or spaces exact (Claude's Write content usually ends in
one; measured live on 2.1.302). A change longer than the card goes as a file (Story 78.4). Not measured, so no buttons: MCP tools, `WebFetch`, `NotebookEdit` and every other tool.

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
  `{"accepted": true}` at once; there is no picker to answer. Its buttons submit ordinary messages, never picker digits.
- Codex's hooks read `CODEX_HOME`; hooks in a new file need trusting once (`/hooks`).

Epic 46 retains async call identity and declared options, including omitted options, and explains
its ordinary-message Telegram route. Desktop question cards let you select options or enter Other,
then **Copy answer** for manual submission. Copying clears the reminder and writes only to the
clipboard; paste into the session yourself. Opening or dismissing a card also clears its reminder,
without sending an answer or granting permission.
`accepted:true` acknowledges presentation, not an answer. Generic
`UserPromptSubmit` closes attention under the existing hook rule but does not confirm a Telegram
answer or prove question consumption. The owner approved submitting Telegram choices/Other and card
replies as ordinary messages on 2026-09-30. Submission uses the card's session/incarnation, request
revision/epoch guards and a durable staged receipt; uncertain writes never replay. Pending native
questions or permissions block ordinary message input. Native correlated consumption and exclusive
composer ownership remain unverified; no receipt calls an ordinary message a native answer.

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

## How BMN uses this

The answer function lives in the utility process (`apps/desktop/src/utility/remote-answer.ts`) and is
called only by the Telegram tap handler. No control-socket method, owner route or `bmn` command
reaches it (a unit test reads the sources to keep it that way).

- **Routes.** Claude questions of shape `choice` or `multi-select` and Codex questions of shape
  `choice` (at most 8 options each), and Claude `Bash` permissions with an exact command, are answered
  by keys; a Claude `Bash` permission whose own hook is waiting (its prompt carries the hook's request
  ref, Epic 78) is answered through that hook instead, which collects the answer by its ref alone. A shape must agree with
  its questions (`multi-select` exactly when one is). Every other shape is refused as `unsupported`, so
  its card never shows buttons.
- **Answer forms (Epic 31).** Per question: an option index; for a multi-select question the set of
  indices, ascending, optionally with a typed answer; or a typed answer alone. A typed answer is sent
  exactly as cleaned (controls and whitespace runs folded to one space, trimmed, at most 2,000
  characters) and only where it is verified: Claude and Codex always. Claude keys: ticks by digit in option order, each tick seen before the next; Down one
  row at a time to the typed-entry row, the text in pieces of at most 32 characters, each seen whole in the field before the next, Down to
  `Next`/`Submit`, Enter; each move is read back from the screen before the next key. A multi-select
  question must first show with nothing ticked and the cursor on option 1. Codex keys: Down to "None of
  the above", Tab, the text, Enter. Proof: Claude's one string per question (labels joined by `, `,
  typed text last), Codex `["None of the above", "user_note: <text>"]`. Claude `Write` and `Edit` permissions are answered only through their waiting hook; they have no
  key route. Other tools' permissions are not recognised.
- **Screen mirror.** Each live session keeps its last 64 KB of output. A headless terminal copy
  (`screen-mirror.ts`) starts once a Claude or Codex hook reports from that session, seeded
  from that tail, or earlier, when the app reports its own state on screen (`OSC 7501;…:app=codex`): Codex does that at start, before its first hook, and its
  start-up animation can pass 64 KB, which would leave a later mirror without the prompt it drew once
  (Story 90.6). It stops on the agent's `SessionEnd` or the session's exit.
  The Away wake reads its rows and its cursor, and only from a mirror already running: a sweep under way
  when the agent left never starts one for the shell (Story 93.3). Measured 2026-09-27: one
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
  **Answer permission prompts from Telegram** setting (`permissions-off`); and the dialog is on screen with that choice
  (`not-on-screen`). Each question of a stepped dialog is re-checked just before its own key. A
  failure after the first key stops at once as `partial`.
- **Outcomes.** `confirmed` only when the harness reports exactly that answer within 10 s: the
  question tool's answers or the permitted tool with the same input. A report counts only for the prompt's own
  process, and after the request has closed (by a hook, expiry or the owner) only when it names the
  prompt's own id, so an identical
  successor's report never confirms an earlier answer. The request then closes as answered by `telegram`. Otherwise the answer is
  `sent-unconfirmed`: never retried, and still upgraded to `confirmed` if the report comes within ten
  minutes. A Claude deny is always `sent-unconfirmed`, and BMN closes its request itself with
  "Deny sent from Telegram, not confirmed", because no hook will.


## Explicit manual checkpoints (Epics 50–52)

`bmn ask --choices-json '{"options":[{"label":"Proceed","description":null},{"label":"Wait","description":null}]}'`
(or `--choices-file -`) stores separate manual choices, never a native prompt.
Other is automatic. Laptop and phone options/Other send one bounded, addressed ordinary message naming the request and
decision to its freshly attributed foreground conversation, an agent launched in a shell included;
manual permission decisions additionally require `answerPermissions` (**Answer permissions**) and convey the
owner's decision as text: native Allow, Auto Review and command execution remain separate. Direct text
replies follow `autoSubmitReplies`, including ordinary follow-ups to completed cards
without renewing a permission grant. Every manual write, including a follow-up,
requires fresh current-incarnation Claude/Codex ownership; an unstamped shell target
stays unavailable/draft-only. No submitted or uncertain attempt is replayed. Telegram permission settings apply
to phone answers.

The native Codex Default missing-ID compatibility route retains its prior guards
and “Conversation not confirmed” label only before a switch/conflict or ambiguous
lifecycle event. Reused identities fail closed for uncorrelated destruction.
This does not enable unknown manual routes. Live producer metadata is
excluded from agent control responses and copied backups.

Source and isolated connector/real-PTY tests are separate evidence from configured
CLI-producer continuation, installed-release and live-phone acceptance. The latter
remain pending in this run; the original withdrawal incident cause is UNCONFIRMED.

See [investigation notes](telegram-investigations.md) for the remaining phone/native
checks, demonstrated regressions and harness pitfalls to retain when investigating
another refusal.
