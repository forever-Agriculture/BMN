# Turn changes: how a work tree is captured, and where a turn's ends are proven

BMN can record what differs in a Git work tree between the moment the owner sends a prompt and
the moment the agent's turn ends. This page holds the measurements that feature is built on
(Story 69.1): how BMN copies a work tree without touching it or running anything it names, what
that costs, and, per app and version, whether the app waits for its prompt hook before it acts
and which events mark the ends of a turn. BMN records turns only for an app and version that
holds PASS in the table below.

Measured 2026-10-13 on Linux (Ryzen 5 4600H, 12 threads, ext4, Git 2.53.0, Node 24.14.0) with
the installed apps, each in a throwaway profile inside an isolated BMN built from `cff5032`, in
made-up Git folders with made-up text. The model was a stand-in on this computer: no provider
was called and no sign-in file was read, linked or copied. The scripts and raw records are kept
under `_bmad-output/planning-artifacts/reference-69-turn-changes/` (not committed).

## Result

"Waits for its prompt hook" is PASS when, in every one of fifteen runs, the app asked its model,
wrote and ran a tool only after the held hook let go. Every other row is PASS when the app's
events tell that case from the others, so that a turn's record can say what happened; FAIL means
they do not, or that the case could not be produced. The sections below hold each sequence.

