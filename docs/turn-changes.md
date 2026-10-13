# Turn changes: how a work tree is captured, where a turn's ends are proven, how a turn is recorded and what the owner reads

BMN can record what differs in a Git work tree between the moment the owner sends a prompt and
the moment the agent's turn ends. This page holds the measurements that feature is built on
(Story 69.1): how BMN copies a work tree without touching it or running anything it names, what
that costs, and, per app and version, whether the app waits for its prompt hook before it acts
and which events mark the ends of a turn. BMN records turns only for an app and version that
holds PASS in the table below. [How a turn is recorded](#how-a-turn-is-recorded) says what the
app does with all of this, and [What the owner reads](#what-the-owner-reads) what he sees of it.

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
  would pass 1 GiB in the store, is never whole. Scans that read on do not pause recording; see
  [The pause](#the-pause).

### In the app

The app runs this mechanism from `apps/desktop/src/utility/turn-changes-*.ts`: the Git commands
(`turn-changes-git.ts`, the only file of the feature that starts Git; the one other program
BMN starts is told under [The app's version](#the-apps-version)), the store, the
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
  link target does not name the version, so the program has to be asked. Installed from npm,
  the process that holds the terminal's foreground is a Node launcher (`bin/codex.js`) and the
  native program is its one child: asked alone, the launcher answers for Node (seen 2026-10-14
  in a live turn on 0.162.1).

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

## How a turn is recorded

The app records turns with the mechanism above (Story 69.4). Nothing is recorded until the owner
switches it on, and no agent gets a new command.

### The switch

A workspace's menu has **Record what each turn changes**. It is off for every workspace until he
ticks it, and it is stored with the workspace. Ticking it first shows what is stored, in the
words its tooltip also carries:

- BMN keeps a copy of the files in the Git work tree the agent runs in, every tracked file and
  every untracked file Git does not ignore, secrets in them included, on this computer for as
  long as you keep agent history.
- Removal runs when BMN starts and every hour; one that failed shows as pending.
- BMN shows what differs between two scans of that work tree, not who changed it.

While the switch is on for a session's workspace, BMN keeps an empty file named after the
session in the private folder `turn-marks/` beside its control socket. `bmn hook` looks for that
file and adds nothing when it is not there, so with the switch off a hook does exactly what it
did before: the prompt guard's answer first, then a message for its own agent, exit 0.

### The marks a hook sends

`turn.mark` is a control-socket method that only a session's own token may call, for its own
live process. It names no session, and the owner's token is refused. Its parameters are a closed
list: `requestId`, `edge` (`start`, `confirm` or `end`), `app`, `conversation`, `turn` (the
app's own id of the turn: Claude Code's `prompt_id`, Codex's `turn_id`), with `until`, `folder`
and `continued` on a start and `kind` on an end. The answer is one status word and never more:
`captured`, `incomplete`, `unavailable`, `not-supported`, `busy`, `late`, `off`, `paused`,
`continued`, `overlapped`, `confirmed`, `queued`, `stale` or `repeated`.

Only the hook of the agent typed into the session sends it, for its main conversation, and only
after the prompt guard let the prompt through: never for a sub-agent, an agent another agent
started, or a stopped prompt. `hook.observe` carries the conversation, the turn's id and whether
the event is a sub-agent's, so that BMN can tell a tool event of the turn from any other.

- **At a prompt** the hook sends `start` with the time until which it will wait: 300 ms from the
  moment it began, the same allowance a message's hand-over shares. BMN scans ("before") and
  answers. After `captured` or `incomplete` the hook sends `confirm` on the same connection,
  before it lets the app go on. Until then the scan is tentative: when the time passes, the
  connection drops, no confirmation comes, or a tool event of that agent arrives first (the app
  did not wait), BMN cancels it, its staged bytes go at once, and the turn reads "Before
  snapshot unavailable". The hook prints nothing for any of this.
- **At an end** the hook sends `end` with its kind: `finished` for `Stop`, `interrupted` for
  Codex's `Interrupt`, and `continues` for a Claude Code `Stop` that lists work in flight, which
  leaves the turn open. `error` is in the list; no measured event sends it. BMN answers `queued`
  at once and scans ("after") within 2 s, from the turn's own root and only while that folder is
  still the folder it scanned first (the same device and file number).

### How a turn moves

A turn belongs to one foreground process (BMN's own reading of the session's terminal), one
conversation and one root, and has a number BMN counts per session; the app's id of the turn is
stored and matched too.

- An ended turn stays provisional until the next prompt of that agent and conversation runs.
  Until then a tool event of the same agent, conversation and turn reopens it and drops its
  "after"; a later end takes its place.
- **Codex** sends its prompt event when the prompt is taken into a turn. A prompt event while a
  turn is open therefore closes that turn as "End not observed" and starts the next one, and the
  earlier turn is compared through the new turn's "before".
- **Claude Code** sends its prompt event when the prompt is typed. A prompt event that carries
  the open turn's id, or none, was typed into that turn: each such prompt gets a record of its
  own, and those records and the turn they arrived in read "Comparison unavailable: prompts
  overlapped", without totals. A prompt event with a new id means the earlier turn ended without
  an event (an interrupt): it closes as "End not observed" and is compared through the new
  "before". A prompt that begins `<task-notification>` after a stop that listed work in flight
  is the app going on by itself: the hook says `continued` (the prompt's text never leaves the
  hook) and the turn stays open.
- `SessionStart` with another conversation (source `compact` is none), `SessionEnd`, another
  foreground process and the session's end close an open turn as "End not observed". BMN takes
  one last scan of that turn's root while the folder is still the same one; otherwise the turn
  reads "End not observed; final scan unavailable". A new agent's root is never used for an old
  turn. An observed end whose second scan cannot be taken reads the same, or "Not supported
  here: <reason>" when the work tree is one BMN does not scan.
- A call repeated with the same request id changes nothing. An end, tool or compaction event of
  another agent, conversation or turn is counted as stale and changes no turn.
- When the switch goes off, or the session moves to a workspace whose switch is off, a scan
  still running is cancelled and an open turn closes as "Recording was switched off". A turn
  stored as open when BMN starts closes as "End not observed; final scan unavailable".

One row per turn is stored (`turn_record`): its id, number, session, incarnation, foreground
process, app, the app's version where BMN could read it, conversation, the folder the event
named, the root, its two captures, the kind of end, the totals and whether they are complete,
and its labels. No row holds a file's name or content.

### The app's version

BMN reads the version once per foreground process, away from the prompt's path, by running the
program that process is (`/proc/<its process>/exe`) with `--version`. When the answer is another
program's, the process is a launcher: Codex from npm is a Node script whose one child is the
native `codex`. BMN then asks, the same way and inside the same 2 s, the programs that process
started itself and that still share the terminal's foreground with it, at most eight, and never
what those start in turn (an agent's commands). With the Git commands above these are the only
programs the feature starts, always as `/proc/<a process>/exe --version` and never by a path
anybody names (`turn-changes-version.ts`; a test holds both lists). BMN asks only a process as
free as itself: one in another view of the file system (a container, a sandbox), one that gave
up new privileges (Landlock asks for that) or one with a system-call filter on it is never
asked, since a program BMN starts would run outside that sandbox; and only while the program is
still the file BMN identified. Only an answer in the app's own shape counts (`2.1.296 (Claude
Code)`, `codex-cli 0.162.1`). An app that an interpreter runs without a program of its own has
none to ask (Claude Code installed from npm would be one; not tried here), and its turns read
"Ordering unverified".

A turn on another version than the measured one, or on one BMN could not read, is still
recorded. It reads "Ordering unverified on <app> <version>; early writes may be missed", and
its totals are shown as not complete.

### The wordings

A turn without complete totals says so in exactly one of these nine, and no other. When more
than one applies, the first in this order is said:

1. "Recording was switched off"
2. "Comparison unavailable: prompts overlapped"
3. "Before snapshot unavailable"
4. "Not supported here: <reason>"
5. "End not observed; final scan unavailable"
6. "Incomplete: <bound>"
7. "Difference unavailable: limit reached"
8. "Ordering unverified on <app> <version>; early writes may be missed"
9. "Partial: <n> files"

### The labels

Every closed turn carries three:

- "Two scans of <root>, the first from <time> to <time>, the second from <time> to <time>. Files
  in a scan were read at different moments, and other programs' changes may be included" (times
  are this computer's own date and time)
- "Covered: every tracked file and every untracked file Git does not ignore. Not covered: other
  ignored files, anything outside this work tree, and the contents of submodules and nested
  repositories, of which only the recorded commit is compared"
- "Anything written after the second scan ended is not included"

And these when they apply:

- "End not observed: compared through BMN's next scan; whatever changed in between is included"
- "Another BMN session was started in this work tree; whether it worked here is not known"
- "HEAD was <a> when the first scan began and <b> when it ended, <c> and <d> for the second;
  what Git brought in may be included, and moves in between may be missed", whenever any two of
  the four differ
- "This turn ran on <app> <version>; waiting for the prompt hook was measured on <version>"
- "Partial: <n> files were not read or entered or left what is covered"

### The pause

Three scans in a row that failed, or were incomplete and read nothing new, for one root of a
session pause recording there. An incomplete scan that read on is not one of the three (the
owner's choice, 2026-10-13): each scan of a big work tree reads up to 100 MiB further, so one of
426 MiB is whole at its fifth scan, two turns there read "Incomplete: 100 MiB read", and nothing
has to be pressed. A whole scan sets the count back to zero.

While paused, BMN scans and records nothing for that root. The pause is shown on that session in
the window only, as the prompt guard's card is: it is not a request and reaches no snapshot, no
token and no phone. Its reason is one of three fixed sentences, never a file's name: "Three
scans in a row failed", "Three scans in a row were incomplete and read nothing new", or "Three
scans in a row failed, or were incomplete and read nothing new". The card shows once for a pause,
under that session's header when its pane is on screen, with the work tree and the reason, and
only closes; after it the header's plate reads "Paused" and its tooltip keeps the reason.
**Resume recording in <work tree>** in the workspace's menu sets the count back to zero.

### Who can read it

No token reads a capture, a turn or a difference: the control socket has no method that returns
one, and the answer to `turn.mark` is a status word. `bmn hooks check` says per app, on a `turn
changes:` line, whether its turns are recorded and on which version waiting for the prompt hook
was measured. The agent brief and `bmn help agents` are unchanged.

The window reads through four channels of its own, each checked for its sender: where recording
stands for each session with its latest turn, a session's latest 50 kept turns, one turn with its
labels and files, and one file's difference. A test calls each of them on the control socket with
a session's token and with the owner's and is refused both times.

## What the owner reads

### The plate and the dialog

A session with a kept turn has one quiet button in its pane's header, between its ports and Split,
and **Turn changes…** in the pane's ⋯ menu and in the session's menu. Neither depends on an agent
ever reporting progress. The button is as high as a port's plate and sits in the row the header
already has, so it changes no terminal's size when it appears, changes or goes.

| The latest turn | Pane over 880 px | Pane of 880 px and under |
| --- | --- | --- |
| Complete totals | 4 files +120 −33 | 4 files |
| "Partial: <n> files" | 11 files +96 −40 partial | Partial |
| "Ordering unverified on <app> <version>; …" | 6 files +58 −7 not complete | Not complete |
| Any wording without totals | the wording up to its first ";" or ":" | No totals |
| Still running | Turn running | Running |
| Recording off, paused, or another app | Recording off · 4 files | Recording off |

Gold marks only a turn without complete totals: "partial", "not complete" or the wording. The
state of recording is plain, and beside it the earlier turn shrinks to its file count. A pane with
a plate drops its button words at 720 px and its directory, agent name and ports at 600 px; under
415 px, and while the session waits for you, there is no plate and the menu entry remains. "Not
supported for <app>" is said while a program whose hooks named an app BMN does not record holds
the terminal's foreground.

The dialog is headed "The latest 50 turns still kept" with the state of recording under it:
Recording on, Recording off, Paused or Not supported for <app>, joined by "Removal pending" while
a removal waits for that session. A turn opens beside the list, and in place of it with **Back**
in a dialog under 900 px wide. An opened turn says "What differs between two scans of <root>. It
is not a list of what the agent did.", then its labels, its own first, then its files sorted by
path. At most 2,000 files are listed and the rest are counted. A turn that was removed while open
reads "No longer kept". The end words are Finished, Error, Interrupted, End not observed and
Running; a turn that reads "Recording was switched off" has none.

### A file's difference

A file with counted lines or a binary file's sizes opens in place under its row, several at once;
an open file's row stays at the top while its difference scrolls. The difference is unified with
three lines of context, a `+` or `−` before each changed line and three neutral tones.

- **Bounds.** At most 5,000 lines or 256 KiB of shown text; then "N more lines not shown", or
  "More lines not shown" when the number is not known. A line is cut at 2,000 characters with the
  mark "cut at 2,000 characters". A binary file reads "Binary file changed" with both sizes. A
  difference that ran out of its 2 s reads "Difference unavailable: limit reached".
- **Masks.** Secret ranges are found over both whole texts by the rule for that file's name and
  laid over the lines of the difference, inside the same 2 s and inside the worker thread. Line
  numbers, hunk ranges and the added and removed counts are those of the original texts. A value
  is one plate of ten dots whatever its length, in added, removed and unchanged lines alike; a key
  block of many lines stays that many masked lines. A hunk in which every removed line reads the
  same as the added line in its place once masked says "Secret value changed".
- **The rule** (`apps/desktop/src/utility/secret-ranges.ts`, shared with the terminal's own mask):
  in a file named `.env`, `.env.<anything>` or `<name>.env`, every value; in JSON, YAML and TOML
  files and lock files, a value whose name contains key, token, secret, password, passwd, auth,
  credential, cookie or private, but not a map, a list, a block, true, false or null; in those
  config files and not in lock files, any unbroken run of 32 or more letters, digits, `-`, `_`,
  `+` or `=`; and in every file the known shapes of keys, tokens and private key blocks.
- **Nothing reveals a value.** The original text never leaves the worker thread: what the host
  hands the window already holds the plate, so a copy, Find, a screen reader and the test hook get
  the masked text. There is no control that shows a value.
- **Giving way.** A comparison the owner only reads is stopped when a prompt needs the worker for
  its scan, and asked again 350 ms later, up to three times; after that it reads "BMN was scanning
  for a prompt; open it again".

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
