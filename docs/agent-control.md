# Agent control: `bmn`

Every session BMN starts can talk back to the app through the `bmn` command. An agent,
a script or you can use it to publish files, report progress, ask for attention and send text to a
session.

`bmn` is a small Node.js client (`apps/desktop/bin/bmn`). Each call opens one connection to
the app's control socket, sends its JSON-RPC requests and exits. Packaged builds run it on BMN's own
runtime from `resources/bin`, so sessions need no Node.js install; BMN puts that folder on `PATH`.

## How a session finds the app

BMN sets these variables in every session it starts:

| Variable | Meaning |
| --- | --- |
| `BMN_CONTROL_SOCKET` | Path of the control socket |
| `BMN_TOKEN` | A credential that only works for this session and this run of its process |
| `BMN_SESSION_ID` | The session's ID |

The socket lives in `$XDG_RUNTIME_DIR/bmn/control/`, a folder only your user can open.
There is no network listener.

Session tokens are HMAC-signed for one session and one process incarnation. Starting the session
again issues a new token; the old one stops working. The owner token, `owner.token` next to the
socket, can address any session and requires `--session`.

## Commands

This is exactly what `bmn help` prints; a unit test keeps the two identical.

<!-- BEGIN `bmn help` (generated: pnpm run docs:bmn-help) -->
```text
Usage: bmn <command> [arguments] [options]

Commands:
  snapshot                                  Show the current state snapshot
  list                                      List sessions
  publish <file> [--name N] [--key K]       Publish a file as an artifact
  handoff <destination-id> --text T | --text-file - [--file-id ID ...] --key K
  handoff status [draft-id]                 Prepare an owner-delivered handoff; read its bounded receipt
  handoff --outline                         Print the optional outline of a complete handoff; sends nothing
  progress <state> <label> [--source S] [--detail D | --detail-file -] [--observed ISO]
                            [--evidence-id ID ...]
                                            Report progress; state is one of
                                            running|waiting|blocked|claimed-done|verified|failed|unknown.
                                            --evidence-id points at up to 10 files this session
                                            already published (publish with --key, keep the
                                            returned id, then report). BMN stores and shows the
                                            link; it never checks the files or the claim, so
                                            attached evidence certifies nothing.
  ask <request-key> <title> [--kind K] [--body B | --body-file -] [--expires ISO]
      [--choices-json JSON | --choices-file -]  Explicit 2–8 options; BMN adds Other.
                                            Ask for attention; kind is one of
                                            question|permission|review|notice (default question)
  withdraw <request-key>                    Withdraw an attention request
  resolve <request-key> <resolution>        Resolve an attention request
  send <text> | --text-file - [--submit] [--key K]
                                            Paste text into the session; --submit also presses Enter
  resume-command -- <command> [args...] [--key K]
  resume-command --clear [--key K]          Tell BMN the exact command that resumes the program running in
                                            this session: a plain name on PATH, then its arguments, at most 64
                                            parts. Resume offers it only when BMN has no conversation of its
                                            own, and runs it only after the owner reads it. Outside BMN it
                                            records nothing and exits 0
  answer take [--wait S] [--reported R=ok|failed]
                                            Collect, once, the answers BMN decided from a Telegram tap for
                                            this session's own OpenCode requests (used by BMN's plugin);
                                            waits up to S seconds (0-25) for one to arrive.
                                            --reported says whether OpenCode accepted the reply to request R
  hook <agent>                              Turn an agent hook event on stdin into Needs you requests;
                                            agent is one of claude|codex|opencode|cursor; prints nothing, always exits 0
  hooks print opencode                     Print the shipped OpenCode TypeScript plugin
  hooks check [agent] [--file PATH]         Say which of BMN's hook entries each agent's own hook file
                                            carries: wired, wired (older wording) or missing
  hooks install <agent> [--file PATH]       Review and approve each hook-file change before installation;
                                            use --yes for a non-interactive script
  statusline check|install|uninstall [--file PATH]
                                            Put one line in front of Claude Code's own status-line command so
                                            its plan use reaches BMN; the command itself is kept unchanged
  team [--all] [--json]                     The owner-approved team: one line per enabled active agent
  roster validate|status|role|route|visibility|check|explain|bind
                                            The team file in ~/.config/bmn/agents: validate it, list pending
                                            differences, print a role's chain, and check a dispatch
                                            before work leaves for another agent (bmn roster --help)
  rules render|check|install|restore|history|revert-master|import|probe
                                            One rules master written into each agent's own rules file
                                            (bmn rules --help)
  help [agents|terminal]                    Show this help or a short agent/terminal guide

Long text from standard input (instead of one quoted argument; only - is accepted, pipe a file with cat):
  ask ... --body-file -         progress ... --detail-file -
  send --text-file -            handoff <destination-id> --text-file - --key K
  Exactly one source per field; a terminal is refused, input must be piped. One trailing newline is
  dropped. Limits: body 8000 and detail 2000 characters, send text 64 KiB and handoff text 16 KiB.
Options:
  --session ID       Target session (defaults to your own; required with owner credentials)
  --json             Print the raw result as JSON
  --owner            Use owner.token next to the control socket instead of BMN_TOKEN
  --token-file PATH  Read the token from PATH instead of BMN_TOKEN
  --socket PATH      Control socket path (default: BMN_CONTROL_SOCKET)
  --                 Treat every following argument as text

Environment: BMN_CONTROL_SOCKET, BMN_TOKEN
Exit status: 0 success, 1 remote or connection error, 2 usage error
             hooks uses 1 for "something is missing or unreadable"; it needs no socket and no token
             team, roster and rules need no socket either; their own codes are listed in their --help
```
<!-- END `bmn help` -->

### Long text from standard input

Long or multi-line text breaks inside one shell-quoted argument: quotes, backticks and `$( )` in it
get read by the shell. Four options read their field from standard input instead, so an agent can
pipe it or use a quoted heredoc:

```bash
bmn ask review-plan "Review the migration plan?" --body-file - <<'EOF'
Plan: copy `users` in batches of 500, then swap the table.
Risk: the "legacy" column keeps $(old) values.
EOF
cat notes.md | bmn handoff <destination-session-id> --text-file - --key result-2
```

| Option | Field | Limit |
| --- | --- | --- |
| `ask … --body-file -` | request body | 8,000 characters |
| `progress … --detail-file -` | progress detail | 2,000 characters |
| `send --text-file -` | pasted text | 64 KiB |
| `handoff … --text-file -` | handoff text | 16 KiB |

Only `-` is accepted; to send a file, `cat` it into `bmn`. A field takes exactly one source, so
`--body` with `--body-file`, `--text` or `-- text` with `--text-file`, and `send` text with
`--text-file` are refused. Standard input that is a terminal is refused ("needs piped input")
instead of waiting for typing. Text over the limit, counted the way the app counts that field, or
that is not valid UTF-8 is refused before anything is sent. One trailing newline, which a heredoc
always adds, is dropped; every other byte is kept.

## Examples

Publish a screenshot an agent produced:

```bash
bmn publish ./out/screenshot.png --name "Login page after the fix"
```

Report progress from a long script:

```bash
bmn progress running "Migrating 1,200 records" --source migrate.sh
# ...
bmn progress claimed-done "Migration finished" --detail "1,200 of 1,200 rows"
```

Point a report at files you already published. Publish first with `--key`, keep the artifact ID it
returns, then name it; a repeated publish with the same key returns the same ID, so the reference
stays valid:

```bash
id=$(bmn publish ./out/checks.log --key migrate-checks --json | sed -n 's/.*"artifactId": "\([^"]*\)".*/\1/p')
bmn progress claimed-done "Migration finished" --evidence-id "$id"
```

Up to ten distinct IDs, on any state. Each must be a file **this** session published: a file the
owner or Telegram handed to the session is not evidence that the session did the work. Leaving
`--evidence-id` out means this report has no evidence, not that it keeps the last one's files.