| App and version | Question | Result | Measured |
| --- | --- | --- | --- |
| Claude Code 2.1.296 | Waits for its prompt hook | PASS | 15 of 15 runs. After the hook let go, the first request to the model came 38 to 110 ms later, the first write 120 to 220 ms, the first tool event 100 to 192 ms. Nothing changed in the folder while it held |
| Claude Code 2.1.296 | When its prompt event arrives | PASS | No turn running: before the model is asked; the hook starts 40 to 93 ms after Enter. Typed while a turn runs: when it is typed (57 and 58 ms after Enter), with the running turn's id |
| Claude Code 2.1.296 | A turn that ends by itself | PASS | `Stop`, 196 to 333 ms after the last write |
| Claude Code 2.1.296 | His interrupt | FAIL: no event | Nothing arrives, whether the model is awaited or a command runs. The next prompt's event carries a new turn id |
| Claude Code 2.1.296 | A stop the app continues by itself | PASS | `Stop` lists work in flight; when that work ends a prompt event that begins `<task-notification>` comes, then the last `Stop` |
| Claude Code 2.1.296 | A stop hook that sends the agent back | PASS | Tool events with the same turn id, then a second `Stop` with `stop_hook_active` |
| Claude Code 2.1.296 | A compaction inside a turn | PASS | `PreCompact`, `SessionStart` with source `compact`, `PostCompact`; same conversation and turn id; the turn goes on to one `Stop` |
| Claude Code 2.1.296 | `/clear` and `/resume` | PASS | `SessionEnd` with the reason, then `SessionStart` with the source and the other conversation, 100 to 130 ms later |
| Claude Code 2.1.296 | A second agent typed into the same shell | PASS | After `/exit`: `SessionEnd`, then the new process's `SessionStart`. After Ctrl+Z: no event from the sleeping agent; the other agent's events come from its own process |
| Claude Code 2.1.296 | A sub-agent's writes | PASS | Its events carry `agent_id`. The main `Stop` came 9 ms after the sub-agent's write and lists it in flight; `SubagentStop` and a `<task-notification>` prompt event follow |
| Claude Code 2.1.296 | A background task that writes after the last stop | PASS | `Stop` lists it in flight; it wrote 4.7 s later; the `<task-notification>` prompt event came 103 ms after the write, then the last `Stop` |
| Codex 0.162.1 | Waits for its prompt hook | PASS | 15 of 15 runs. After the hook let go, the first request to the model came 34 to 56 ms later, the first write 169 to 241 ms, the first tool event 78 to 121 ms. Nothing changed in the folder while it held |
| Codex 0.162.1 | When its prompt event arrives | PASS | No turn running: before the model is asked; the hook starts 56 to 192 ms after Enter. Typed while a turn runs: when Codex takes the prompt into the running turn, with that turn's id (7.0 s after typing while the model was awaited, 61 ms while a command ran) |
| Codex 0.162.1 | A turn that ends by itself | PASS | `Stop`, 158 to 250 ms after the last write |
| Codex 0.162.1 | His interrupt | PASS | `Interrupt` with the turn's id, 55 and 57 ms after Escape; no `Stop` |
| Codex 0.162.1 | A stop the app continues by itself | FAIL: not seen | After a `Stop` the main agent sent nothing more in any run, also with a sub-agent still at work |
| Codex 0.162.1 | A stop hook that sends the agent back | PASS | Tool events with the same turn id, then a second `Stop` with `stop_hook_active` |
| Codex 0.162.1 | A compaction inside a turn | PASS | `PreCompact`, `PostCompact`, `SessionStart` with source `compact`; same conversation and turn id; the turn goes on to one `Stop` |
| Codex 0.162.1 | `/clear` and `/resume` | PASS | `/clear`: no event at the command; `SessionStart` with source `clear` and a new conversation comes 91 ms before the next prompt's event. `/resume`: `SessionEnd` when the conversation is picked, `SessionStart` with source `resume` at the next prompt |
| Codex 0.162.1 | A second agent typed into the same shell | PASS | After `/quit`: `SessionEnd`, sent twice; the new process's `SessionStart` comes with its first prompt. After Ctrl+Z: no event from the sleeping agent; the other agent's events come from its own process |
| Codex 0.162.1 | A sub-agent's writes | PASS | Its events carry `agent_id` and a turn id of its own, between `SubagentStart` and `SubagentStop`. A sub-agent nobody waited for wrote 4.4 s after the main `Stop`, which names nothing in flight |
| Codex 0.162.1 | A background task that writes after the last stop | FAIL: not seen | A command the agent left running wrote nothing in the 11 s after `Stop`, and no event came |
| OpenCode 1.19.0 | Waits for its prompt hook | FAIL | 0 of 15 runs on `session.status`, the event BMN's plugin gets. In the nine runs that measured anything the model was asked 867 to 3,911 ms before the hook let go, and in seven the write landed while it held |
| OpenCode 1.19.0 | When its prompt event arrives | FAIL | `session.status` comes 144 to 261 ms after Enter, when the model is already being asked |
| OpenCode 1.19.0 | Each kind of end | FAIL: not measured | Without a prompt event that holds there is no "before", so no turn is recorded. `session.idle` came 712 and 786 ms after the last write of a turn that ended by itself; the other ends were not measured |
| Cursor 2026.09.26 | Waits for its prompt hook | FAIL | It cannot be pointed at a stand-in: it speaks only to its own service and starts by exchanging a sign-in |

A PASS needs every run. An app without PASS in its first row is not recorded.

## The capture

### One mechanism: a plain store

BMN keeps its own copy: each file's bytes under BMN's data root, named by their SHA-256, with
one small list per folder (name, kind, hash, size, executable bit) and one record per capture.
Two captures are compared by BMN's own code, file by file and line by line. Git is asked three
things in the owner's repository and nothing else: whether it accepts the repository and which
work tree it names, which commit `HEAD` names, and which paths belong.

The other candidate was a Git store of BMN's own, fed with the bytes BMN read. It was not
chosen: it needs `hash-object`, `mktree` and `diff-tree` in a second repository (a longer list
of commands to pin), reads attributes from captured `.gitattributes` files while comparing, and
needs `gc` to remove bytes on time. The plain store removes a capture by removing files, and
does not depend on the repository's object format, so a SHA-256 repository, a split index and a
partial clone stay supported.

