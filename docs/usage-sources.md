# Usage sources: where each agent reports plan use

BMN shows how much of a subscription plan's windows an agent has used, and when each window resets
(Epic 37). It reads only what the agents already write on this machine: no account, no network call,
no cost estimate. This page records, per agent version, where that number comes from, its fields
and units, how fresh it is, and what reading it costs. Code follows this table: an agent without a
**VERIFIED** plan source reads "not reported" in BMN.

Measured 2026-09-28 (Story 37.1) against Claude Code 2.1.283 (the owner's Max plan, and `claude glm`
with Z.ai), codex-cli 0.157.1, OpenCode 1.18.32 and the Cursor agent 2026.09.26-dd393fe. Only
structure, units and timing were kept, never the owner's values. Raw receipts are under
`.dev-auto/evidence/epic-37/` (not committed). The file names are given below.

## Source matrix

| | Claude Code 2.1.283 | `claude glm` | Codex 0.157.1 | OpenCode 1.18.32 | Cursor 2026.09.26 |
| --- | --- | --- | --- | --- | --- |
| Plan windows | **VERIFIED** status-line input | **UNSUPPORTED**: no `rate_limits` | **VERIFIED** session file `token_count` lines | **UNSUPPORTED**: no local field | **UNSUPPORTED**: network only |
| Context use | **VERIFIED** status-line input | **VERIFIED** status-line input | **UNSUPPORTED** (not in the approved fields) | **UNSUPPORTED** | **UNSUPPORTED** (not driven) |
| Needs transcript content | no | no | the `token_count` lines only | — | — |
| Needs a network call | no | no | no | — | yes, so BMN does not |
| Needs a configuration change | yes: `bmn statusline install` | the same line | no | — | — |
| **Chosen source** | status line | context use only; plan not reported | session file | not reported | not reported |

## Claude Code 2.1.283

- **Source.** Claude Code runs the `statusLine` command in `settings.json` and writes a JSON object
  to its standard input on every refresh. The command runs as `/bin/sh -c <command>` (dash on this
  machine), not in the owner's login shell. Receipt: `claude-statusline/shell-probe.txt`.
- **Fields and units.** `rate_limits.five_hour` and `rate_limits.seven_day`, each
  `{ used_percentage: integer 0–100, resets_at: integer epoch seconds }`, and
  `context_window.used_percentage` (integer). BMN reads these and nothing else. Receipt:
  `claude-statusline/shapes-claude-max-2.1.283.jsonl` (one "Reply with just OK" Haiku turn, shapes
  and range checks only).
- **Freshness.** Every status-line refresh. `rate_limits` is absent before the first reply of a
  session, and on plans without windows (an API key); such a refresh reports nothing.
- **Wrapper.** `bmn statusline install` puts one shell line in front of the owner's own command and
  keeps the command itself unchanged. Inside a BMN session, and only when `bmn` is on `PATH`, that
  line saves the input to a temporary file and opens it twice. It then removes the file, starts
  `bmn statusline report` in the background on one copy, and runs the owner's command on the other
  with the same standard input. If the copy fails part-way (a full disk), the owner's command gets
  every byte that was read, the file is still removed, and nothing is reported. Anywhere else it
  does nothing. The report sends `usage.report` with
  only the windows (as minutes, percent and reset time) and the context share.
  - Measured with a fake original command that reads its input, writes to stdout and stderr, and
    exits with code 4. Its stdout, stderr and exit code were byte-identical inside BMN, outside BMN,
    and with `bmn` missing from `PATH`, so a failing original fails the same way.
  - Added delay with the shipped line: p50 6.0 ms inside BMN (target at most 50 ms), and nothing
    measurable outside it. Every one of 41 timed runs reached the stand-in socket, and no
    temporary file was left.
  - Receipts: `wrapper/wrapper-timing.txt`, `wrapper/wrapper-timing.py`, `wrapper/fake-socket.py`.
    An earlier design, in which a Node runner ran the original, added 87 ms and was dropped
    (`wrapper/wrapper-timing-no-socket.txt`).