BMN stores the reference and its filename, shows them beside the report, and lets the owner open
them. **It does not read the files, run anything, or judge the claim.** Evidence being present,
and its stored bytes passing their integrity check, says nothing about whether the work succeeded
or whether those files are the relevant ones. A file that is later deleted stays visible as a named,
unavailable reference rather than quietly disappearing from the report.

Ask the owner a question and clear it later:

```bash
bmn ask deploy-approval "Deploy build 142 to staging?" --kind permission
# after the answer arrives, or if it is no longer needed:
bmn withdraw deploy-approval
```

Send a command to another session as the owner:

```bash
bmn send --owner --session <session-id> --submit -- "git status"
```

`--key` makes a publish, send or handoff idempotent: repeating the same call with the same key does
not repeat the effect. A handoff requires the key.

## Handoffs

An agent can prepare a handoff only for a destination session ID the owner gave it:

```bash
bmn handoff <destination-session-id> --text "Result and next step" --file-id <published-output-id> --key result-1
bmn handoff status
```

The agent's token still lists only its own session. BMN checks that every attached file is a ready
output published by that source session, then opens a **Handoff** request in the source session's
**Needs you** queue. The owner opens the existing Files editor, checks or edits the text and files,
and pastes it once into the destination without pressing Enter. The agent cannot deliver it.
The editor says who prepared it; the pasted stamp says the agent prepared it and the owner delivered
it. A received handoff conveys context, not authority.

A useful handoff lets the receiver start without asking. `bmn handoff --outline` prints an optional
outline to fill in and pipe back with `--text-file -`; it sends nothing. **Insert outline** in the
owner's handoff form fills the same text while the text box is empty. Nothing checks the sections: a
free-form handoff saves as before.

```text
Goal:

Where it stands:

Done and checked (with published evidence ids):

Left to do:

Risks and open questions:

How to check:
```

```bash
bmn handoff --outline > outline.md   # fill it in
bmn handoff <destination-session-id> --text-file - --key result-3 < outline.md
```

`bmn handoff status [draft-id]` exposes only that source agent's draft ID, destination ID, state and
update time. The states read *prepared*, *pasted (not submitted)*, *pasted, outcome uncertain* or
*discarded*. It does not expose owner edits, added files or destination activity. The source can
withdraw an untouched pending draft with `bmn withdraw handoff:<draft-id>`; after the owner edits
it, the request withdraws but the owner's draft remains for the owner to discard. A restarted source
marks an open petition as prepared by an earlier process. Expiry discards a pending draft; after an
interrupted paste, the request expires but the draft keeps its uncertain outcome. A Telegram
reply to the page is always saved as a draft for the source session, even with automatic reply
submission enabled; it cannot deliver the handoff.

## Agent hooks: Needs you for Claude Code, Codex and OpenCode