**How a read stays under the root.** BMN finds the root by its own walk: the nearest folder at
or above the agent's folder that holds a `.git`, with links resolved. It opens that folder once.
Every folder on the way to a file is then opened by name inside the folder already held, never
through a link (`/proc/self/fd/<held>/<name>` with `O_NOFOLLOW`), and the file the same way, as
a regular file only. No path from the top is resolved again, so a link or a folder swapped in
while the capture runs cannot lead anywhere: such an entry is "not read". When Git names another
work tree than the folder BMN found, the capture is refused.

**What belongs** is listed anew at every capture: every tracked path, ignored or not, and every
untracked path Git does not ignore. A link is stored as its text, the executable bit is stored,
and a submodule or nested repository is one entry with the commit Git reports for it.

**Only new bytes are read.** A file whose size, times, file number and device are what they
were when it was last read, and that had been still for a moment then, is not read again; a
folder in which nothing changed keeps its list.

### The Git commands, whole

Program: the first of `/usr/bin/git`, `/usr/local/bin/git`, `/bin/git` that exists; never
looked up on `PATH`.

Environment, whole: `PATH=/usr/bin:/bin`, `HOME` (the owner's, so his own ignore file and his
own `safe.directory` list count as in his terminal), `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`,
`GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_TRACE2=0`,
`GIT_TRACE2_EVENT=0`, `GIT_TRACE2_PERF=0`.

Before every command, which outranks every settings file, an included one too:

```
--no-pager --no-optional-locks --no-replace-objects --no-lazy-fetch --literal-pathspecs
-c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null
-c maintenance.auto=false -c gc.auto=0 -c protocol.allow=never -c submodule.recurse=false
-c core.pager=cat -c core.sshCommand=false -c credential.helper= -C <folder>
```

| Name | Command | Asked |
| --- | --- | --- |
| identity | `rev-parse --is-bare-repository --is-inside-work-tree --show-toplevel --absolute-git-dir --show-object-format HEAD^{commit}` | once, in the root, before anything is read: does Git accept the repository, which work tree does it name, which commit is `HEAD` |
| list | `ls-files -z -t --stage --cached --others --exclude-standard` | once, in the root: what belongs |
| head | `rev-parse --verify --quiet HEAD^{commit}` | once, in the root, at the scan's end |
| nested | `rev-parse --verify --quiet HEAD^{commit}` | once per submodule or nested repository, in it, with `GIT_CEILING_DIRECTORIES` set to the root |

No other Git command runs for this feature, none writes, and none runs with BMN's store as its
Git directory, because the store is not a Git repository. No command that reads a file's
contents runs in the owner's repository, so no filter, `core.fsmonitor`, hook, external diff or
textconv program can be reached. A repository Git refuses as unsafe stays refused.

### What was proven

`cases.mjs`, 42 checks, all PASS (`records/cases-20261013T170827`). Every comparison is checked
against made-up contents whose difference is known beforehand, never against `git diff`.

- **A hostile repository.** Its settings and attributes name a clean filter, a process filter,
  `core.fsmonitor` (also through an included settings file), a hooks folder with every hook, an
  external diff, a diff command, a textconv program, an alias, a pager, an editor, a credential
  helper, an SSH command and automatic maintenance, and it is a partial clone with a missing
  object; each program leaves a marker file. Two captures were taken with the settings file
  replaced in between. No marker exists afterwards. A trace of the whole run (`strace`: programs
  started, connections, files written) shows node and the Git commands above with exactly the
  options and environment above, no connection attempted, and no write under the repository at
  any moment. Two controls show the proof can fail: ordinary Git commands in a copy of that
  repository leave 14 markers, and a deliberate write, program and connection are each seen in
  a trace.
- **Nothing changed.** Before and after each capture the repository is equal: every file's
  bytes and mode, the index file's bytes, every ref, the settings, and the list of objects with
  sizes (162 paths). Access times are not part of the claim.
