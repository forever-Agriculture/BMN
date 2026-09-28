# Agent history

One BMN setting, **Preferences → History → Keep agent history** (7, 30 or 90 days, or Never; default 30), decides how long every agent keeps a session nobody has touched. Each agent deletes by its own mechanism: Claude Code (and `claude glm`) through its own `cleanupPeriodDays` setting, Codex and OpenCode through their own delete commands, run by BMN. "Untouched" always means **last activity**, never creation time.

Nothing is written or deleted until the owner presses **Start cleanup** once. That press writes every Claude folder that differs and starts the first Codex/OpenCode run. Later, a longer limit or Never applies at once; a shorter one asks again with new counts. A Claude folder learned since, or one whose value was edited by hand, is never rewritten silently: it shows `now → next` and waits for the next Start cleanup. A learned folder that already holds the limit is listed as pending too, and follows later changes only once the owner has confirmed it. While anything waits, the Preferences button carries the one attention dot.

BMN's own **Delete archived sessions and workspaces** keeps its meaning and sits in the same section.

## Claude Code and GLM

BMN writes `cleanupPeriodDays` into each Claude config folder's `settings.json` and nothing else: other keys keep their values and order, the file keeps its indent, a copy is kept at `settings.json.bmn-backup-<ISO time>`, and a file that changed between BMN's read and its write is left alone (`REVISION_CONFLICT`). An unparsable file is skipped and named on its row. The writer is `apps/desktop/bin/safe-config-write.mjs`, the same code `bmn hooks install` uses.

Folders: `~/.claude` is always listed. Every Claude hook call carries `claudeConfigDir`, resolved exactly as `bmn hooks install` resolves the hook file (`CLAUDE_CONFIG_DIR`, relative to the working directory, `..` kept as written; else `~/.claude`), so a `claude glm` session teaches BMN its own folder. BMN remembers up to 8 learned folders that hold a `settings.json`, oldest dropped first.

What the value means, from Claude Code 2.1.283's own settings schema (`strings ~/.local/share/claude/versions/2.1.283 | grep cleanupPeriodDays`, read 2026-09-28):

- `cleanupPeriodDays: int().positive().optional()` — "Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1. Use a large value for long retention; use --no-session-persistence to disable transcript writes entirely."
- On `0`: "cleanupPeriodDays must be at least 1. … (0 is rejected because it previously silently disabled all transcript writes, which users setting it to mean "never clean up" …)". **BMN never writes 0**; Never writes `36500` (100 years), and a unit test proves `0` cannot be written.
- A settings file Claude cannot parse pauses its cleanup: "Transcript retention cleanup is paused until the settings errors above are fixed".

Claude deletes at its own next start. BMN claims only that the setting is written; Claude's deletion is the agent's behaviour and stays UNVERIFIED here.

## Codex and OpenCode

A run starts 30 s after BMN starts (after the archive purge, in the background; no launch waits for it) and every 24 hours while BMN runs, only with a confirmed limit. Per agent it deletes candidates oldest first, one command at a time, at most 200 per run (the rest next run). A failed delete is recorded on the agent's row and not retried that run. Quitting BMN stops between deletions; the next run finds what is left. One summary line goes to the host log: `[BMN] agent history (30 days): codex deleted 200, 0 failed, 212 next run`.

A session is never deleted when it is bound to a running BMN session or to a Resume or start BMN has under way, was active within the last 24 hours, or its id appears on any running process's command line (the spike below shows OpenCode does not refuse deleting a live session). These are checked again just before each delete (BMN's live sessions and running command lines first, the agent's store last), so a session resumed, used or started during a long batch is kept; while BMN checks and deletes a session, its own Resume of that conversation is refused ("try again in a moment"). A Resume holds its conversation before it looks for that mark, and cleanup marks a session before it reads what BMN holds, so whichever comes first, the other stands back. What remains is a process outside BMN opening a session untouched for longer than the limit within the moment of its delete: Codex's own lock refuses that delete, OpenCode's does not. BMN opens agent databases read-only and never writes them or removes a transcript file.

| Agent | Reads (read-only) | Last activity | Deletes with |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/state_5.sqlite` (default `~/.codex`), `threads.id` | `threads.updated_at` (epoch s), archived or not | `codex delete --force <uuid>` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share`), `session.id`, every project | `session.time_updated` (epoch ms) | `opencode session delete <id> --pure` |

Cursor's terminal agent keeps its chats under `~/.cursor/chats/` and has no command to delete one (measured on 2026.09.26-dd393fe, [agent-control.md](agent-control.md#cursors-terminal-agent)), so its row reads "keeps its own history · not managed by BMN" whenever `cursor-agent` is on PATH or that folder exists, and no run touches it.

A missing binary or store hides the agent's row (BMN has never seen it). A table without the expected columns reads "not recognised: reason" and deletes nothing.

## Spike (Story 31.2 AC1), 2026-09-27

Disposable stores only: a scratch `CODEX_HOME`, and scratch `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` for OpenCode, with `BMN_*`/`AITERM_*` unset. No authentication file was read or copied: Codex threads were created by unauthenticated `codex exec` runs (each records a thread and then fails with 401); OpenCode ran its free model. Receipts: `.dev-auto/log.md`, entries of 2026-09-27 ~22:50–23:00 EEST.

| Question | Result | Evidence |
| --- | --- | --- |
| Codex `updated_at` advances on a turn of a resumed thread | VERIFIED | `codex exec resume <id> "again"`: `updated_at` 1790538366 → 1790538435 |
| `codex delete <uuid>` without a terminal | VERIFIED: refuses | rc 1, "cannot confirm session deletion without an interactive terminal; rerun with --force and a session UUID" |
| `codex delete --force <uuid>` | VERIFIED | rc 0 "Deleted session <uuid>.", 0.12 s; `threads` row and rollout file gone |
| Deleting it again / an unknown uuid | VERIFIED | rc 1 "failed to delete session" / rc 1 "No active or archived session found matching …" |
| `codex delete` while an idle `codex app-server` runs on the same home | VERIFIED: works | rc 0 |
| `codex delete` of a thread a live process outside BMN holds | VERIFIED: refused | while `codex exec resume <id>` ran (`thread-writer-locks/<id>.lock`): rc 1 "failed to delete session", row and file kept; after the process exited, rc 0 |
| `opencode session delete <id>` from outside the session's project | VERIFIED: works | from a non-project directory: rc 0 "Session … deleted", 1.32 s; `session` row gone |
| `opencode session delete <id> --pure` | VERIFIED: works | rc 0; `--pure` keeps the owner's plugins (BMN's included) out of the delete |
| `opencode session delete` of a session a live process holds | VERIFIED: **not refused** | during `opencode run --session <id>`: delete rc 0; the live process then failed (rc 1, UnknownError after an insert into `part` for the deleted session); a next `opencode run --session <id>` → "Session not found". Hence the 24 h and command-line skips. |
| OpenCode `time_updated` advances on a turn | VERIFIED | …488439 → …708088 during the live turn |
| Reading a store the agent is writing (WAL) | VERIFIED: `mode=ro` | `file:…?mode=ro` read the current rows; `immutable=1` answered "no such table: threads" because the rows were still in the WAL. BMN opens with better-sqlite3 `readonly: true` (the same SQLite read-only mode). |

The OpenCode "live process" case covers `opencode run --session`; an OpenCode TUI left open on a session older than the limit, started without the id on its command line, is not detected. The 24-hour skip does not help there, because such a session is older than 7 days by definition. Residual risk, stated rather than hidden.
