# Remote answers: how each agent is answered

BMN can answer an agent's question or permission prompt from Telegram (Epic 30). This page records,
per agent version and prompt shape, exactly how that answer is delivered, how BMN recognises the
dialog on screen, and what proves the answer landed. Code follows this table: a shape that is not
**VERIFIED** here gets a card without buttons.

Measured 2026-09-27 against Claude Code 2.1.283, codex-cli 0.157.1 and OpenCode 1.18.32, each driven
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
| Permission, allow once | **VERIFIED** keys | out of scope (Auto Review) | **VERIFIED** API |
| Permission, deny | **VERIFIED** keys, never confirmed | out of scope | **VERIFIED** API, only when it is the session's single pending permission |
| Sandbox network prompt | **UNSUPPORTED**: not driven (sandbox off on this machine); prompt-less, so no buttons | — | — |
| Multi-select | **UNSUPPORTED** (version 1) | **UNSUPPORTED** | **UNSUPPORTED** |
| Typed ("Other") answer | **UNSUPPORTED** (version 1) | **UNSUPPORTED** | **UNSUPPORTED** |
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

## How BMN uses this

- Keys go only into the dialog the card was sent for, after BMN's screen mirror shows it (question
  and chosen label, or the tool title and command), and only while the request is open at the same
  revision and dialog epoch. See Epic 30, decisions 3–5.
- OpenCode answers travel to the session's own plugin through the control socket's read-and-consume
  `answer.take`; the plugin posts the reply to its own server.
- `confirmed` requires the proofs above; everything else is *sent, not confirmed*.