- **Self-contained.** After the repository is moved, and after it is deleted, the comparison
  and every file's difference still read whole from the store.
- **Read as expected:** a tracked file that becomes ignored (still covered, its change is
  read); an ignored file that becomes tracked ("entered what is covered", totals partial); a
  file captured while untracked and ignored later ("left what is covered"); a link; a change of
  the executable bit only ("mode only"); a binary file; a repository with no commit yet; a
  linked work tree; an LFS file, as its bytes in the folder or "too large, not read"; a
  submodule and a nested repository, one entry each.
- **Refused or marked, before a byte is written to the store:** a link replaced between listing
  and reading by one that points outside the root, and a folder higher on the path replaced the
  same way ("not read"); a repository whose settings point its work tree elsewhere; the root
  replaced while it is being established; a work tree that holds BMN's data folder; a
  repository Git refuses as unsafe; a sparse checkout (each "not supported here"); a folder a
  caller names outside the root ("unavailable").
- **Supported, though they were allowed to end as "not supported here":** a split index, a
  SHA-256 repository, a partial clone. None of the three is refused.

"Added" and "removed" are said only where BMN can show it: a path new to a capture is "added"
when Linux says the file was made after the earlier scan began, and a path that is gone is
"removed" when nothing has that name any more. Otherwise it "entered" or "left what is covered",
adds no lines and makes the totals partial.

### What a capture costs

