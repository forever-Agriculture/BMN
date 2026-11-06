# MODULE: planning.md - plan format, canonical locations, guarded row writes and publication
# Planning

How a project is planned with BMN (Epic 77): one small format in the project, one board the owner reads and edits, one command that reads, checks and changes it (`bmn plan`), and one planning skill (`plan`) that BMN installs into every agent app. A project not yet moved from BMAD is read as before, and nothing writes or runs it until it moves (Epic 108): `set`, `go` and `allow` refuse it with `NEEDS_MOVE`, naming the move tool ([Moving a BMAD plan safely](#moving-a-bmad-plan-safely)), and so does dev-auto's start. A moved plan may retain a BMAD board for a colleague (`bmad_board`, b2buster for Artem); the two-way sync is its only writer.

## The plan folder

A project's plan lives in `plan/` at the root of its product repository:

| Path | What it is |
| --- | --- |
| `plan/VISION.md` | The foundation (owner, 2026-10-17: "We should build our project on top of that"): what the project is for, its numbered principles with their sources, what it refuses, and a log of the owner's changes. At most 8 KiB. |
| `plan/PLAN.md` | The frame: purpose, users, goals, non-goals, success signals, standing constraints, the architecture, the decisions in force (or where they live) and the index of the project's truth documents. At most 20 KiB. |
| `plan/status.yaml` | The board (below). |
| `plan/epics/NNN-slug.md` | One file per epic, numbered with at least three digits (`077-our-own-planning.md`). An active epic file is at most 60 KiB. |
| `plan/references/<epic>/` | Large evidence: consultations, reviews, screenshots, measurements. Read on demand. |
| `plan/shared/`, `plan/history.md` | Migration only: text shared by several legacy epics, and the old board's header history. |

The templates are in `skills/plan/templates/` (`VISION.md`, `PLAN.md`, `epic.md`, `status.yaml`).

**Truth and change.** Epics are change proposals. What is true about the product now lives in its truth documents (BMN's are `docs/`), indexed by `PLAN.md`. Every epic says which truth documents it changes (Truth impact), and its close-out checks them against what was delivered.

### VISION.md

Required `##` sections: **Vision** (one paragraph) and **Principles** (a numbered list, never renumbered, so epics cite `P3`; each principle names its source: the owner's words with their date, or a sourced synthesis; an unconfirmed one is *provisional*). Optional: **We refuse**, **Log** (each change with the owner's decision). Only the owner changes its substance (`skills/plan/methods/vision.md`).

### PLAN.md

Required `##` sections, in this order: Purpose, Users, Goals, Non-goals, Success signals, Standing constraints, Architecture, Decisions, Truth documents. **Architecture** links the architecture truth document with a two-line summary, or holds the contract inline (parts and owners, invariants `A1…`, shared data and interfaces, quality targets, technology choices; and when they apply, glossary, privacy and providers, assumptions and open decisions), or says `None needed: <reason>` (`skills/plan/methods/architecture.md`). A larger product links its architecture and design documents instead of copying them.

### An epic file

The first heading is `# Epic N: Title`, followed by the suggested lead (and designer or reviewer) line. Required `##` sections: **Outcome**, **Why** (the owner's words with their dates, and the `VISION.md` principles it serves), **Boundary and dependencies**, **Truth impact** (the documents and contracts it adds, changes or removes, or `none` with a reason), **Stories**. From Epic 90 on, also **Run needs** (what his go approves for the epic's runs: extra repair rounds per boundary, deferrable criteria or stories with their conditions, a money cap or `none`, named actions for an Away card or `none`), and every story has an `**Owner:**` line saying `none`, `before the go` or `at the end`; his steps never sit between unattended stories. Optional: What exists today, Requirements, Decisions, Assumptions (material uncertainty: what settles it, who, what stops), Rollout (stored data, compatibility or the installed release: cutover, recovery, the installed check), Reviews, Log (one concise line per event, with its evidence path).

Each story is `### Story N.M: Title` under Stories, with its user story, coverage and starting points, then `**Acceptance criteria:**` followed by a numbered list of Given/When/Then criteria, then `**Verification:**` naming the check.

### Identifiers

Epic numbers, story numbers (`77.1`) and criterion numbers (`77.1 AC2`) are unique and never renumbered. A dropped story keeps its number. The board's keys follow BMAD's: `epic-77` for the epic, `77-1-slug` for story 77.1.

### Legacy epics

An epic migrated from BMAD keeps its text verbatim beneath one marker line, the file's first non-empty line:

```
<!-- bmn-plan: bmad-legacy; contracts: docs/epic-53-windows-support.md -->
```

`bmn plan check` checks a legacy epic for its `Epic N` heading, its identifiers and its rows only; its sections and size stay as they were.

## The board: `plan/status.yaml`

```yaml
format: bmn-plan
schema_version: 1
queue:
  - 78
  - 79
development_status:
  epic-77: done # accepted on dev-auto/epic-77; delivered main f00ba12
  77-1-the-plan-format: done

  epic-78: ready # go 2026-10-17
  78-1-measure: backlog
```

- `format` and `schema_version` come first. A reader that finds another schema version stops with an error, never guesses.
- Four optional positive integer headers set this plan's rule thresholds: `rules_from_run_needs`, `rules_from_prepared`, `rules_from_prepared_items`, and `rules_from_challenges`. Each missing line means epic 1. Two more opt a plan in: `rules_from_allowances` (an epic from that number on without a file is reported, and `bmn plan go` refuses any epic's go without one, `NO_ALLOWANCES`, so a rewritten older epic gets its file too) and `rules_from_size` (one over 10 stories or 50 criteria is reported, unless its Decisions quote his word for that size). For these two a missing line means the rule does not apply. BMN's own board records 90, 103, 104, and 107, and 111 for the two opt-in rules; a moved project starts each rule at its lowest epic number. Only the legacy marker exempts an epic's historical text from the newer planning sections.
- A migration may declare `legacy_rows: legacy-rows.json` beside `moved_from`. That version-1 metadata names original exceptional row keys, their source line and source-row SHA-256: opaque IDs and distinct historical rows sharing a numeric prefix remain independently addressable. The checker validates that metadata and continues to reject new opaque or duplicate numeric IDs. JSON status marks these rows with `legacy: true` and `legacy_id`; numeric epic selection applies to numeric work.
- `queue` is the one order of unfinished epics: every `ready` epic is in it; nothing `done` or `dropped` is. `project`-scope work takes the queue first, then any unqueued unfinished epics by number.
- `development_status` holds one line per epic and story in BMAD's row grammar: two spaces, key, colon, status, optionally `# note`. An empty line separates one epic's rows from the next; readers skip empty lines. A note is one line of at most 160 characters; the run log belongs in the epic's Log and the run's evidence. An epic note carries `Suggested lead: Name 🇺🇸` from its epic file, immediately after a `go DATE ·` head when present. `set --note` and `go` keep one canonical hint, remove stale or repeated hints, and clip trailing run text with `…` when needed. Text output reports clipping; JSON gives `note_clipped: true`. Story notes and epic files with no suggested-lead line keep their existing rules; omitting `--note` on `set` preserves the note.
- The owner edits this file by hand whenever he likes. Agents change it one row at a time with `bmn plan set`.

| Status | Meaning |
| --- | --- |
| `backlog` | Planned; no go yet. |
| `ready` | His go recorded at planning (`go YYYY-MM-DD` in the note) with `bmn plan go`, which commits it with his act and the approved text. It approves the epic's Run needs as his instruction for its runs, read from the plan commit that recorded the go. The authority to implement stays the invocation that selects the work (a `/dev-auto` run); it never covers push, merge or deploy. |
| `in-progress` | Being built. |
| `review` | Implemented and being checked. |
| `blocked` | Waiting on a named gate; the note names it. |
| `paused` | Stopped or parked by the owner; the note says so. |
| `done` | Verified acceptance; the note names the branch and, once delivered, the default-branch commit (dev-auto's board convention). |
| `dropped` | Not to be done; the note names the decision. |

A BMAD board (`sprint-status.yaml`) is read with BMAD's statuses (`backlog`, `ready-for-dev`, `in-progress`, `review`, `done`, `optional`) and its comments as they are; only a retained board's two-way sync writes one.

## Where a plan is found

Every reader (`bmn plan`, the app's Now sheet, dev-auto through `bmn plan status --json`) resolves the same way:

1. The product repository: Git's top level for the directory, and from inside `plan/` with its own `.git` the repository that encloses it.
2. The default checkout is the worktree on the branch named by `origin/HEAD`. If that reference is absent or its branch is gone, a read-only `git ls-remote --symref origin HEAD` asks the remote. With no remote, the existing local worktree convention remains. The first worktree is never substituted for an unavailable remote default.
3. BMN's `plan/status.yaml` in that checkout is canonical from every linked worktree, tracked or ignored. Its `bmad_board: <repository-relative path>` may explicitly retain a BMAD board, and then BMN's plan wins even from an old branch. Without that declaration, both plans remain `BOTH_PLANS`. Unknown schemas and malformed own boards are errors. A project still on BMAD is read at its configured/default board, and only read.
4. Without a checkout on the remote default branch, `status` reads locally and reports `default_available: false`; `set` and `go` refuse `NO_DEFAULT_CHECKOUT`, naming how to add one. An unavailable remote does not grant local approval authority.

`bmn plan status --json` reports `product_root`, `default_checkout`, `default_branch`, `default_available`, `run_checkout`, `plan_root`, `board`, `board_checkout`, `format`, `tracked` and `history`. A tracked BMN plan also reports `unpublished` and the epic numbers in publication `conflicts`.

## History

A plan the product repository ignores keeps its history in its own local Git repository inside `plan/`, with no remote (`history: plan-repository`). That is history, not a backup. The planning skill commits the plan files it changed at each planning checkpoint, after first committing separately whatever was uncommitted there (the owner's and dev-auto's board edits); it never stages other files. dev-auto commits nothing in `plan/.git`.

A tracked BMN plan uses the default checkout's product history (`history: product-repository`); reads, row writes and go commits use that same location from every worktree. Only an ignored plan has its own repository.

BMN's own plan is ignored by BMN's public repository (`/plan/` in `.gitignore`).

## `bmn plan`

Works with BMN closed, on either format. Exit 0 done or clean, 1 findings or a refused change, 2 usage error or a plan that cannot be resolved or read.

- `bmn plan status [--json] [--project P] [--epic N]...` prints the resolved paths and the rows, read as a stream with no size limit. A note too long for the terminal is clipped for display and marked with `…`; no row is ever left out, and `--json` gives every selected row whole with its line and row token. A board in BMN's format that cannot be read unambiguously (a repeated key, header or logical identifier such as `1-1-a` beside `1-1-b`, a malformed line, an unknown format or schema version) is refused with exit 2 (`MALFORMED`), so dev-auto stops on it.
- `bmn plan allowances N [--at COMMIT] [--json] [--project P]` is the one reader of `plan/allowances/NNN.yaml` (see [One file of what a run may use](#one-file-of-what-a-run-may-use)). `bmn plan allow N CHANGE... --reason R --expect TOKEN [--source WORDS]` changes it in one commit with no new go.
- **Messages and people.** `**Messages:**` in Run needs names each allowed message as `<person>, on <destination>: <purpose>`, one sentence each, or `none`; `run_needs.py` prints them and `spend_ledger.py message` reserves each use. `person` is a Prepared kind: who owns or accepts what, with its check and date. From Epic 107 on an epic answers `## Challenges` (Scale, Origin, Verified, Exists, People), which `bmn plan check` requires by label.
- `bmn plan check [--json] [--project P]` is structural validation, one finding per line: duplicate keys, malformed rows, unknown statuses, notes over 160 characters, story headings without rows and rows without headings, duplicate epic, story or criterion identifiers (two board keys for one epic or story among them), repeated header lines, a story row whose epic has neither a row nor a file, missing required sections of the frame or an epic, stories without criteria or Verification, a queue naming an unknown, duplicate or finished epic or missing a `ready` one, a `done` epic with a story neither `done` nor `dropped`, a `blocked`, `paused` or `dropped` row without a reason, a non-legacy file over its ceiling, from Epic 103 on a `## Run needs` with no `**Prepared:**` line or a bare `none` (`none, because <reason>` passes; from Epic 104 on each need also names a target, `check:` and `checked <date>`, an owner step only its target, the same form dev-auto's `run_needs.py` reads; Epic 103's own approved line stays as it is, since Prepared is inside the text a go approves, so a changed need asks a new go), and from Epic 90 on a missing `## Run needs`, a story without an Owner line, a `before the go` story after a `none` story or an `at the end` story before one. For unfinished epic rows with a suggested lead in their epic file, it also reports a missing, stale or repeated hint, with the board line and expected hint. On a BMAD board it checks duplicate keys and row grammar only. Whether the plan says the right thing is for the readiness method and review.
- `bmn plan set <row> <status> --expect TOKEN [--note TEXT] [--project P]` changes one row (below). It does not set an epic row `ready` in a plan with history: that is his go, recorded with `go`.
- `bmn plan go <epic> --source TEXT --approved sha256:HEX|COMMIT --expect TOKEN [--date YYYY-MM-DD] [--note TEXT] [--project P] [--json]` records his go (below).

### One file of what a run may use

`plan/allowances/NNN.yaml` beside the epic holds every limit and permission of its runs, so `## Run needs` can be one line pointing to it and a raise changes no epic text ([template](../skills/plan/templates/allowances.yaml)). `limits` may use any name, each with `limit`, `per` (`boundary` or `epic`), an optional `ceiling` a lead may reach alone, and `unit` (`count`, `hours`, `usd`); no ceiling means the lead cannot raise it. `may` lists named actions and targets read as his approval, `stays_out` what no run asks to cross, and `deferrable`, `messages` and `prepared` are Run needs' lists. A go on an epic with the file adds its text to the approval hash; an epic without one reads and hashes as before.

The file's trust matches the go's: only a commit written by `bmn plan go` or `bmn plan allow` counts. A hand edit is reported by `check` and ignored, and `allow` refuses until the file matches. `--source` holds his quoted words and is workflow protection, not proof against a forging agent. With no source only these change: a limit at or under its ceiling, a lower limit, an addition to `stays_out`, a Prepared need's `checked` date. A limit with any use keeps its name, `per` and `unit`, source or not; a different measure is a new limit. `allow` finds the epic's ledgers by the ids dev-auto's `spend_ledger.py` gives them (a moved plan keeps the id of the board it came from; another plan in the same repository has its own), holds their locks, the ones `spend_ledger.py` takes to count a use, from reading the uses to its commit, and counts as used anything it cannot read or confirm. A run uses the version at its go's commit, then the last recorded `allow` after that go, whether or not the file is on disk; a go whose commit holds no file returns the epic to its Run needs, with every use still counted. On a tracked plan a change stands locally at once and follows `bmn plan publish`; an upstream change or deletion of the file holds the epic as a conflict, which grants nothing until read again.

A card a run raises recommends a limit that finishes the work, never one more slice, and no agent proposes a limit narrower than the file's. Recover by deleting the file and recording a new go on his word, or by reverting.

### Recording his go

The planner asks for the go on one card after readiness, holding the epic row's token and its approval text from `bmn plan status --epic N --json` (`approval_texts`: the SHA-256 of the epic's `## Run needs` and `## Decisions` bodies, each to the next heading of levels 1-4, outer blank space removed; `run_needs.py` hashes them the same way). On his go, `bmn plan go N --source "…" --approved sha256:… --expect TOKEN` records it before any run starts:

- `--source` names his act: his quoted words with their time (`card 2026-10-26T09:30Z: 'Go'`). A `bmn:SESSION/KEY` reference names a decision record an agent made for itself ([dev-auto](dev-auto.md)), so it is refused. A string is what the planner states, not proof of the act; only a real answer of his is recorded. The go date is the source's date unless `--date` gives one.
- `--approved` is the approval text he was shown, or the plan commit he approved. Run needs or Decisions that differ from it, committed or not, are refused (`CHANGED_TERMS`): ask again on the current text.
- It writes one commit of the plan's history holding only the row's change to `ready # go DATE · <note>` and the epic's place last in `queue`, plus the epic file when its approved text is not yet committed (a later edit of it stays uncommitted). Its message carries `Go-Epic`, `Go-Date`, `Approval-Source`, `Approved-Text` and `Approved-File`. Other changed or staged files stay as they were and out of the commit; the board's other uncommitted rows stay uncommitted. The branch moves only if it did not move meanwhile; then the index entry (if it was not staged) and the working board follow, and the commit is read back.
- Refused, writing nothing (exit 1, the code names the missing fact): `NO_OWNER_GO`, `NO_APPROVED_TEXT`, `CHANGED_TERMS`, `CONFLICT` (a stale token), `FINISHED`, `NO_EPIC`, `NOT_COMMITTED` (the epic's rows are not in the history yet), `UNREADABLE_HISTORY`, `COMMIT_FAILED`, `DETACHED`, `NO_HISTORY`, `NO_DEFAULT_CHECKOUT`, `NO_ALLOWANCES` (a plan with `rules_from_allowances` and no file in what he approved), `NEEDS_MOVE` (a BMAD board: move the plan first).
- The same request again finds its commit (`already recorded`) and only completes what a crash left undone, so one act never records two gos. Only a go the working board does not show yet is completed, by the same request over the row it was asked on: `bmn plan go` keeps a pending record of it beside the board's versions until the working board shows the go, a `bmn plan set` changes the row, or a later commit changes it. A retry that writes nothing (another row token, or a board that changed while it was written) keeps the go pending and exits 1 with `board_pending`. A go that stopped while the board was being written, whose row is again the one it was asked on, is refused (`UNCERTAIN`): an unwritten board and one written and put back by hand look the same, so it takes a new go. A go published before is never written again: after a withdrawal, committed or only on the board, it is refused (`WITHDRAWN`) and the row stays as it is.

dev-auto reads the go back with `run_needs.py N`: GO, its commit, the recorded source and the approved text. Each commit `bmn plan go` wrote for the epic is a go, a second one on the same day with new terms included. A go committed by hand before this command stands, its source unrecorded: one committed before 2026-10-27 and before the history's first `Go-Epic` commit. A hand-committed go after either names no act of his and grants nothing (`NO_GO_RECORD`); so does a recorded go missing any of its five trailers, or whose epic, go date, source (his quoted words with their time), file or approved text disagree with what the commit holds; a row put back to `backlog` or `dropped`, or taken off the board, withdraws it, in a later commit or on the board now, until his next go. A plan the product repository tracks is read in its default checkout, where gos are recorded and withdrawn. The approved text is Run needs and Decisions only: a story or criterion changed with the go or after it is not bound to it, and `CHANGED_SINCE_GO` does not name it.

A moved plan's `migration.json` pins the original board and its pre-move history. The reader follows that old history for existing approvals and withdrawals, then reads later approval events from the new board; copying a dated comment and deleting the old board create no approval event. Missing or inconsistent history pins leave approval unconfirmed. Unfinished legacy work with no historical Go reads `NEEDS_NORMALIZE`, without a new allowance. A new Go requires normalization first. `migrate-bmad-plan.mjs normalize --file EPIC --spec JSON` performs a separate edit using caller-supplied missing planning facts, retaining existing Run needs and every story's requirement words: it adds a missing `## Stories` heading, and a spec's `stories` may reshape a story only in presentation (the acceptance label, list numbering, spacing, an added `**Owner:** none` or one quoting the story's own owner step, and a `**Verification:**` that quotes an existing check verbatim or says `none recorded in the moved text`; each quote at least two words, and nothing outside the quotes but its timing or check labels), refused if the words in order differ; with an allowances file Run needs takes no Prepared line. Normalization itself records no Go.

### Changing one row safely

`TOKEN` is the row token from `bmn plan status --json`; it covers the row's status and note. `set`:

1. takes the board's sibling lock, `.status.yaml.lock`, present only while a writer works and naming its process and a nonce. A dead writer's lock is cleared by one reclaimer at a time (it holds `.status.yaml.lock.reclaim`) and only while it still holds that writer's text; a writer removes only the lock with its own nonce. A reclaimer that dies leaves its guard, and no writer removes a guard it did not create: a guard alone never blocks a writer, but a dead writer's lock behind a dead reclaimer's guard stays, and `bmn plan set` refuses with `LOCKED`, naming both files, until someone stops every `bmn plan set` and removes both by hand;
2. rereads the file and refuses with exit 1 (`CONFLICT`, showing the row now and its token) when the row no longer matches `TOKEN`;
3. replaces that one line (the note is kept unless `--note` is given) and leaves every other byte as it was, line endings included;
4. keeps the version before in `~/.local/state/bmn/plan-versions/<board hash>/` (the last 20, with `board-path.txt` naming the board);
5. writes a temporary file with the board's mode, checks that the board is still what it read, and renames it into place. When another row changed in the meantime it reads again and retries, at most 5 times.

A missing `--expect`, an unknown row or status, or a note it would write over 160 characters is refused with exit 2. A canonical BMN plan changes only in the default checkout. A BMAD board is refused with `NEEDS_MOVE` (exit 1), writing nothing.

### Publishing a tracked plan

`bmn plan publish [--project P] [--json]` checkpoints waiting planning paths with a private Git index, preserving unrelated staged and unstaged work. It reconciles the plan difference against the remote default and any existing `bmn/plan` branch in a throwaway worktree. Publication uses one open plan-only PR, with policy read before its push and before creating the PR. The current Q-Automations rehearsal chooses that PR route because policy reserves bypass and deployment-triggering pushes.

A rejected push or conflict leaves commits local and prints `unpublished N`, without a card. Independent row edits merge; competing row values are kept separately in the Git common directory's `bmn-plan-publish/conflicts/`. `status` names affected epic numbers and both row values (`conflict_values` in JSON), and `run_needs.py` returns `PLAN_CONFLICT` for those epics without granting rounds or money. The ledger preserves its recorded Go and consumption while confirmation is held; accepting the retained incoming value clears the publication conflict, and the ordinary approval reader then checks that settled history. Other epics continue. Upstream withdrawal and changed approved terms are read before publication can proceed.

Deleting an approved epic upstream also holds that epic before any publication attempt. Known holds survive unavailable publication statistics. An unreadable authority journal reports `authority_unconfirmed` and grants no rounds or money until it can be confirmed; a local Go remains usable when only remote publication statistics are unavailable.

After upstream accepts the plan, publication merges that result into the local default history, retaining the original go commit and approved text; unrelated local product commits never enter the publication branch. A merge conflict leaves the local checkpoint intact. Ignored plans return `ignored` and keep their existing local history. Planners publish at their checkpoints; dev-auto publishes at each story's end.

**What it guarantees, and what not.** Cooperating writers (`bmn plan set`) on different rows both land; the same row is refused as a conflict; the owner's save before the read, or between the read and the final check, is kept (a change to his row is a conflict, a change elsewhere is reread). An editor's save in the instant between the final check and the rename, or a stale editor buffer saved later, is outside the guarantee: the later save wins. Recover from the kept versions: `ls ~/.local/state/bmn/plan-versions/*/board-path.txt` finds the board's folder, and each `.yaml` there is a whole earlier board to compare or copy back.

## Moving a BMAD plan safely

`node scripts/plan/migrate-bmad-plan.mjs stage --repo REPO --stage STAGING/plan` prepares a copy without changing the project. `--unfinished-only` omits done/dropped epics, their rows and extensions, and unlinked historical documents; the manifest accounts for them as archive-only, and links to omitted work point to the history note. The plan records the next number after the highest original epic. `--keep-bmad` retains every row and declares two-way board sync (these options cannot be combined). `check` verifies all source spans; normalization is a separate `normalize --file EPIC --spec SECTIONS.json` edit. Existing approvals remain on their original committed text; a legacy epic without a confirmed Go needs normalization before new work.

Migration handover requires updated dev-auto tools before any run resumes or opens the moved plan. Use the updated `run_needs.py` and `spend_ledger.py`, including for a resumed run that already holds its original budget ID. Untouched older script copies are unsupported after cutover: they can derive a different ledger from the new plan path. The updated tools retain the original budget pathname and lock through the alias; approvals, spent rounds and money are preserved. Never delete an old budget to make a fresh open succeed.

Packaged builds retain migration helpers under `resources/scripts/plan/`, with their source-relative module layout and adjacent watchdog. The packaged smoke imports these helpers, copy and publish modules before exercising the app; source-layout loading alone does not verify the installed runtime.

A retained BMAD generator must understand copied statuses before cutover. The internal `prepareBmadCopy` helper in `scripts/plan/prepare-bmad-copy.mjs` prepares the measured repository-local Claude and Codex parsers together, under verified handover and the common writer lease. It accepts only the rehearsed version, journals original bytes and modes, and refuses missing, linked, edited or unknown versions. Staging never invokes preparation. Cutover verifies completion and includes both prepared files in the move; publication carries those exact files with the board. A partial preparation parks cutover. Repeating preparation recovers known completed replacements; an ambiguous reversion is preserved and named. `rollbackBmadPreparation` restores originals unless later parser edits, an active copied plan or newly held BMAD rows still require compatibility. Real installation belongs to Epic 108, including updating BMAD's old regression assertion that epic `review` is illegal.

Rolling back the plan keeps the prepared parsers committed, so replayed held rows remain protected. Restoring parser originals is the separate guarded operation above.

Exports to the retained board use these mappings; imports use the explicit BMAD-to-plan status table:

| His plan | Retained BMAD board |
| --- | --- |
| backlog | backlog |
| ready | ready-for-dev |
| in-progress | in-progress |
| review | review |
| done | done |
| blocked | blocked |
| paused | deferred |
| dropped | withdrawn |

New `plan/bmad-copy.json` records use version 2, which older clients refuse. Every row participates, including Artem's. `bmn plan sync`, `set`, `check` and `publish` compare each side with its last synchronized value: a unilateral change reaches the other board; concurrent changes take the further-along status, retaining both values. Progress orders backlog, ready, in-progress, review, done; exceptional statuses take precedence in the order paused, blocked, dropped; the plan wins equal-status note conflicts. New rows append to the other board without changing unrelated bytes. A missing baselined row holds its epic rather than recreating deleted work.

The BMAD note remains whole (new notes up to 1,000 characters; existing longer notes remain intact); the visible plan note is at most 160 Unicode characters. A status-only plan edit keeps the original full note and unchanged BMAD status aliases; an explicit note edit replaces it, preserving the old note in metadata. Every directional intent, both before/after values and its baseline are journaled before atomic writes. Recovery finishes that decision or reports `COPY_UNCERTAIN`; it does not choose a new conflict winner. Before recovery or any new write, a disputed go/withdrawal holds the whole epic, with both boards unchanged and its original values retained. `status` exposes those holds to the approval reader immediately; `publish` refuses them before checkpointing. `set` synchronizes under the same locks and refuses a token invalidated by an import. `go` uses its existing recorded approval operation; sync itself creates no go.

A held epic needs explicit owner resolution. Stop its board writers and execution consumers first. Preserve the hold, both values, baseline and actual owner decision in committed evidence. Resolve the approval or withdrawal from its original records; matching board text grants no approval. Require no pending copy journal for this epic: retry an interrupted recorded-Go request through its original `go` operation with BMAD unchanged; preserve any other unresolved journal for recovery before acknowledging the hold. Align the affected rows using the status mapping and full-note projection. Remove only this epic's `holds` entry in `bmad-copy.json`. For an acknowledged withdrawal or deletion, also advance only its resolved row baselines (`last_copied` to BMAD, `source_value` to the plan, `source_token` to `rowToken(key, status, note)`, and matching `note_projection`); if both rows are absent use null for all three baseline fields and remove its note projection. Retain conflict originals and sibling holds. Recheck that inputs stayed unchanged, replace metadata atomically, and commit the resolution before resuming consumers. Run `sync`, `check`, and updated `run_needs.py N`: any remaining authority mismatch holds again, and a committed withdrawal still needs a subsequent genuine recorded Go. Do not use this manual procedure while other writers are active.

Existing version-1 one-way copies retain their eligibility/exclusion rules until an explicit fresh cut and verified cutover replace them. Only those copies support `bmn plan copy --row KEY --expect TOKEN`; it cannot bypass a version-2 hold.

Prepared BMAD parsers preserve blocked, deferred and withdrawn rows during regeneration, including omitted definitions. A fresh rebuild requires explicit confirmed `--set` repairs for held rows. Selection excludes held stories and descendants of held epics; blocked or deferred work prevents a false completion result. This preparation does not normalize unrelated legacy statuses.

`cutover --repo REPO --handover HANDOVER.json` follows D13's remote default branch (`master` on Q); `--upstream REF` explicitly chooses another captured upstream. With no remote it uses the canonical checkout's current commit. A switch outside the canonical default checkout parks as `NOT_DEFAULT_CHECKOUT`; a missing one parks as `NO_DEFAULT_CHECKOUT`. It reconciles all worktrees, captures their inputs and hashes, and parks if inputs keep changing for three passes. The handover must name every discovered worktree and writer, with `inventory_verified: true`, `worktrees: [absolute paths]`, and `writers: [{id, state: "acknowledged", closed_descriptors: true, closed_mappings: true, children_quiescent: true}]` (or `state: "ended"`). This is evidence supplied after checking the sessions; an empty writer list alone is no evidence that they ended. Epic 107 exercises this only in scratch clones; real cutover belongs to Epic 108.

An unrelated worktree still parks reconciliation unless the owner has explicitly designated that exact root and HEAD as historical. Only then may the handover include `historical_worktrees: [{root: "/absolute/registered/worktree", head: "full-commit-id", evidence: "owner decision and its record"}]`; the read-only `reconcilePlan` API takes the same declarations as `historicalWorktrees`. Every historical planning image at HEAD, index and working tree is captured, together with the complete original index (including its shared-index companion when split), a bundle of reachable commit history and the worktree registration. These remain local archives and contribute no canonical plan values or approval conflicts. No merge base is invented; undeclared unrelated history, a different HEAD, a related history, an absent registration or exclusion of the canonical checkout still refuses. Originals and registrations stay intact, and writer handover, final rehash (including index and registration hashes) and fencing still apply to every worktree.

The common Git lease blocks installed `set`, `go` and `publish` writers for up to 60 seconds. Old planning files and folders are read-only through the final capture and switch. A separate pidfd watchdog restores their exact original modes even if the lead is killed. Readers remain on BMAD until the journaled move commit reaches the default checkout. Retired files remain physically present for recovery, while Git records their deletion. Conflicting local text and each captured input's hash and owner are named in the move's manifest. Product history, files and index entries are preserved.

Rerun the same `cutover` after an interruption; it restores permissions, checks the installed state and includes intervening old-file edits. A changed partial new plan is kept and reported for settlement. `rollback --repo REPO --handover HANDOVER.json` creates a new commit reverting only the move's paths, maps later row changes back to the old board, and keeps the full post-cutover plan and preparation snapshot under locally ignored `plan-rollback/`. Later product commits and unrelated staged or working changes stay. A removed row is retained as `withdrawn`, so BMAD cannot select it. A conflicting later old-file edit parks rollback with both inputs retained. Rerun rollback to finish its journal; other writers refuse `ROLLBACK_INTERRUPTED` until then.

An old branch that edited the retired board gets Git's delete/modify conflict when merging the moved default branch. First compare its kept board against the canonical plan and the migration's retained input. Once that edit is accounted for, resolve the retired path with `git rm -- OLD_BOARD`, resolve any other listed conflicts, and commit the merge. `bmn plan status --json` then reads the default checkout's plan; use the same row key and its fresh token with `bmn plan set`. Do not recreate a second board or reset the branch.

Rollback also refuses `ROLLBACK_COPY_CONFLICT` when a later BMAD edit differs from both the recorded last copy and the intended replay. Both plans survive for explicit resolution. Cutover creates and verifies its linked archive before switching. The approval reader and ledger bind `moved_from` and the history pin to the original committed move; editing or removing working migration declarations grants nothing and cannot select another ledger.

## Not worse than BMAD: the parity map

Every row names what runs after BMAD is gone.

**Status (2026-11-06, Epic 108):** BMN and dev-auto write and run BMN plans only. Q-Automations and AI-Invoices moved their unfinished epics and deleted BMAD; b2buster moved and keeps BMAD's board for Artem, written only by the two-way sync; a dormant BMAD project (PICHER_v2) is read and names the move. BMAD's own skills stay in the projects that ship them; BMN neither runs nor installs them.

| BMAD | Ours |
| --- | --- |
| Product brief, PRFAQ, PRD (`bmad-product-brief`, `-prfaq`, `-prd`) | `plan`'s frame method writing `PLAN.md`, scaled to need, with a working-backwards method; a larger product gets linked truth documents |
| Architecture (`bmad-architecture`), UX (`bmad-ux`: DESIGN.md, EXPERIENCE.md) | `PLAN.md`'s required Architecture section and `plan`'s architecture method (invariants, contracts, quality targets, providers), reconciled in readiness; the design method (flows, states, sizes, interaction) with the team's designer designing screens first, the result becoming truth documents |
| Product vision and principles (BMAD's brief and PRD hold them per document) | `plan/VISION.md`, the foundation every plan builds on, and `plan`'s vision method; each epic names the principles it serves |
| Spec (`bmad-spec`), epics and stories (`bmad-create-epics-and-stories`) | Epic files with the same story artifact (criteria, starting points, verification), requirements traced to stories, no interactive halts beyond one card per real decision |
| Readiness (`bmad-sprint-planning`'s gate) | `plan`'s readiness method before asking for the go (requirement-to-story traceability both ways, missing decisions, conflicts with truth documents and other epics) plus `bmn plan check` for structure |
| Sprint status | `status.yaml`, same grammar, explicit go, blocked, paused and dropped, notes bounded |
| Correct course (`bmad-correct-course`) | `plan`'s change-impact method: affected stories, criteria and truth documents; a dated decision with its source; the operative criteria updated, the earlier revision kept in the plan's history |
| Retrospective | dev-auto's epic review and close-out with truth impact reviewed |
| Brainstorming, forge idea, advanced elicitation, party mode, deep recon | `plan`'s methods, loaded on demand: brainstorm, question an idea, critique (pre-mortem, red team, first principles), roundtable (several teammates through `bmn team ask`), research (`bmn research ask`, a research brief, choosing between candidates) |
| Project context (`bmad-project-context`) | The project's `AGENTS.md`, unchanged |

Better on: what an agent reads for one epic (the frame, one epic file and its rows instead of one growing file); owner interruptions (cards for real decisions only); drift (truth impact required, reviewed at close against delivered behavior); board hygiene and safety (bounded notes, single-row guarded updates, explicit go, blocked, paused and dropped); one skill in every app with no runtime to install or break.

### The parity checklist

Fixed pass/fail items, marked for each run by a reviewer of the team who wrote neither run (Story 77.3 AC4). Two synthetic fixtures: a new project, and a change to an existing project with docs. BMAD 6.12.0 as installed and `plan` each run both fixtures with the same model and effort; BMAD's halts are answered from the fixture's written owner brief. Mandatory items (ours must pass every one):

1. **Frame.** A new project's frame has a `VISION.md` with sourced principles, states product, users, goals and non-goals, and has an Architecture section (or links the document that does) and its design decisions.
2. **Traceability forward.** Every requirement is covered by at least one story.
3. **Traceability back.** Every story names the requirements it covers; none covers nothing.
4. **Story artifact.** Each story has numbered testable criteria and a named verification.
5. **Starting points.** Each story of the existing-project fixture names starting points that exist in its code (path and line checked).
6. **Readiness: missing decision.** The readiness method finds the decision the fixture's brief leaves open on purpose and asks for it (one card) instead of guessing.
7. **Readiness: conflict.** The readiness method finds the planted conflict between the brief and a truth document or another epic.
8. **Change impact.** Given the planted mid-flight change, it names the affected stories, criteria and truth documents, records a dated decision with its source, updates the operative criteria and keeps the earlier revision recoverable.
9. **Truth close-out.** The epic's Truth impact names the truth documents the change touches (or `none` with a reason).
10. **Board.** The board uses the format's statuses correctly (go as `ready`, nothing `done` before acceptance) and `bmn plan check` (or BMAD's own validation for the BMAD run) passes.
11. **No BMAD.** Every method used runs in a home where BMAD is absent (ours only).
12. **Readiness: vision conflict.** The readiness method finds the planted epic that works against a stated principle and puts it to the owner instead of planning it.
13. **Readiness: invariant.** The readiness method finds the planted story that would break a stated architecture invariant or contract.
14. **Readiness: proof.** The readiness method finds the planted criterion whose named Verification cannot observe it on the owner's path (a unit test for a packaged-only behavior, or a capability the real system does not expose).

Recorded per run, not pass/fail: the checked revision, what the run read (files and bytes), how often it stopped for the owner, and its failures. A failure is fixed and the checklist run once more; a second failure goes to the owner before BMN's move (Story 77.6).