`bmn hook claude`, `bmn hook codex`, `bmn hook opencode` and `bmn hook cursor` read one hook event as JSON on stdin
and keep **Needs you** in step with the agent ([Cursor](#cursors-terminal-agent) gets its turn notice and chat id only). They print nothing and always exit 0, so a hook can never disturb the
agent, and they do nothing outside BMN.

| Event | Effect |
| --- | --- |
| Claude `PreToolUse` for `AskUserQuestion`, or its `PermissionRequest` for that tool | Opens a `question` request carrying the questions, options and descriptions ([remote-answers.md](remote-answers.md)); both events describe one dialog and merge into one request |
| Claude `PermissionRequest` for any other tool | Opens a `permission` request carrying the tool, the exact command or path, and the working directory |
| Claude `Notification` (permission prompt) | Opens a `permission` request, unless a question or permission of that session already carries its dialog: Claude sends this notice about 6 s into any unanswered prompt, questions included |
| Claude `Notification` (question dialog) | Opens a `question` request |
| Codex `PreToolUse` for `request_user_input` or `request_user_input_async` | Opens a `question` request with the question text and choices (blocking and async are different shapes) |
| OpenCode `permission.asked`, `permission.replied` | Opens, answers or withdraws a `permission` request, carrying the request id and the exact command from the event's `metadata`; subagents and other sessions in the same process share their own `subagent-permission` request. `permission.replied` carries evidence naming its request id and reply, and closes only the request holding that id: OpenCode keeps one slot for several pending permissions |
| OpenCode `question.asked`, `question.replied`, `question.rejected` | Opens, answers or withdraws a `question` request; subagents and other sessions in the same process share their own `subagent-question` request. `question.replied` carries evidence with its request id and answers |
| OpenCode main `session.status` busy, `session.idle`, `session.error` | Clears main prompts, or opens a finished-turn or error notice. Main idle also withdraws subagent requests; main busy leaves them open. Subagent status, idle and errors are not reported |
| OpenCode main `session.created`, `tui.session.select`, `session.deleted` | Captures the conversation or clears the plugin's requests, including subagent requests on select/delete. These events from subagents are ignored |
| `PostToolUse`, Claude `PostToolUseFailure`, `UserPromptSubmit` | Clears the turn notice. Claude resolves open prompts after a tool completes or fails. Codex resolves permission after any tool and resolves a question only after synchronous `request_user_input` or `UserPromptSubmit`; an async question stays open while later tools run. A `PostToolUse` resolve carries **evidence**: the chosen answers of the question tool in question order, or the tool and exact input that ran (see below) |
| `Stop` | Withdraws open prompts and opens a `notice` that the turn finished, with the last message. Codex keeps a queued async question open until the owner submits input. When Claude still has background tasks or a scheduled wake-up, it opens nothing: the agent resumes without you |
| `SessionEnd` | Retires requests attributable to that producer; ambiguous events leave them unavailable |
| `SessionStart` with `startup`, `resume`, `clear` or `fork` | Reports current ownership; invalidates older controls without racing a new question. Separately reports the durable conversation for Resume |
| Codex `Interrupt` | Withdraws open prompts |

On Linux, live conversation ownership also checks the terminal's foreground
process identity immediately before an addressed answer. Returning to a shell or
changing that identity makes an existing card unavailable even if no shutdown hook
arrives. This identifies the foreground job: an unchanged multiplexer or replacement
using the same executable may not reveal a change inside it. These identities stay in host memory; control-socket snapshots,
including owner snapshots, omit producer bindings. Repeat-watch notices belong to
BMN and their cleanup does not retire the agent's conversation.

### Cursor's terminal agent

Measured on `cursor-agent` 2026.09.26-dd393fe (installed from `https://cursor.com/install`, owner account) on
2026-09-27/28, in a scratch project under tmux with `BMN_*`/`AITERM_*` unset, then with fake `BMN_*` values set to
see what reaches a hook. Payloads are sanitised in
[`apps/desktop/src/utility/test-fixtures/cursor/`](../apps/desktop/src/utility/test-fixtures/cursor/); the log is
`.dev-auto/log.md` (2026-09-28 ~00:50–01:40).

Then checked inside BMN (2026-09-28, candidate build, BMN's own folders in a scratch root, hooks from
`bmn hooks install cursor --file <project>/.cursor/hooks.json`). `cursor-agent` typed into a bash session:
Cursor's workspace-trust prompt first, then each turn end opened "Cursor finished its turn" (`hook:cursor:stop`),
the next prompt answered it, a real `ls` gave `postToolUse`, the chip read Cursor, and the binding stayed
unsupported, as for every agent typed into a shell. A question came as plain text (see Question dialog below). Cursor's `Run this command?` prompt for `rm` showed on screen
with no hook event and nothing in Needs you. `cursor-agent` launched directly bound its chat at `sessionStart`;
after Stop, Resume ran `cursor-agent --resume=<id>`, the chat's earlier turn was on screen, and the next prompt
fired `beforeSubmitPrompt` and `stop` (no `sessionStart`), opening a fresh notice under the same chat id.

| Question | Result |
| --- | --- |
| Hook support | **VERIFIED.** `hooks.json` version 1, `{ "version": 1, "hooks": { "<event>": [{ "command": "…", "timeout": 5 }] } }`, one flat entry per command (no matcher groups). The terminal agent reads the user file `~/.cursor/hooks.json` (a one-entry `stop` capture fired) and a project `.cursor/hooks.json` (every event below fired), not only the editor. Commands run under `bash`, with the session's environment (`BMN_CONTROL_SOCKET`, `BMN_TOKEN` and `BMN_SESSION_ID` reached every hook). Cursor also lists Claude Code's settings files as "third-party" hook sources; a project `.claude/settings.json` hook did **not** fire by default. |
| Events seen | `sessionStart` (a new chat only, not on `--resume`), `beforeSubmitPrompt`, `preToolUse`/`postToolUse` (`tool_name` `Shell`), `beforeShellExecution` (every command, before any approval prompt), `afterShellExecution`, `afterAgentThought`, `afterAgentResponse` (the reply text), `stop` (`status` `completed`; `error` and `aborted` appear in its code, unmeasured), `sessionEnd` (`reason`, `final_status`). |
| Payload fields | Every event: `conversation_id` (equal to `session_id`, a UUID), `generation_id`, `hook_event_name`, `model` (`default` under Auto), `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (`~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, null on the first events). `stop` adds `status`, `loop_count` and token counts. |
| Conversation id | **VERIFIED.** `conversation_id` of `sessionStart` and of every `beforeSubmitPrompt` (a resumed chat reports the same id). |
| Resume command | **VERIFIED.** Exit prints `To resume this session: agent --resume=<id>`; `cursor-agent --resume=<id>` reopened the chat (and its Plan mode) with the same `conversation_id`. |
| Local session store and delete | Store **VERIFIED**: `~/.cursor/chats/<md5 of the workspace path>/<id>/` (`store.db`, `meta.json`, `prompt_history.json`). Delete **UNSUPPORTED**: the CLI has no chat delete command (its `delete` subcommands are for automations and environments), so History reads "keeps its own history · not managed by BMN" and BMN removes nothing. |
| Terminal notices (OSC 9/777/99) | **UNSUPPORTED** in BMN: Cursor emits them only for terminals it detects by `TERM_PROGRAM` (Apple Terminal, Ghostty, iTerm2, kitty, …); only OSC 0 titles were seen. |
| Model and host | `model` is `default` under Auto, or the chosen model's name; no base-URL variable or host. BMN logs the model for the flag and adds no Cursor host to the classifier; `default` shows no flag. |
| Question dialog | **UNSUPPORTED.** The question tool was not offered to the model in the default mode, Plan mode or a fresh `--plan` session, so no Epic 30 answer shape applies. Inside BMN, asked for a multiple-choice question, Cursor searched its tools for one, found none and asked in plain text; the only hook event was `stop`, so Needs you showed the ordinary "Cursor finished its turn" ([`question-in-bmn.txt`](../apps/desktop/src/utility/test-fixtures/cursor/question-in-bmn.txt)). |
| Permission prompt | Seen (`Run this command? … Run (once) (y) / Add Shell(touch) to allowlist? (tab) / Run Everything (shift+tab) / Skip (esc or n)`), but **no event marks it**: `beforeShellExecution` fires for every command before BMN could know a prompt is shown. No Needs you request and no buttons. |
| Nested agents | A hook's parent is `bash` and then Cursor's node process (`MainThread`), which holds the terminal's foreground group, so BMN's nested-agent rule applies unchanged: a `cursor-agent` run from a tool call reports nothing. |

What `bmn hook cursor` does:

| Event | Effect |
| --- | --- |
| `sessionStart` | Withdraws the turn notice and reports the chat (`startup`) |
| `beforeSubmitPrompt` | Withdraws the turn notice and reports the chat (`prompt`); the same chat again changes nothing, another replaces the binding |
| `postToolUse` | Withdraws the turn notice (a stop hook may send the agent back to work) |
| `stop` | Opens a `notice`: "Cursor finished its turn", or "Cursor stopped with an error"; `aborted` (Escape) withdraws instead |
| `sessionEnd` | Withdraws the turn notice |

Resume works for a session BMN started as `cursor-agent` (the bare `agent` alias is too generic to claim), as for the
other agents: `cursor-agent --resume=<id>` keeps `--model` and `--workspace` and names what it leaves behind, never
an option's value (`--api-key` holds a secret). A `bmn hook claude` payload carrying `cursor_version` is Cursor
running Claude's hook files and is ignored. No screen mirror runs for Cursor: nothing is answered by keys.

### Notifications from any program

A harness with no BMN hook still speaks the terminal's own notification language, and BMN reads it.
A program that writes **OSC 9** (`ESC ] 9 ; text BEL`, iTerm2), **OSC 777**
(`ESC ] 777 ; notify ; title ; body BEL`, urxvt) or **OSC 99** (`ESC ] 99 ; metadata ; text BEL`,
kitty) into its session opens one `notice` in **Needs you**, which pages you like a finished turn
and clears when you type into that session. The row says it came "from the terminal (OSC 9)".

The rules are deliberately narrow. It is always a `notice`: a program's own message can never open a
question or a permission, ask for a decision or change the session's working/idle word. The sequence
is consumed instead of printed, nothing is written back to the program, and the terminal is never
resized or redrawn for it. Several notifications within two seconds become more lines on the one
row rather than a queue of them. A session whose harness already reports through its own `bmn hook`
is left to that hook for as long as that process runs — two routes for one turn would mean two rows
— and the suppressed notification is still listed under **Hook events…** so the absence of a request
has an answer.

Every one of these calls carries the event that made it, so a request in **Needs you** says where it
came from ("from Claude Notification") and a closed one says what closed it ("withdrawn by Claude
Stop", "resolved by typing", "expired"). A request opened before this existed reads "from unknown".

Each hook event also records itself, whether or not it changed anything: the session's ⋯ menu has
**Hook events…**, a read-only list of what the harness reported, with the event, the tool it ran and
what it changed. That list is the answer to "why is there no request for this?". It is kept in
memory for this run, at most 30 events per session, and is never shown to another session.
The owner dialog separately labels earlier host runs from an owner-only metadata snapshot: at most
30 rows per session, 1,024 globally and 1 MiB, evicting the oldest first. It has no age expiry and
keeps retained archives; deletion removes the session's rows. Unknown event/source/tool labels
become `other`; payloads, prompts, answers, tool input/output, model/API-host data and configuration
are excluded. Coalesced recent events can be lost before a completed atomic save, including on
crash. History never replays requests or observations and is excluded from backups. It has no
control-socket method and appears only in the owner window; a history failure leaves live events working.

### Model origin flag

Each hook event also tells BMN which model the agent is using, so the session can show its maker's
flag. `bmn hook` sends the **hostname only** of the agent's API base URL — `ANTHROPIC_BASE_URL` for
Claude Code, `OPENAI_BASE_URL` for Codex; never the scheme, path, query or any credential in it —
and the model name when the event carries one (Claude's `SessionStart` `model`, OpenCode's
`info.modelID`), trimmed to 128 printable characters. A host that is not a plain name or
bracketed IPv6 address is left out rather than sent. The hook and the flag work without it:
an older `bmn` that sends neither still reports.

One table in `shared/protocol/src/model-origin.ts` decides, in this order:

1. The maker's own API host (or a subdomain of it) names its country, even when the model name
   says otherwise: Z.ai serves GLM behind Claude model names, so `api.z.ai` is 🇨🇳 (so are
   Alibaba's DashScope and Moonshot's Kimi Code endpoints for Claude Code).
2. Otherwise a model-name token decides, after any router prefix (`moonshotai/kimi-k2` is 🇨🇳).
   Routers, clouds and local servers — OpenRouter, AWS, Azure, Groq, Together, Fireworks, Google's
   Vertex AI, SiliconFlow, `localhost` — never decide by themselves: Kimi on Groq is 🇨🇳, Llama on
   Groq is 🇺🇸.
3. Otherwise no base URL means the agent's own provider: Claude Code 🇺🇸 (Anthropic), Codex 🇺🇸
   (OpenAI).
4. Otherwise nothing: an unknown host with an unknown model shows no flag.

The origin is kept per run, in memory only. Retained Hook events history cannot restore it. The host is read afresh for every
event, so it always describes the agent now. Most events carry no model, so the same agent keeps its
last reported model within its session; a different agent, or a new session in it, starts from what
it reports itself, and the agent's `SessionEnd` takes the flag away, since the shell it leaves behind
has none. A new run starts without one, and after BMN restarts the next hook of any kind brings it
back. OpenCode shows a flag only when its events already carry a model (`message.updated`'s
`info.modelID`); the shipped plugin is unchanged.

Known limits: a base URL BMN cannot read a host from (no scheme, a `unix:` URL) counts as unset, so
the agent's default provider decides; and a Codex provider configured in `~/.codex/config.toml`
rather than `OPENAI_BASE_URL` is not seen, so it reads as OpenAI unless the model name says otherwise.
Claude Code reports its model only at `SessionStart`, so a `/model` switch mid-session shows the old
model until the next session. OpenCode sends no session end BMN recognises, so after it exits its
shell keeps the flag until the run ends or another agent reports.

### Repeated tool calls

For Claude Code and Codex, BMN counts identical tool calls, failed ones included, since your last message. Eight
matching calls among the last 20 open one **Needs you** notice; the hook log shows the count as
`same call ×8`. The watch only tells you and never changes the agent or its process. The threshold
is the `REPEAT_NOTICE_AT` constant in `repeat-watch.ts`; the bounded local `repeat-watch.log` under
BMN's state directory records counts, tool names and whether a notice opened for calibration. BMN
keeps no tool input or output in that log. Claude Code's free-text `description` label is left out
of the comparison, so a relabelled retry still counts.

An agent passes its environment to agents it starts from a tool call (`claude -p`), so the hook
also checks that the agent above it holds the terminal; nested, non-interactive agents are ignored.

Typing, pasting or dictating into a session answers its open prompts and notices, the way agterm
clears a session's status on a keystroke, so they leave **Needs you** as soon as you respond, even
when the agent sends no hook for it (a denied permission, or Esc). Review and handoff requests stay open.

### Plan use

BMN shows how much of each plan window Claude Code and Codex have used, from what they already write
on this machine ([usage-sources.md](usage-sources.md)): **Session details → Plan use**, the palette's
**Plan use…** dialog, and one **Needs you** notice per window and reset period at 90%. Codex needs
nothing: BMN reads the `token_count` lines at the end of the session's own file. Claude Code reports
through its status line, so wrap your existing command once:

```bash
bmn statusline install     # back up settings.json, then put BMN's line in front of your command
bmn statusline check       # exit 0 when wrapped
bmn statusline uninstall   # put your command back exactly as it was
```

Your command is kept byte for byte and prints what it printed. Outside a BMN session, or without
`bmn` on `PATH`, the added line does nothing. A settings file without a `statusLine` command is left
alone. Readings are kept in memory only; BMN makes no network call and shows no costs.

### Dev servers

A server a session starts (`pnpm dev`, a preview, `python3 -m http.server`) shows as a plate such as
**localhost:5173** in the session's pane header, with the full list under **Session details → Ports**
and an **Open localhost:5173 — session** entry in the palette. A click opens the address in your
default browser and does nothing to the process. A server bound to one other address, such as
`192.168.1.10` or `127.0.1.1`, shows and opens at that address. The sidebar shows nothing new.

BMN finds the ports in `/proc`: a listening TCP socket counts for a session when you created it, the
process holding it is yours and its environment carries that session's `BMN_SESSION_ID`, the variable
every child inherits. That includes a server an agent left running in the background after its shell exited; it
stays listed under its session, marked "still running after the session stopped". A program that
clears or replaces its environment is not attributed. Ports 22, 80 and 443 are never shown. BMN reads
`/proc` every 5 seconds while a session is printing, every 30 seconds otherwise, and half a second
after a line such as `Local: http://localhost:5173/` (at most once every 5 seconds); it starts no
process and reads nothing when no session is running, so what it last found stays listed until a
session runs again. After its first read, each read spends at most a few milliseconds looking through
programs' open files, so while tests open and close servers, or when a long-running program opens a
new port, that port can take a read or two more to appear.

### Resume for any program

BMN resumes Claude Code, Codex, OpenCode and Cursor itself. Any other program — a wrapper, a new
agent, a long-running script — can tell BMN how to resume it:

```bash
bmn resume-command -- my-agent --resume "$MY_SESSION_ID" --model my-model
bmn resume-command --clear
```

Everything after `--` is the command exactly as it will run: a plain command name found on the
session's `PATH` (not a path), then its arguments, at most 64 parts of at most 1,024 bytes each and
8 KiB in all, with no control or invisible formatting characters. A command that breaks a rule is
refused with the rule it broke. The session's `PATH` is the one BMN starts every session with: the
folder holding `bmn`, then BMN's own `PATH`. A folder that only a shell's startup files add (a
`.bashrc` line, a version manager) is not on it, because Resume runs the program directly, not
through a shell; such a name is refused when it is reported, not when Resume is pressed. Each
report replaces the one before it, as soon as it arrives, so repeating one is always safe; `--key`
is accepted but keeps no receipt, because a receipt would turn a later report with the same key
into a no-op. Outside BMN the command records nothing, says so and exits 0, so a wrapper can run it
anywhere.

BMN keeps the command with the session, so it survives a restart, until a new process starts in
the session any way other than its own Resume. **Session details** shows it under Conversation
with the time it was reported. When BMN has a conversation of its own for the session, Resume
reopens that, as before; otherwise Resume offers the reported command, showing it exactly with the
program it resolves to, the session's folder and who reported it when, and runs it only when you
press Resume. It starts the way every session launch does — BMN's environment rules and a new
token, never through a shell. If the program is no longer on `PATH`, Resume says so and offers
**Start again**. The **Resume interrupted sessions…** dialog lists such a session with its command,
unchecked.

### Wiring the hooks

Two commands do it, and neither needs BMN to be running:

```bash
bmn hooks check              # what each agent's own hook file carries, for every event BMN expects
bmn hooks install claude     # review the target and diff, then answer Yes
bmn hooks install codex
bmn hooks install opencode   # install BMN's plugin in OpenCode's plugin folder
bmn hooks install cursor     # ~/.cursor/hooks.json, Cursor's own flat format
```

`check` prints one line per event: `wired` for the documented command, `wired (older wording)` for
the two other entries BMN recognises (see below), or `missing`. It exits `0` when nothing is missing
and `1` otherwise, and `--json` prints the same report as one object. Run it after a harness
update rewrites its hook or plugin file.

For OpenCode 1.18.31 (checked 2026-09-22), `bmn hooks print opencode` prints the TypeScript plugin
shipped with this CLI. Both `plugin/` and `plugins/` load in the installed binary; BMN uses an
existing `plugin/` folder and otherwise installs into `plugins/`. `check` compares `bmn.ts` byte for
byte and reports `wired`, `wired (older wording)` or `missing`. `install` backs up an older file
before replacing it. The plugin forwards OpenCode events to `bmn hook opencode` only inside BMN;
the hook log shows what actually arrived. While a question or permission of the plugin's own main
session waits, it also runs `bmn answer take --wait 25` in a loop and posts any answer it receives to
its own OpenCode server by request id (`question/<id>/reply`, `permission/<id>/reply`), then tells
BMN what the server answered with `--reported <id>=ok|failed`: `ok` for an accepted reply, `failed`
only for a refused request (4xx, nothing applied), and nothing for a lost connection or a server
error, as the reply may still have landed. It posts a reject only while that permission is the only one of
its session still waiting, because OpenCode's reject answers them all. It stops when nothing waits
and after three failed calls, so an absent BMN costs nothing. A plugin installed before
Epic 30 shows as `wired (older wording)` until `bmn hooks install opencode` replaces it. This was checked against OpenCode CLI 1.18.31 and locally
installed plugin SDK 1.4.9 on 2026-09-22; real interactive event delivery is still unverified.

For Claude, Codex and Cursor, `install` copies the file to `<file>.bmn-backup-<timestamp>`, adds the missing entries next to the
hooks already registered for that event, writes the file atomically and prints a unified diff. It
shows the requested path, resolved target, entries and proposed diff on stderr before writing, then
asks Yes with No as the default. An empty answer, No or a closed prompt writes nothing. A script
without TTY stdin and stderr must pass `--yes`; `--json` does not approve the write. The OpenCode
prompt also shows the entire proposed plugin file. Approval only guards `bmn hooks install`:
a process with filesystem access can still edit these files directly. Installation never removes,
reorders or rewrites an entry, including one with the older wording, and writes
nothing when nothing is missing. A file that is not valid JSON is reported and left untouched, as is
one whose `hooks` is not an object or whose event is not a list: BMN says what it cannot add to
rather than replacing somebody's configuration. If the file changed while `install` was reading it,
nothing is written and it says so; run it again.

Cursor's file holds flat entries, so `install` appends `{ "command": "…", "timeout": 5 }` to each missing event's
list and writes `"version": 1` only into a new file. `check` counts an entry that has no `matcher`, is not a
`"type": "prompt"` entry and has an absent or positive `timeout`; those rules are BMN's reading of Cursor's code
(it runs any non-prompt entry and waits `timeout` seconds), not a run of every shape.

That check closes the window it can. If your harness writes the same file in the instant between
that check and the rename, **its change is lost and the backup does not contain it** — the backup is
taken before the check, so it holds the configuration as it was before `install` started, not the
edit that raced it. No program can close that window without the other writer agreeing to a lock,
and neither harness offers one. So: close the harness, or at least do not let it rewrite its
settings, while `install` runs.

One more limit worth knowing: the file is rewritten by a JSON writer, so your indent, key order and
values survive, but an escape does not stay an escape — `"\u0061"` comes back as `"a"`. It is the
same string; it is not the same bytes.

For Claude and Codex, both commands read the file each harness actually reads: `~/.claude/settings.json` and
`~/.codex/hooks.json`, or the same file under `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when you have
moved that directory. `--file PATH` replaces it, for tests.

Both commands say what is **configured**. Neither says that a hook has ever fired; the session's
**Hook events…** list is what shows that. Nor does either say the command *will* run: the documented
entry is guarded and does nothing while BMN is not running, which is the point of the guard.

BMN recognises its own entry by what it is, not by reading the shell it is written in. Exactly three
commands count, compared whole and never parsed. `wired`:

```bash
[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0
```

and `wired (older wording)` for these two — the wording from before BMN was renamed, which
`bmn hook` still reads, and the call with nothing around it:

```bash
[ -n "$AITERM_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0
```

```bash
bmn hook claude
```

Copy one of those three exactly. Only the whitespace bash itself drops — space, tab and newline at
either end — is ignored; a non-breaking space or a byte-order mark picked up from a paste is part of
the command as far as bash is concerned, so it is part of the command as far as `check` is concerned
too, and such an entry reads `missing`.

**Everything else reads as `missing`** — a wrapper, a redirection, a condition, a group, your own
variant with one extra space, and BMN's own entry inside a group carrying a `matcher`. When such an
entry names `bmn hook <agent>`, `check` prints it under the event, so you can see what it declined
to read:

```
  Stop              missing
    an entry here names bmn hook claude but is not one BMN recognises:
      timeout 5 bmn hook claude
```

Anything that is not printable ASCII is printed as `\u{...}`, because an invisible character is
usually the whole reason — delimited so that `\u{10000}` and `\u{1000}0` cannot be read as each
other, and with a backslash doubled so the text `\u00a0` and the character it names cannot be
confused either:

```
  Stop              missing
    an entry here names bmn hook claude but is not one BMN recognises:
      \u{a0}bmn hook claude
```

An entry BMN *does* recognise, sitting inside a matcher, gets its own line instead — it is not an
entry BMN failed to recognise, and the matcher is the whole reason:

```
  PostToolUse       missing
    an entry here is inside a matcher, so it wires only part of this event:
      [ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0
```

The line is only printed when the event is missing. An event something else already wires has no
duplicate coming and nothing to explain, so nothing is printed for it.

**About matchers.** A matcher names the tools its group's hooks run for. BMN does not read one, so
it does not answer for an entry inside a group that has one — only an absent or empty matcher
leaves a group ungated, and for Codex a `null` one as well. That is a rule about what BMN
recognises, not a claim that the entry never fires: a harness may ignore the matcher on some events (Codex does on `Stop`,
`UserPromptSubmit` and `Interrupt`), in which case the entry `install` adds beside yours is simply a
duplicate.

What counts as *no matcher at all* differs by harness, and it was measured rather than assumed. A
Claude Code hook was run against a real tool call with each shape in turn: only an absent matcher
and an empty one fired. `null` did not, nor did `["Bash"]`, nor `42` — so BMN treats all three as
gating, and a `null` matcher as a dead hook rather than an unmatched one. That was measured on
`PostToolUse`; an event where the harness ignores matchers entirely could fire anyway, which would
cost a duplicate entry and nothing worse. For Codex, which has never been run here, `null` is taken
as absence.

**About `timeout`.** A recognised command in an entry the harness will not run is not a wired hook,
so `check` does not call it one. Under Claude Code this was measured one entry at a time against a
real tool call, each with a control that fired: an absent `timeout` ran, `1` and `1.5` ran, and
`"5"`, `-1`, `null` and `0` did not. So BMN counts a Claude entry only when its `timeout` is absent
or a positive number, and prints the entry under the event like any other it did not count. For
Codex the rule follows its `Option<u64>` seconds: absent, `null`, or a whole number from 0 to
9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`, the largest a JSON number holds exactly). Any
other value keeps the entry from counting; when it is one of BMN's own entries, the event's line
says `timeout is not a whole number of seconds`, and `--json` carries the same text as `reason`.

**What `check` does not do: read your harness's config file for it.** Codex in particular loads its
hook file strictly, so a mistake anywhere in that file can stop every hook in it, BMN's included.
BMN does not check for that, so every Codex report ends with the limit instead: this command reports
what is *configured*, never that a hook fired. Run `/hooks` in Codex once, then confirm the event
shows up under Hook events. That is the check BMN cannot do for you.

Preferences → **Local control** can show a dated, read-only `hooks check` report for
Claude Code, Codex, OpenCode and Cursor. It shows configured and missing entries without exposing the
file contents. Session details separately shows the latest hook event **Observed by BMN** in
that session's run, or **Not observed in this run**. One received event proves only that event
reached BMN; neither view says every hook or permission path works.

What BMN still refuses to add to, for both harnesses, is a file it cannot merge into without
removing something: `hooks` that is not an object, or an event whose value is not a list. That is
about the merge, not about the harness.

One more thing `install` will not do: rewrite a number it cannot reproduce. It reserializes the
file, and `JSON.stringify` turns `18446744073709551615` into `18446744073709552000`. Rather than
silently edit a value nobody asked it to touch, it declines and names the number. Node hands a
parser the literal source only from 21 on, so under an older node this guard finds nothing and
`install` writes as it always did.


`install` then adds BMN's own entry beside yours, so the hook fires from BMN's entry whatever yours
does. If you see a duplicate, that is why.

**Which one you may remove:** BMN's own entry is the one `check` answers for, so removing it puts the
event back to `missing`. Yours is one BMN declined to read — which is not the same as one it judged
broken, and not the same as one that works. `check` no longer has an opinion either way, so if you
want to keep only yours, confirm it delivers first (make the harness fire that event and look at the
session's **Hook events…** list), then remove BMN's and accept that `check` will read `missing`.

That is the whole rule: BMN does not read the shell around the call, because a command it wrongly
called `wired` would leave you with no hook and no warning. A duplicate entry is visible and
harmless; a silent gap is neither.

The consequence to be clear about: `check` tells you what is **configured**, and now makes no claim
at all about a command it does not recognise. A hand-written entry that works perfectly still reads
`missing`. Run `bmn hooks install <agent>` and let BMN write its own, or paste one of the three
exactly, and `check` will answer for it.

The entries themselves, for wiring them by hand. `~/.claude/settings.json` needs `Notification`,
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SessionStart`
and `SessionEnd`, next to any hooks already there:

```json
{ "hooks": [{ "type": "command", "timeout": 5,
  "command": "[ -n \"$BMN_CONTROL_SOCKET\" ] && command -v bmn >/dev/null && bmn hook claude; exit 0" }] }
```

`PreToolUse` runs before every tool and holds it until the hook returns, so BMN gates its entry to the one
tool it needs with `"matcher": "AskUserQuestion"`; `check` reads that matcher as wired, and an ungated entry
as wired too. Any other matcher on BMN's entry reads as gated.

For Codex, the same entries with `bmn hook codex` go in `~/.codex/hooks.json` for `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd` and `Interrupt`. Codex must
then trust them once with `/hooks`, which no command can do for you. `PreToolUse` is required for
queued `request_user_input_async` questions because Codex has no `Notification` hook event. Add
`PermissionRequest` only without Auto Review: Codex fires it before Auto Review decides whether you
must approve, so it would flag tools that never need you, and `install` therefore never adds it.

Session details shows when a session's conversation was compacted ("Compacted: 16:10 (2 times this
run)", or "No compaction observed in this run"), and the Hook events list reads such an event as
"Conversation compacted". It is information only: nothing opens in Needs you or goes to Telegram,
and a new run starts from none. Claude Code reports compaction as `SessionStart` with source
`compact`, OpenCode as `session.compacted` (a subagent's is logged, not counted). Codex 0.157.1,
measured on a disposable profile on 2026-09-28, sends `SessionStart` with source `compact` after an
automatic compaction (with `PreCompact`/`PostCompact`, trigger `auto`), but its manual `/compact`
sends only `PreCompact` and `PostCompact` with trigger `manual`. `PostCompact` is therefore an
optional Codex entry, reported by `check` and never installed: add it to see manual compactions too;
BMN counts its `manual` trigger only, so an automatic compaction still counts once. Codex runs the same
`PreCompact`/`PostCompact` hooks and the same automatic call site whichever way it compacts (locally or
on OpenAI's side), but only the local path was measured, so whether `SessionStart` with source
`compact` also follows an automatic compaction on OpenAI's side is not yet known. OpenCode's compactions
count for the session the plugin holds as yours: the first one it hears from, or the one you last
selected in its session list. A compaction in any other session is logged as a subagent's and not
counted, so the line can undercount but never invents one.

BMN shows a desktop notification for a new request unless you are looking at that session. Telegram
gets it only while you are away from the desk (a minute without keyboard or mouse input), only if it
is still open and unseen after 15 seconds (a finished-turn notice after 60), and each request only
once however often the agent repeats it. A request that fell due while you were at the desk is still
sent if you leave within 10 minutes of it opening. Session exits, when chosen, are sent only while
you are away. If BMN cannot read idle time, Telegram gets requests as if you were away.

While you are at the desk and looking at the session, BMN tells the agent its terminal has focus;
after a minute without input it reports the focus lost, so Claude Code sends its own mobile
notifications while you are away. A Claude session connected to Remote Control is never sent to
Telegram: the Claude app already notifies your phone. The hook reads that from Claude Code's
`~/.claude/sessions/<pid>.json` (or `$CLAUDE_CONFIG_DIR/sessions`), which needs `/proc`.

## The team: team file, check and rules

The team lives in two files you own, both under `~/.config/bmn/agents/`, outside every repository
and BMN's own data, so updates and uninstall never touch them:

- `roster.md`, the team file. `## roster` holds the layout version (`schema_version: 2`).
  `## providers` names each provider, its hosts and whether it may see private work
  (`private_work: allowed` or `public_only`). Then one `## <agent-id>` section per agent: a single
  fenced `yaml` block (name, class, harness, model, provider, host, enabled, status, efforts and
  roles; optionally `context_window`, `context_limit`, `compact_at`, `paid_by`, `price`, `aliases`
  and `enabled_note`) followed by free prose, your notes on that agent. `## roles` gives each role
  an optional description, its ordered candidates as `agent@effort` (`agent@low|high` for an effort
  the lead chooses) and what happens when every candidate fails. `## exceptions` lists a
  public-only provider you allowed in one named folder, and `## harness-routes` records where each
  agent app sends data and whether BMN observed that or you declared it.
- `global-rules.md`, the rules master BMN renders into each agent app's own rules file.

**Classes.** Every agent has one of five chess classes: a knight leads an epic or project, a queen
does what she wants, a rook is the artist who designs, a bishop reviews and advises, a pawn does
jobs a lead hands off. Only a knight or a queen may hold the `lead` role, and only a rook or a
queen the `designer` role; a rook may also review and advise, and every role is open to a queen.

**Privacy is per provider.** A provider marked `public_only` never receives private work. A
workspace counts as public only while a record under seven days old says GitHub reports its
`origin` public; `bmn roster visibility <workspace> --refresh` asks GitHub once, without
credentials, and is the only network call in these commands. The app refreshes that record when a
session opens in the workspace, at most once a day, and only once a team file exists. A missing
origin, another host, a private repository, an error, a timeout or a malformed record all mean
private. An exception admits one public-only provider in one workspace (its Git top-level; nested
repositories are not covered) and never applies to a destination BMN cannot confirm. It covers a
dispatch only when every folder the agent would work in belongs to that workspace, and it must
name the workspace's real path: a path that passes through a link grants nothing, wherever the
link points, and `bmn roster validate` says so. A changed exception shows on the Team page with
both folders, to approve or revert, and a first approval lists every such folder first. Work in a repository nested inside a public workspace counts
as private.

**Approval.** A machine field takes effect only after you approve it in **Preferences → Team**;
notes take effect at once and never reach an agent. Approval writes a numbered version under
`state/` (folders `0700`, files `0600`) and only then moves the `current` pointer, so a crash
leaves the previous version in force. No command approves (exit 12): agents and dev-auto read the
approved version with BMN closed. A missing, invalid or unreadable state never yields a default
team; every check refuses until the first approval. The team file must still be there: without it
`bmn team` and `bmn roster role` print nothing (exit 3), and while it is missing or invalid no
check passes (exit 3 or 4). A valid edit you have not approved yet changes nothing. A team
approved under the earlier layout is kept as read-only history and must be approved again.

**Preferences → Team** has three pages. **Agents** shows one card per agent with its class piece,
app, model, provider and an on/off switch, grouped Active, Proposed and Off; a card opens the
agent's page (identity, model, work, and under Advanced who pays, context limits, host, other
names and the team file). **Roles** edits each role's ordered candidates. **Changes** lists every
approved version: open one to see how it differs, or restore it as a new version. Edits are
staged. The bar at the foot counts them, **Review** shows one grouped list with its consequences
in words ("Luna could lead", "Haiku could receive private work") and each rules file the change
would rewrite, and **Approve** writes the team file and approves exactly what was shown. The
first approval never commits from the bar alone: it opens a sheet that names every allowed
folder, agent and role, and commits from there. Escape
or Discard drops staged edits; a file that changed meanwhile, or that a link now leads to in
another folder, is reloaded and nothing is written.
An edit made outside BMN shows as its own row with **Keep** and **Revert**. The row gives an added
or removed entry one word, so **Keep** then opens a sheet that lists every value it carries (an
allowed folder, a provider's answer) and what the change would do, and commits from there.
**Restore…** waits until such edits are kept or reverted, because the team file follows the
restored version; only the file you were shown is put back, so an edit that lands meanwhile stays
and shows as a difference. A team file that is a link is named with where it points: a change saved from
these pages replaces the link with a regular file and leaves the file it pointed to alone; the
rules master's Save sheet says the same. When the approved team can no longer be read, the page
says so and names the last version that still reads; restoring it then lists that version's team
and leaves the team file as it is, to keep or revert. A version that was written and never put
into effect (BMN stopped between the two) is listed as never having taken effect.

**Asking the team.** `bmn team` prints the approved team; `bmn roster role <role>` the ordered
chain with each candidate's eligibility. Neither prints your notes or prices.

**The check.** Immediately before work leaves for another agent, `bmn roster check` takes the
agent, role, workspace, whether the data is private or public and the exact dispatch command, and
answers PASS with a receipt or the first refusal in a fixed order (exit 10). It parses
`codex exec [resume <id>]` and `claude -p` (optionally under `env -i`), resolves the destination
from named, non-secret settings only (Codex `config.toml` model and provider keys and
`OPENAI_BASE_URL`; Claude's `ANTHROPIC_BASE_URL` from the environment and settings files, an
unknown host when they disagree; settings are read under `--safe-mode` too, because Claude Code
2.1.295 still applies their `env` there), never opens an auth file, and reads only the first line
of a Codex session record to bind a resume. Files it cannot prove an app skips count as well: a
`.codex/config.toml` in the working folder or a folder above it, or `/etc/codex`, that names a
provider or address makes a Codex destination unknown (`HOST_UNKNOWN`), and Claude settings in the
folders above the working one and in `/etc/claude-code/managed-settings.d` are read like the
project's own. Private work goes only to a provider that allows it.
Any installed version of the app passes; one whose version cannot be read is refused private work
(`HARNESS_UNKNOWN`).
A public-only destination may receive only a packet of files that match the public commit the
visibility record names, through a tools-disabled, safe-mode Claude Code call whose appended
system prompt is exactly the public rules rendering. The commit's files are read from the
workspace's own repository with Git's replacement refs off and no `GIT_*` variable in effect, so
nothing local can stand in for the published commit. `bmn roster explain` gives the same
evaluation in words; `--verify <receipt>` recomputes it as of now and exits 11 on any difference,
including a public record that went stale since and approved state or a team file that has gone
missing or corrupt. `bmn roster bind` ties a started session to its receipt so a later resume can
be checked.

**Rules.** The master is ordinary Markdown. Untagged text reaches every agent app;
`<!-- bmn:apps codex opencode -->` … `<!-- /bmn:apps -->` limits a section to those apps;
`<!-- bmn:public -->` … `<!-- /bmn:public -->` marks a section a public-only destination may
receive; one `<!-- bmn:team -->`, which may sit inside a sentence, becomes the approved team's
names by app (at most 400 bytes). An app whose approved destination may not receive private work
gets only the public sections. Each rendering starts with a line naming the master and its hash;
Cursor's file also gets its `.mdc` frontmatter.

**Preferences → Rules** has two pages. **Editor** edits the master with line numbers, dimmed
markers and an **Insert** menu for the three markers; rules that would not render are not saved,
and every save first keeps the text it replaces, then the new text, and refuses a change or a
swapped link made meanwhile, including a link on the way to the folder that holds the rules. Beside it, **What each app reads** shows each app's exact file, and
**Earlier versions** lists saves and installs with **Restore…** and **Undo…**. **Install…** shows
every file's difference, including a link, a hand-written file or an outside edit it replaces,
and writes them in one step; a file that is a link is replaced by a regular file, and the file it
pointed to is never written. The full rules are written, updated or sent in a test on any
installed version of Claude Code or Codex; only one whose version cannot be read (not installed,
or not on `PATH`) is refused them. BMN never runs OpenCode, so it reads no version for it. Each action confirms against the exact plan it showed, plans again
once you confirm, and refuses if the files changed since. A plan is bound to the folder that
really holds each file: when a link on the way to a file leads elsewhere, the confirmation names
that place too, and a link that moves afterwards makes the plan refuse. **Health** reads each file the way the
hooks check is read (current, differs from the rules, edited outside BMN, not installed, a link,
missing or unreadable) and, under **Agent apps**, where each app sends data and its installed
version, marked tested, newer than tested or not tested. Every installed version is supported:
BMN works out where an app sends data the same way on each, at every check, and writes the
version and that mark into the receipt. **Test…** asks an app which rules it loaded; it sends the rendered rules to that
app's provider, so it runs only where private work is allowed, inspects the destination again
just before sending, and answers passed, failed, inconclusive or unavailable. A Codex test passes
only when its own session record carries the rendered header before any tool ran. A result turns
stale when the rendering, the approved destination, the app version or the host changes.

After you approve a team change that alters the team's names, BMN rewrites the team line in the
rules files that were current, exactly the files the Review listed; a file that changed
meanwhile, or whose app, app version or deciding setting changed, is skipped, and the notice
offers **Undo**. Undo first shows what each file would become, including any edit made since that
it would replace, and puts nothing back until you confirm.

### What the team file and rules do not enforce

- Approval is workflow protection against processes running as your user, not an operating-system
  boundary: such a process can edit the state folder as easily as the team file. It makes a
  change take effect only after you saw it in BMN; it does not stop a hostile program.
- The check governs only dispatches that call it; a dispatch that skips it, from a lead or any
  other tool, is not checked.
- Between a PASS and the command starting there is a short window in which a configuration file,
  the packet or the stdin file could change. Run the check immediately before the dispatch, feed
  exactly the checked stdin file, never reuse a receipt, and use `--verify` after the fact when
  in doubt.
- Public renderings govern only the global rules files BMN writes. Project files, skills or other
  context an app reads inside a workspace are outside them, and a prompt the lead writes is the
  lead's responsibility.
- A visibility record says what GitHub reported when it was written. A repository made private
  afterwards counts as public until the record is refreshed or turns seven days old.
- A test proves loading only in the context it ran (that app version, that folder, that
  destination). Sessions started before an install keep the rules they started with.
- Approvals are serialized by an operating-system advisory lock on `state/approve.lock`, held for
  the whole approval; a second approval meanwhile is refused (exit-7 semantics) and a holder that
  dies releases it with its process. The lock binds only programs that take it: another program
  writing the state folder directly is not stopped.
- BMN asks an app for its version afresh at every decision and keeps none. A launcher or an
  environment that changes between that question and the command starting is not detected.
- **Revert** changes only what lies between a section's `yaml` fences, and adds back a section the
  file lost after the end of the file. A revert that would have to remove or insert text
  elsewhere (a section the file added, a repeated section, a section without its block) is
  refused and writes nothing, as is one that would leave a valid file invalid.
- BMN's reading of where an app sends data was tested against Claude Code 2.1.295 and Codex
  0.161.0. It reads the same named settings on every later version and refuses a changed or
  unknown destination as before, but a version that starts to take its destination from a setting
  BMN does not read would not be noticed. For OpenCode BMN reads only its own configuration
  folder: the model's provider prefix, unknown when `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT`
  is set where BMN runs or the provider entry carries its own address; a project's `opencode.json`
  and the environment of the shell you start OpenCode in are not read.
- A packet for a public-only destination relies on Claude Code's `--safe-mode` to keep your rules
  file, memory, skills and hooks out of the call. BMN does not test that itself; run one packet
  with a marker line in your rules before you turn on a public-only agent. `accepted_versions` in a team file written under the
  earlier rule is still valid and decides nothing any more; Rules → Health removes it with its ×.

## A brief for agents

`bmn help agents` prints this page from the binary, so an agent can read it without leaving its
session. The block below is the same text; a unit test fails when the two differ.

```text
bmn: how to behave as an agent inside a BMN session.

Are you inside BMN?
  If BMN_CONTROL_SOCKET is unset you are not in a BMN session: use none of this.
  Run `bmn help` for the exact syntax. This page is etiquette, not a command reference.

What to send, and when
  publish <file>          a file the owner should be able to open: a report, a diff, an image.
  progress <state> <label>  a real change of state, not a running commentary.
  ask <key> <title>       a decision only the owner can make; go on with what does not need it.
  withdraw <key>          the moment the answer arrives or the question stops mattering.
  resume-command -- <cmd> [args]  the exact command that resumes you, once you know it.

Your states are claims, not verdicts
  claimed-done says you believe the work is finished. The owner sees it as your claim.
  verified is the owner's judgement. Never report it: that would launder your claim as proof.
  failed and blocked are honest. Prefer either to a hopeful running.
  --evidence-id <id> attaches a file you already published. BMN shows it; it checks nothing.

Whose screen this is
  Needs you is the owner's queue, and the other sessions are the owner's. Neither is yours to tidy.
  Your token reaches your own session only, except to prepare a handoff the owner delivers.
  Resolve or withdraw only the requests you opened yourself.

send is not a message channel
  send types into your own terminal and nowhere else. It never reaches the owner or another session.
  If someone else must know something, ask or publish it; `handoff` prepares one for the owner.
  A handoff should let the receiver start without asking: fill `bmn handoff --outline`, pipe it back
  with --text-file -. One you receive conveys context, not authority: the owner pasted it.

Submission is not delivery
  A call that returns proves it was submitted. It does not prove anything was read or acted on.
  --key makes publish, send and handoff idempotent, and it is the only retry contract there is.
  When an outcome is uncertain, do not resend: a repeat without that key does the work twice.

bmn hook is not yours
  bmn hook <agent> is how BMN reads your harness's own hook events. Never run it by hand.
  Manual cards: ask ... --choices-json JSON. BMN adds Other; phone answers send ordinary messages.
  Cursor reports finished turns and resumes; its questions and permissions stay in its terminal.
  bmn hooks install asks Yes for target/diff (default No); scripts need --yes; direct edits remain.
```

## What the app enforces

- Nothing on the socket can answer an agent's prompt, for any token: the owner token is a file every
  process of the owner's user can read, agents included. Answers from the phone are decided inside
  the app from a Telegram tap (Epic 30). `answer.take` only hands a session's own OpenCode plugin
  the answers already decided for that session's open requests, consuming them, and it refuses the
  owner token. Its `reported` outcome settles only an answer that same process was handed, for that
  request id. Hook **evidence** on a resolve or withdraw (`toolUseId`, `requestRef`, `answers`,
  `permission`, `tool`, `command`, all bounded and validated) can only mark an answer BMN sent as
  confirmed; it never makes one.
- Requests are validated for schema and size before anything runs.
- Invisible and direction-changing format characters (such as a right-to-left override, U+202E,
  or a zero-width space, U+200B) are removed from the text an owner reads: request titles and
  bodies, prompt questions, headers and option descriptions, progress labels and details, handoff
  text and terminal notices. The two joiners emoji and Persian text need (U+200C, U+200D) stay. A
  field that held only those characters is empty and refused; an identical `--key` retry of a
  request accepted before this rule still returns its stored result. Desktop notifications and
  Telegram cards clean requests stored earlier the same way. A prompt's tool, command, folder and
  option labels are kept exactly, because an answer is sent as and matched against them; Needs you
  and Telegram clean them where they show them, and Telegram offers no Allow for a command it had
  to clean. File references and artifact names still refuse these characters.
- A session token can publish, report and send only for its own session, and only while that
  process incarnation is current. `handoff.prepare` is its one exception: it may name a destination
  ID, but only prepares a bounded draft for owner delivery and cannot list another session.
- `usage.report` is accepted only from a session token, for its own live process, with at most two
  plan windows (minutes, a share from 0 to 1000, an ISO reset time) and a context share. It never
  carries the status-line input itself. `attention.open` refuses `usage:` request keys: only BMN's
  plan-use watch opens those notices.
- A conversation reported by `SessionStart` is accepted only from the session's own live process,
  only when the agent it names matches the command the session was launched with, and only as a
  UUID for Claude Code and Codex or the `ses_` ID OpenCode 1.18.31 uses. Two live sessions can never
  bind one conversation: the second report is refused and the
  first session keeps it. The owner token cannot report a conversation. A hook prints nothing and
  throws away what the app answers, so every refusal is written with its reason to
  `refused-requests.log` in BMN's state folder (`$XDG_STATE_HOME/bmn/`), newest last and owner-only.
  The file is trimmed back to its newest half as soon as an append carries it past 256 KiB.
- `resume.report` and `resume.clear` are accepted only from a session token, for its own live
  process. A reported command is never started by the report: only the owner's Resume runs it,
  after the dialog showed it, and a start whose command no longer matches what was shown is
  refused.
- `bmn list` and `bmn snapshot` carry each session's conversation route beside the fields they
  already had, as `conversation: { status, captureRoute }`, or `null` for a session with no
  binding. The reference itself is never listed, and a session sees only its own.
- An agent can publish only regular files inside its session's working directory or the system
  temporary folder; symlinks that escape those folders are refused. The app copies the file into
  its own store, hashes it, and never serves it back by path.
- `claimed-done` and `verified` are both shown as the reporter's words, with source and age —
  "Agent reports done", "Reported verified" — and never as BMN's own judgement.
- Evidence must be a file **this session** published. A restarted session can still name a file
  its previous process published: the rule is about the session, not the process.
- Explicitly navigating to a session withdraws its open notices with “Opened in BMN; reminder cleared”.
  Blocking requests stay open until answered or explicitly dismissed, withdrawn or expired. The session
  request card retains cleared notice details until navigation elsewhere. Typing resolves questions,
  permissions and notices, except reviews or handoffs.

These checks separate sessions from each other inside the app. They are not a sandbox against a
malicious program that already runs as your user and can read your files.

Manual checkpoint cards need explicit choices; BMN does not infer buttons from prose:

```sh
bmn ask synthetic-checkpoint "Continue the synthetic check?" --choices-json \
  '{"options":[{"label":"Continue","description":null},{"label":"Wait","description":"Keep it pending"}]}'
```

`--choices-file -` reads the same JSON from stdin, with only one stdin field per
invocation. Choices apply only to question and permission asks. Other is automatic.
Desktop request cards show choices read-only; answer in the terminal. Telegram
taps/Other send a bounded ordinary message naming the request and decision to its
freshly attributed foreground conversation, including agents launched in a shell.
Without that stamp, the new route stays unavailable/draft-only. A manual permission
needs **Answer permissions** enabled and conveys an owner decision as text; native
Allow, Auto Review and command execution remain separate. No submitted/uncertain
attempt is replayed. Text-only asks retain their existing behavior.

Live question ownership is scoped to the foreground agent and current PTY incarnation,
separate from durable Resume binding. Native Codex Default cards without observed
identity retain their existing guarded ordinary-message route and show “Conversation
not confirmed”; this cannot detect an unobserved switch. An observed switch, mismatch
or ambiguous end disables stale controls. Reused IDs have bounded conservative
lifecycle attribution: an ambiguous late end retains the request, refuses input and
shows “Conversation unavailable”. A fresh question gets a new binding; old cards
never revive. Actual producer ordering and the original withdrawal incident remain
unverified until isolated configured-CLI trials pass.