`timing.mjs` (`records/timing-20261013T171345`). Cold: an empty store, scans of at most 2 s
each until one is whole (the files may be in Linux's own cache). Warm: twenty prompts, each
asked by a stand-in hook over a socket with 300 ms for everything (waiting, listing, reading,
the answer and its confirmation), each compared with the one before. Cancel: ten captures, each
cancelled at another moment.

| Work tree | Cold | Warm: whole and confirmed inside 300 ms | Prompt delay | Read and stored per warm scan | Comparison | Cancel answered |
| --- | --- | --- | --- | --- | --- | --- |
| This repository (629 entries, 9 MiB) | 103 ms, whole | 20 of 20 | median 25 ms, longest 37 ms | 0 bytes read, 0.6 KiB stored | under 1 ms | 2 ms at most |
| The repository the owner named (6,344 entries, 426 MiB) | five scans: four end "incomplete: 100 MiB read" (311 to 821 ms), the fifth is whole (343 ms) | 20 of 20 | median 94 ms, longest 119 ms | 0 bytes read, 0.6 KiB stored | under 1 ms | 6 ms at most |
| Made-up, 20,000 files | 1,368 ms, whole | 20 of 20 | median 158 ms, longest 182 ms | 5 KiB read, 17 KiB stored (12 files changed) | median 0.3 ms, longest 1.3 ms | 7 ms at most |
| Made-up, 100,000 files | every scan "incomplete: 20,000 entries" in about 220 ms; nothing is kept | 0 of 20: never whole, answered in at most 252 ms | does not apply | nothing | unavailable | 3 ms at most |
| Made-up, with a 2 GB untracked folder that is not ignored | ten scans "incomplete: 100 MiB read", then "incomplete: store full" at 1 GiB | 0 of 20: never whole, answered in at most 140 ms | does not apply | nothing once full | unavailable | 1 ms at most |

- **Where the warm time goes** (20,000 files, medians): Git's listing with one look at each
  file 119 ms, establishing the root 14 ms, `HEAD` at the end 16 ms, everything else 4 ms.
- **A cancel** is answered within 7 ms in every one of 42 cancelled captures and leaves no lock
  in the repository, no capture and nothing under `staging/`. The cancelled bytes are moved out
  of `staging/` in that same moment and unlinked right after; that took up to 0.8 s for 20,000
  small files.
- **Terminal output.** Limit stated before measuring: captures running back to back may add at
  most 50 ms to the 99th percentile of how old a line printed every 10 ms is when the terminal
  shows it, and at most 100 ms to the longest standstill. Measured in an isolated BMN: quiet
  7 ms and 21 ms; while 15 captures of the 20,000-file tree ran, 6 ms and 20 ms. Inside the
  limit.
- **Limits a big work tree meets.** A first capture reads at most 100 MiB, so a work tree with
  426 MiB of covered files is whole only at its fifth scan; until then a turn there reads
  "Incomplete: 100 MiB read". A work tree with more than 20,000 covered entries, or one that
  would pass 1 GiB in the store, is never whole.

### In the app

The app runs this mechanism from `apps/desktop/src/utility/turn-changes-*.ts`: the Git commands
(`turn-changes-git.ts`, the only file of the feature that starts a process), the store, the
capture, the comparison, and an engine that runs in a worker thread of its own
(`turn-changes-worker.ts`), so that no scan and no comparison runs on the thread that keeps
terminals flowing. Its tests repeat what this page proves on made-up repositories at every run of
`pnpm run test:unit`, the hostile repository under its trace included
(`turn-changes-hostile.test.ts`; it needs `strace` and fails, never passes over, where it cannot
trace). The app differs from the measured script in three places, each the stricter way:

- A bare repository reads "not supported here: a bare repository"; the script said
  "unavailable".
- The 2 s limit holds for every capture, the first one too, and a listing cut short by it keeps
  nothing.
- A path that is only in the later capture is "added" when the file was born at least 1 ms after
  the earlier scan began; a file born in that very millisecond reads "entered what is covered".

### How long a copy stays

The copies are real files' bytes, secrets included, under `<data root>/turn-changes/<session>/`,
one folder per work tree, in private folders. BMN's database lists every capture and every turn
(schema version 27: `turn_capture`, `turn_record`, `turn_capture_reference`, `turn_removal_job`;
no row holds a file's name or content).

- **A turn** is kept as many days after its end as the confirmed Keep agent history setting says
  (after its start when it has no end). Never, or no confirmed limit, keeps every turn; a shorter
  limit that was picked but not confirmed does not apply. A turn whose time has passed is removed
  whole.
- **A capture** stays while a kept turn refers to it, so a scan two turns share goes only when the
  second has gone. With it goes every stored byte that no remaining capture needs.
- **The sweep** runs when BMN starts and every hour. Rows are deleted in one transaction together
  with a job that names their bytes; the bytes are removed after that, and the job is cleared when
  they are gone. A crash in between, or a removal that fails, leaves the job, and the next sweep
  tries again; meanwhile that session reads "Removal pending".
- **A deleted session** takes its turns and captures in the deleting transaction, with one job for
  its whole folder.
- **At a start**, what a crash left of a capture that was never published is removed. A published
  capture that no row names, as after a database restore, is left until it is older than the keep
  limit by the time written in its own record, and is then removed.
- **Space.** One session's stores hold at most 1 GiB and all stores 5 GiB, counted as the bytes of
  files and folder lists on disk; two sessions in one repository each count their own copy. A
  capture that would pass either ends "incomplete: store full". Nothing is removed before its time
  to make room, and nothing outside `<data root>/turn-changes/` is touched.

## The apps

### How the test works

The app runs in a terminal of an isolated BMN, in a made-up Git folder, with BMN's own hooks
installed by `bmn hooks install` and one more hook entry beside them that records every event
and can hold the prompt event. Its model is `standin-model.mjs` on this computer, which answers
at once with scripted tool calls and records when each request arrived. The same program is
named as the app's proxy, so any other host an app tries is recorded by name and refused:
Claude Code tried none; Codex tried `github.com`, `api.github.com`,
`raw.githubusercontent.com`, `chatgpt.com` and `ab.chatgpt.com` at start; OpenCode tried
`models.opencode.ai` and `registry.npmjs.org`.

**Waiting.** A prompt is typed; the hook holds the prompt event until the test lets it go,
after 1, 2 and 4 s, five runs each. A run passes when the stand-in's first request, the first
file made in the folder, the first change in the folder and the first tool event all come after
the release, nothing changed in the folder while the hook held, and the turn then ended. Before
each app's runs two controls go through the same test: a made-up agent that waits for its hook
passed 6 of 6, and one that does not wait failed 6 of 6, in every record.

**Ends.** Each case below was produced once in a kept record; the times are milliseconds after
Enter. A write's time is the moment Linux says the file was made.

### Claude Code 2.1.296

Records: `records/edges/claude-2.1.296/` (`waiting-20261013T173818`, `edges-20261013T175435`,
`edges-20261013T180230`, `edges-20261013T181947`, `edges-20261013T182120`).

- **What an event names.** The conversation is `session_id`, the turn is `prompt_id`, the
  folder is `cwd`. The prompt event, every tool event and every `Stop` of one turn carry the
  same `prompt_id`. A sub-agent's events carry `agent_id` and the `prompt_id` of the turn that
  started it.
- **A turn that ends by itself:** `UserPromptSubmit` at 81, `PreToolUse` 337, the write 388,
  `PostToolUse` 444, `Stop` 671.
- **His interrupt:** no event, neither while the model is awaited nor while a command runs. The
  next prompt's `UserPromptSubmit` carries a new `prompt_id`. Interrupted before any answer,
  Claude Code puts the prompt back into its input line.
- **A prompt typed while a turn runs:** its `UserPromptSubmit` comes when it is typed, 57 ms
  after Enter while the model was awaited and 58 ms while a command ran, and carries the
  running turn's `prompt_id`. The prompt joins that turn, which ends with one `Stop`.
- **A stop the app continues by itself:** `Stop` whose `background_tasks` is not empty. When
  the work ends, a `UserPromptSubmit` whose prompt begins `<task-notification>` arrives with a
  new `prompt_id`, and a `Stop` with nothing in flight closes it.
- **A stop hook that sends the agent back:** `Stop` at 575, tool events with the same
  `prompt_id`, a second write, and a second `Stop` at 1,205 with `stop_hook_active` true.
- **A compaction inside a turn** (automatic): `PreCompact` with trigger `auto`, a `SubagentStop`
  of an unnamed helper that had no `SubagentStart`, `SessionStart` with source `compact`,
  `PostCompact`; the conversation and the `prompt_id` stay, the turn goes on and ends with one
  `Stop`. A compaction he asks for with `/compact` was not measured.
- **`/clear`:** `SessionEnd` with reason `clear`, and 129 ms later `SessionStart` with source
  `clear` and a new conversation. **`/resume`:** `SessionEnd` with reason `resume`, and 100 ms
  later `SessionStart` with source `resume` and the resumed conversation.
- **A second agent typed into the same shell.** After `/exit`: `SessionEnd` with reason
  `prompt_input_exit`; the new process sends `SessionStart` with source `startup` from another
  process id. After Ctrl+Z: no event; the other agent's events come from its own process,
  while the sleeping Claude Code stays a process that is no longer in the terminal's
  foreground.
- **A sub-agent's writes.** The `Agent` tool returns at once and the sub-agent works on:
  `SubagentStart`, its tool events with `agent_id`, `SubagentStop`. The main `Stop` came while
  it still worked (9 ms after its write in one record, 4.3 s before it in another) and lists it
  in `background_tasks`; after `SubagentStop` the `<task-notification>` prompt event and the
  last `Stop` follow.
- **A background task that writes after the last stop:** `Stop` at 616 with one task in flight,
  the write at 5,312, the `<task-notification>` prompt event at 5,415, `Stop` at 5,581.
- **The folder.** `cwd` equals the folder Linux reports for the terminal's foreground process,
  with one exception. After the agent's shell ran `cd` into a folder below, a `CwdChanged`
  event came, and that command's `PostToolUse` and every later event name that folder, in
  later turns too, while Linux still reports the folder the agent was started in. Both lie in
  the same root.
- **Twice or not at all.** No event came twice. None came for an interrupt and for Ctrl+Z.
- **Reading the version.** Running the agent's own program (`/proc/<its process>/exe`) with
  `--version` answers `2.1.296 (Claude Code)` in 13 to 21 ms. Reading where that link points
  takes 7 to 26 millionths of a second, and the target's last folder is the version
  (`~/.local/share/claude/versions/2.1.296`).

### Codex 0.162.1

Records: `records/edges/codex-0.162.1/` (`waiting-20261013T174527`, `edges-20261013T175759`,
`edges-20261013T180246`, `edges-20261013T182058`). Codex ran with approval `never` and the
`workspace-write` sandbox.

- **What an event names.** The conversation is `session_id`, the turn is `turn_id`, the folder
  is `cwd`. A sub-agent's events carry `agent_id`, the main conversation's `session_id` and a
  `turn_id` of their own.
- **`SessionStart` comes with the first prompt**, 78 to 113 ms before that prompt's event, not
  when Codex starts.
- **A turn that ends by itself:** `UserPromptSubmit` at 236, `PreToolUse` 418, the write 582,
  `PostToolUse` 642, `Stop` 796.
- **His interrupt:** `Interrupt` with the turn's `turn_id`, 57 ms after Escape while the model
  was awaited and 55 ms while a command ran. No `Stop` follows.
- **A prompt typed while a turn runs:** its `UserPromptSubmit` carries the running turn's
  `turn_id` and comes when Codex takes the prompt into that turn. While the model was awaited
  that was 7.0 s after typing, when the answer returned, and that answer's write was dropped.
  While a command ran it was 61 ms after typing: the command was cut short and sent no
  `PostToolUse`. The turn ends with one `Stop`.
- **A stop the app continues by itself:** not seen. After a `Stop` the main agent sent nothing
  in any run, and its `Stop` names nothing in flight.
- **A stop hook that sends the agent back:** `Stop` at 581, tool events with the same
  `turn_id`, a second write, a second `Stop` at 1,144 with `stop_hook_active` true.
- **A compaction inside a turn** (automatic): `PreCompact` with trigger `auto`, `PostCompact`,
  `SessionStart` with source `compact`; the conversation and the `turn_id` stay, the turn goes
  on and ends with one `Stop`. A compaction he asks for was not measured.
- **`/clear`:** no event at the command. `SessionStart` with source `clear` and a new
  conversation comes 91 ms before the next prompt's event. **`/resume`** of another
  conversation: `SessionEnd` with reason `other` when it is picked; `SessionStart` with source
  `resume` comes with the next prompt.
- **A second agent typed into the same shell.** After `/quit`: `SessionEnd` with reason
  `other`, sent twice in the same millisecond. After Ctrl+Z: no event; the other agent's events
  come from its own process.
- **A sub-agent's writes.** `SubagentStart`, its tool events, `SubagentStop`. When the main
  agent waited for it, the sub-agent wrote before the main `Stop`. When it did not, the main
  `Stop` came at 486, the sub-agent wrote at 4,909 and `SubagentStop` came at 5,065; nothing
  from the main agent followed.
- **A background task that writes after the last stop:** not seen. A command the agent left
  running (`setsid sh -c '…' &`) wrote nothing in the 11 s after `Stop`, and no event came.
  Why it did not write was not looked into.
- **The folder.** `cwd` equals the folder Linux reports for the terminal's foreground process
  in every event of these records; a `cd` in one command does not last into the next.
- **Twice or not at all.** `SessionEnd` came twice at `/quit`. No event came at `/clear`, at
  Codex's start and for Ctrl+Z.
- **Reading the version.** Running the agent's own program with `--version` answers
  `codex-cli 0.162.1` in 10 to 20 ms. The hook's parent is the native `codex` program, whose
  link target does not name the version, so the program has to be asked.

### OpenCode 1.19.0

Records: `records/edges/opencode-1.19.0/`. OpenCode can be pointed at the stand-in. It has no
hook entries: BMN's plugin is handed events after they happened.

- **Held on `session.status`, the event BMN's plugin gets:** FAIL, 0 of 15 runs
  (`waiting-20261013T180402`). The event comes 144 to 261 ms after Enter and OpenCode does not
  wait for the plugin: in each of the nine runs that measured anything the model was asked
  while the hook held, and in seven of them the write landed before the release.
- **Held on `chat.message`, a call a plugin can answer before the prompt goes on, which BMN's
  plugin does not use:** 9 of 15 runs (`waiting-plugin-chat.message-20261013T180927`). In those
  nine the first request came 175 to 232 ms after the release and nothing changed while the
  hook held. That is not a PASS; it says a plugin wired to `chat.message` is worth measuring
  again.
- **Six runs of each test measured nothing.** In each launch the test's fourth prompt opened
  OpenCode's "Message Actions" list instead of being sent, and the fifth was not tried. The
  fault is the test's way of typing, not shown to be OpenCode's.
- **Events:** `chat.message` comes before the model is asked (95 ms after Enter),
  `session.status` busy after (222 ms), `session.idle` at the end, 712 and 786 ms after the
  last write. Events name `sessionID` and no folder. A prompt typed while a turn ran gave a
  second `chat.message` 86 ms after typing and one `session.idle`. The other ends were not
  measured.
- **Reading the version:** `--version` answers `1.19.0` and takes 637 to 1,517 ms.

### Cursor 2026.09.26

Record: `records/edges/cursor-2026.09.26-dd393fe/not-pointable.json`. Without a sign-in the
agent stops before any request. With a made-up key its first call exchanges that key at Cursor's
own service; `--endpoint` moves the address, not the protocol, and there is no setting for
another model. An app that cannot be pointed at a stand-in does not pass.

### What follows for recording

- Claude Code 2.1.296 and Codex 0.162.1 hold PASS for waiting, so both are recorded. OpenCode
  and Cursor are not.
- Both apps name the turn. A prompt event that carries the open turn's id was typed into that
  turn. In Claude Code such an event comes when the prompt is typed; in Codex it comes when the
  prompt is taken into the turn.
- A prompt event with a new id while a turn is still open means, in Claude Code, that the
  earlier turn ended without an event (an interrupt), unless the prompt begins
  `<task-notification>` after a `Stop` that listed work in flight: then the app is going on by
  itself.
- Claude Code sends nothing for an interrupt, so an interrupted turn there has no observed end.
- A Codex `Stop` does not say that a sub-agent is still at work. `SubagentStart` without its
  `SubagentStop` does.
- `SessionStart` with source `compact` is not a new conversation.

## Running it again

From the folder of the kept scripts, with `<repo>` a built BMN checkout and `<work>` a private
folder outside `/tmp`:

- The waiting test for a new version of an app, one command:
  `node turn-edges.mjs --repo <repo> --work <work> --app claude` (or `codex`, `opencode`). It
  runs the two controls first and ends with PASS or FAIL.
- The events at a turn's ends: `node turn-edges.mjs --repo <repo> --work <work> --app claude --plan edges`;
  one case alone with `--cases moved` (also `sub-agent-left`, which like `moved` runs only when
  named). For Codex add `--codex-compact-at 300000`, so that its compaction case compacts.
- OpenCode held on the other event: `--app opencode --opencode-hold plugin:chat.message`.
- Everything for both recorded apps, one after another: `bash batch.sh <repo> <work> <log folder>`.
- The capture: `node cases.mjs --work <work>` and
  `node timing.mjs --work <work> --repo <repo> --named <a large repository>`.
- What the records say, as this page's numbers: `node summarize.mjs`; the command list:
  `node summarize.mjs commands`.
