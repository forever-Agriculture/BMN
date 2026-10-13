# Messages between sessions: what a hook can hand its own agent

With a workspace's switch on, an agent in one session can leave a short message for another
(`bmn tell`; [agent-control.md](agent-control.md#messages-between-sessions)). BMN never types a
message with Enter. A working agent gets one from its own app's hook, which may add text to what
the agent reads after a tool call. This page records, per app and version, whether that is proven
to arrive once and whole. BMN hands a message over by itself only where the table says PASS.

Measured 2026-10-13 (Story 66.1) with the installed apps, each in an isolated profile inside an
isolated BMN built from `51959e8`, in a made-up conversation with made-up text. The scripts and
raw records are kept under `_bmad-output/planning-artifacts/reference-66-session-messages/`
(not committed).

## Result

| App | Hand-over by its own hook | Measured on |
| --- | --- | --- |
| Codex | **PASS**: five of five runs, the whole stamped text once, read before the next action | codex-cli 0.162.1 |
| Claude Code | **PASS**: five of five runs, the whole stamped text once, read before the next action | Claude Code 2.1.296 |
| OpenCode | no hand-over: BMN cannot tell where they send work | does not apply |
| Cursor | no hand-over: BMN cannot tell where they send work | does not apply |

A PASS needs five runs with no doubled, cut or lost text. An agent of an app without PASS can
send, and receives only through the owner's **Paste** in **Messages…**.

Both apps hold PASS, and each app's agent runs `bmn` from its own shell tool (below), so a message
can travel either way between a Claude Code agent and a Codex agent without the owner's Paste. For
each app these records also hold one real message from end to end: `bmn tell` typed in a second
session's shell, handed to the working agent by BMN's own hook (below). A message written by one
app's agent and handed to the other's on an installed build is not in these records.

## Codex 0.162.1

**The answer that hands a text over.** On `PostToolUse` the hook prints
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<text>"}}` and exits 0.
Codex gives the text to the agent as a developer message before its next action. Five runs with
a stamp and three lines of 2,000 characters (2,219 characters in all): each run held the whole
text once in Codex's own record, and the agent's next command named the three made-up words from
its start, middle and end. Nothing about it is shown on screen.

Other forms, one run each: `{"decision":"block","reason":…}` hands the text over too, but shows
"Blocked by hook" with the whole text on screen; exit code 2 with the text on standard error hands
it over; plain standard output and `systemMessage` do not reach the agent.

**Size.** 9,219 characters arrived whole. 12,219 and 30,219 were cut in the middle with
"Warning: truncated output" (about 10,100 characters kept); at 30,219 the agent made up the
middle word it never saw. A message is at most 2,000 characters plus its stamp, far below that.

**Time.** With `timeout: 5` on the hook entry, a hook that took 3.0 s and one that took 4.5 s
still handed the text over; at 7 s Codex gave up on the hook, the agent got nothing and went on.
BMN bounds what it adds to an event for a message to 300 ms.

**Which conversation an event belongs to.** The event carries `session_id`, `turn_id`,
`transcript_path` (the record Codex saved), `cwd`, `model`, `permission_mode`, `tool_name`,
`tool_input`, `tool_response` and `tool_use_id`. A sub-agent's events add `agent_id` and
`agent_type`, keep the parent's `session_id` and name the sub-agent's own record. An agent another
agent started (`codex exec` from the typed agent's shell tool) has its own `session_id`, the same
BMN token and no terminal, which is how BMN's process rule already tells it from the agent typed
into the session.

**Where the agent sends work.** The prompt guard's resolver answered on every `PostToolUse` event
of the main conversation (provider OpenAI, slowest 41 ms). On the sub-agent's event it had no
answer, because the record that event names belongs to another id; for the started agent it
stopped at the process. Neither gets a message.

**Version.** No event names the app's version. `/proc/<agent pid>/exe --version` answers
`codex-cli 0.162.1` in 11 to 13 ms. BMN does not ask per event: `bmn hooks check` and Messages name
the version this page was measured on.

**Running `bmn` from Codex's own shell tool.** Under the owner's settings (approval on request,
Auto Review, the workspace-write sandbox) the sandbox refuses the control socket (`EPERM`; in two
runs the model did not ask to leave it). Told to ask for a run outside the sandbox, `bmn list`
ran and listed its own session, with no question to the owner. `bmn` names that remedy in its
error.

**A real message, end to end.** Measured 2026-10-13 on the build that has this feature
(`accde55`), in the same isolated profile, with nothing standing in for BMN or for Codex. A second
session of the workspace ran `bmn peers` and `bmn tell <id> --text-file -` in its shell with a
made-up text of 2,000 characters in three lines. BMN stored it as *waiting* under its own stamp.
Codex, typed into the first session, was then asked to run three commands. After the first, BMN's
hook printed the message; Codex's next command named the three marked words of the text; Codex's
own record of the conversation holds the whole stamped text once; and Messages read *printed for
the agent*. Two runs of two.

## Claude Code 2.1.296

Measured with the model Haiku 5.5, started as `claude --permission-mode dontAsk` with `echo`,
`bmn`, `claude` and `codex` as its allowed shell commands, so that no question waits for an owner.

**The answer that hands a text over.** The same as for Codex: on `PostToolUse` the hook prints
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<text>"}}` and exits 0.
Claude Code gives the text to the agent before its next action. Five runs with a stamp and three
lines of 2,000 characters (2,219 characters in all): in each run Claude Code's own record holds
one entry for what the hook added, that entry is the whole text once, and the agent's next command
named the three made-up words from its start, middle and end. Nothing about it is shown on screen.

Other forms, one run each: `{"decision":"block","reason":…}` hands the text over too, but shows
"PostToolUse:Bash hook returned blocking error" with the whole text on screen; exit code 2 with
the text on standard error does the same and shows the hook's own command line as well;
`systemMessage` shows the text on screen ("PostToolUse:Bash says: …") and does not reach the
agent; plain standard output reaches neither the agent nor the screen.

**Size.** 9,219 characters arrived whole. At 12,219 and at 30,219 Claude Code gave the agent the
first 2 KB with the path of a file in its own profile that holds the whole text ("Output too
large … Full output saved to …"); in both runs the agent read that file with its shell tool and
named all three words. A message is at most 2,000 characters plus its stamp, far below that.

**Time.** With `timeout: 5` on the hook entry, a hook that took 3.0 s and one that took 4.5 s
still handed the text over; at 7 s Claude Code cancelled the hook, the agent got nothing and went
on. BMN bounds what it adds to an event for a message to 300 ms.

**Which conversation an event belongs to.** The event carries `session_id`, `transcript_path`
(the record Claude Code keeps), `cwd`, `permission_mode`, `prompt_id`, `effort`, `scratchpad_dir`,
`tool_name`, `tool_input`, `tool_response`, `tool_use_id` and `duration_ms`. A sub-agent's events
add `agent_id` and `agent_type` and keep the parent's `session_id` and, unlike Codex, the parent's
`transcript_path` too: only `agent_id` tells them from the main conversation's. The `PostToolUse`
of the tool call that started the sub-agent belongs to the main conversation. After each turn
Claude Code also sent one `SubagentStop` with an `agent_id` and an empty `agent_type`, in runs
that started no sub-agent; no tool event carried such an id. An agent another agent started
(`claude -p` from the typed agent's shell tool) has its own `session_id`, the same BMN token and
no terminal, which is how BMN's process rule already tells it from the agent typed into the
session.

**Where the agent sends work.** The prompt guard's resolver answered on every `PostToolUse` event
of the main conversation (51 events, provider Anthropic, slowest 89 ms). It answered on the
sub-agent's event as well, because that event names the parent's record: the `agent_id` on the
event, not the resolver, keeps a message from a sub-agent. For the started agent it stopped at the
process. Neither gets a message.

**Version.** No event names the app's version. `/proc/<agent pid>/exe --version` answers
`2.1.296 (Claude Code)` in 14 to 23 ms; lines of the record the event names carry it
(`"version":"2.1.296"`), and the hook's environment held `AI_AGENT=claude-code_2-1-296_harness`.
BMN does not ask per event: `bmn hooks check` and Messages name the version this page was
measured on.

**Running `bmn` from Claude Code's own shell tool.** In the isolated profile `bmn list` ran from
the Bash tool and listed its own session; no sandbox stood in its way and nothing waited for the
owner. The same was observed 2026-10-13 in the owner's own profile: an agent typed into a BMN
session ran `bmn list --json` from its shell tool; it answered with exit code 0 and listed that
agent's own session and no other, and the owner was asked nothing.

**A real message, end to end.** Measured 2026-10-13 on the build that hands messages to Claude
Code (`b941348`), in the same isolated profile, with nothing standing in for BMN or for Claude
Code. A second session of the workspace ran `bmn peers` and `bmn tell <id> --text-file -` in its
shell with a made-up text of 2,000 characters in three lines. BMN stored it as *waiting* under
its own stamp. Claude Code, typed into the first session, was then asked to run three commands.
After the first, BMN's hook printed the message; Claude Code's next command named the three marked
words of the text; its own record of the conversation holds one entry added by a hook, the whole
stamped text once; and Messages read *printed for the agent*. Two runs of two.

## What BMN does with this

- The hooks of Claude Code and Codex hand a message over, on `PostToolUse`, one message per event,
  and only to the agent typed into the session, on an event of its main conversation: an event
  that carries `agent_id` is a sub-agent's and gets nothing.
- The hook resolves where its agent sends work with the prompt guard's own resolver for that
  event. No answer, or an answer that is only the owner's word, means no hand-over.
- An app that changes where it sends work without its launch or settings changing is not
  noticed, as for the [prompt guard](agent-control.md#the-prompt-guard).
- A new version of an app is not measured by itself. The table names the version; after an
  update the hand-over is unproven until this page is measured again.