- **Live check.** A settings file was wrapped by the shipped `bmn statusline install`, then Claude
  Code 2.1.283 ran one Haiku turn with it against a stand-in control socket. The owner's line showed
  on all three refreshes, and the one refresh carrying `rate_limits` produced one valid report: windows
  of 300 and 10 080 minutes and a context share. Receipts:
  `wrapper/live3-claude-2.1.283-original-shapes.jsonl` and
  `wrapper/live3-claude-2.1.283-socket-shapes.jsonl` (structure and range checks only).
- **Limit.** The wrapper needs a status-line command to wrap. `install` leaves a file without one
  untouched and says so, as it does a command that already runs `bmn statusline report` in a form
  this `bmn` did not write.

## `claude glm` (Claude Code 2.1.283 against Z.ai)

Same status-line input, from its own `CLAUDE_CONFIG_DIR`. After a reply, `rate_limits` is absent and
`context_window.used_percentage` is an integer (receipt:
`claude-statusline/shapes-claude-glm-2.1.283.jsonl`). BMN keeps the context share for that session
and never lets such a reading replace Claude's plan reading.

## Codex 0.157.1

- **Source.** The conversation's own session file,
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<conversation>.jsonl`. BMN finds it the way Resume
  does: through the conversation the session is bound to.
- **Fields and units.** Lines with `type: "event_msg"` whose `payload.type` is `"token_count"` carry
  `payload.rate_limits.primary` and `.secondary`: `{ used_percent: float 0–100, window_minutes:
  integer, resets_at: integer epoch seconds }`. `secondary` may be null; the owner's plan reports only
  a primary window of 10 080 minutes (a week). Receipt:
  `codex-reader/token-count-shape-codex-0.157.1.json`.
- **What is read.** Under the owner's decision (Epic 37, narrowing Epic 21), BMN reads the file
  backwards from the end in 64 KiB steps. It stops at the first `token_count` line or after 256 KiB,
  and keeps only the two windows. A line is parsed only if it contains the text `"token_count"`;
  token totals, credits and the conversation are never kept.
- **Freshness.** Codex writes a `token_count` line after each model reply. BMN reads it on the
  session's Codex hook events, at most every 15 s and always after a finished turn (`Stop`), and when
  Session details opens.
- **Size and time.** On the owner's machine there were 887 rollout files: p50 0.85 MB, p90 4.1 MB,
  p99 25 MB, largest 63 MB. 53 of the 60 newest had a `token_count` line within 256 KiB of the end;
  the other 7 were ~20 KB files without one. The shipped reader:
  - synthetic 50 MB file with the line near the end: p50 0.32 ms;
  - synthetic 50 MB file with no line within 256 KiB: p50 1.45 ms, gives up;
  - the owner's newest real file (0.67 MB): p50 0.29 ms.

  Receipts: `codex-reader/reader-timing.json` (41 runs each, low machine load) and
  `codex-reader/reader-timing.timing.ts`; the file
  counts are in `.dev-auto/log.md`, 2026-09-28.

## OpenCode 1.18.32

No plan-window fields: the binary has no `five_hour`, `seven_day`, `used_percent`, `window_minutes` or
`resets_at` strings. Only provider rate-limit headers, retry errors and a "Go limit reached" message
appear. Receipt: `other-agents/opencode-1.18.32-strings.txt`. **Not reported.**

## Cursor agent 2026.09.26-dd393fe

The status-line input names the model, workspace, token totals and `context_window`, but no plan
window (receipt: `other-agents/cursor-2026.09.26-bundle.txt`). Plan use exists only behind network
calls (`GetCurrentPeriodUsage`, `GetPlanInfo`, `GetHardLimit`), and BMN makes none. **Not reported.**
Its context share was not driven, so it is not read.

## How BMN uses this

- **Session details → Plan use.** Each window of the session's latest reading shows its used share
  and reset time, then the source and read time; context use is its own line. A window past its
  reset is marked stale with the reading's time. Readings live in memory only, so after a restart
  the row says "No reading yet" until the agent reports again.
- **Palette → Plan use….** A read-only dialog with the latest plan reading per agent across all
  sessions, because a plan belongs to the account. `claude glm`, OpenCode and Cursor read "Not
  reported by …".
- **Notice at 90%.** When a window reaches 90% (the whole percent shown), BMN opens one **Needs you**
  notice for that agent and window, for example "Codex weekly limit at 91% · resets Fri 09:00". It
  opens once per reset period, expires by itself when the window resets, and reaches Telegram only
  by the pager's rule for notices.
