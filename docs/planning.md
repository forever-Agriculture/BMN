# Planning

How a project is planned with BMN (Epic 77): one small format in the project, one board the owner reads and edits, one command that reads, checks and changes it (`bmn plan`), and one planning skill (`plan`) that BMN installs into every agent app. BMAD projects keep working: every reader takes BMAD's board too.

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
- `queue` is the one order of unfinished epics: every `ready` epic is in it; nothing `done` or `dropped` is. `project`-scope work takes the queue first, then any unqueued unfinished epics by number.
- `development_status` holds one line per epic and story in BMAD's row grammar: two spaces, key, colon, status, optionally `# note`. An empty line separates one epic's rows from the next; readers skip empty lines. A note is one line of at most 160 characters; the run log belongs in the epic's Log and the run's evidence.
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

A BMAD board (`sprint-status.yaml`) keeps BMAD's statuses (`backlog`, `ready-for-dev`, `in-progress`, `review`, `done`, `optional`) and its comments as they are.

## Where a plan is found

Every reader (`bmn plan`, the app's dev-auto runs view, dev-auto through `bmn plan status --json`) resolves the same way:

1. The product repository: Git's top level for the directory, and from inside `plan/` with its own `.git` the repository that encloses it.
2. The plan: BMN's (`plan/status.yaml` with `format: bmn-plan`), or BMAD's (`implementation_artifacts` in `_bmad/bmm/config.yaml`, else `_bmad-output/implementation-artifacts/sprint-status.yaml`). Both present, an unknown schema version or an own board without `format: bmn-plan` is an error, never a fall back to BMAD.
3. The checkout: a board the product repository tracks is read in the checkout at hand; an untracked or ignored one exists only in the default checkout and is read there, from any linked worktree.

`bmn plan status --json` reports `product_root`, `default_checkout`, `run_checkout`, `plan_root`, `board`, `board_checkout`, `format`, `tracked` and `history`.

## History

A plan the product repository ignores keeps its history in its own local Git repository inside `plan/`, with no remote (`history: plan-repository`). That is history, not a backup. The planning skill commits the plan files it changed at each planning checkpoint, after first committing separately whatever was uncommitted there (the owner's and dev-auto's board edits); it never stages other files. dev-auto commits nothing in `plan/.git`.

A plan the product repository tracks follows the product repository and dev-auto's two-checkout rule (`history: product-repository`). Only an ignored plan has its own repository.

BMN's own plan is ignored by BMN's public repository (`/plan/` in `.gitignore`).

## `bmn plan`

Works with BMN closed, on either format. Exit 0 done or clean, 1 findings or a refused change, 2 usage error or a plan that cannot be resolved or read.

- `bmn plan status [--json] [--project P] [--epic N]...` prints the resolved paths and the rows, read as a stream with no size limit. A note too long for the terminal is clipped for display and marked with `…`; no row is ever left out, and `--json` gives every selected row whole with its line and row token. A board in BMN's format that cannot be read unambiguously (a repeated key, header or logical identifier such as `1-1-a` beside `1-1-b`, a malformed line, an unknown format or schema version) is refused with exit 2 (`MALFORMED`), so dev-auto stops on it.
- `bmn plan check [--json] [--project P]` is structural validation, one finding per line: duplicate keys, malformed rows, unknown statuses, notes over 160 characters, story headings without rows and rows without headings, duplicate epic, story or criterion identifiers (two board keys for one epic or story among them), repeated header lines, a story row whose epic has neither a row nor a file, missing required sections of the frame or an epic, stories without criteria or Verification, a queue naming an unknown, duplicate or finished epic or missing a `ready` one, a `done` epic with a story neither `done` nor `dropped`, a `blocked`, `paused` or `dropped` row without a reason, a non-legacy file over its ceiling, and from Epic 90 on a missing `## Run needs`, a story without an Owner line, a `before the go` story after a `none` story or an `at the end` story before one. On a BMAD board it checks duplicate keys and row grammar only. Whether the plan says the right thing is for the readiness method and review.
- `bmn plan set <row> <status> --expect TOKEN [--expect-default TOKEN] [--note TEXT] [--project P]` changes one row (below). It does not set an epic row `ready` in a plan with history: that is his go, recorded with `go`.
- `bmn plan go <epic> --source TEXT --approved sha256:HEX|COMMIT --expect TOKEN [--date YYYY-MM-DD] [--note TEXT] [--project P] [--json]` records his go (below).

### Recording his go

The planner asks for the go on one card after readiness, holding the epic row's token and its approval text from `bmn plan status --epic N --json` (`approval_texts`: the SHA-256 of the epic's `## Run needs` and `## Decisions` bodies, each to the next heading of levels 1-4, outer blank space removed; `run_needs.py` hashes them the same way). On his go, `bmn plan go N --source "…" --approved sha256:… --expect TOKEN` records it before any run starts:

- `--source` names his act: his quoted words with their time (`card 2026-10-26T09:30Z: 'Go'`). A `bmn:SESSION/KEY` reference names a decision record an agent made for itself ([dev-auto](dev-auto.md)), so it is refused. A string is what the planner states, not proof of the act; only a real answer of his is recorded. The go date is the source's date unless `--date` gives one.
- `--approved` is the approval text he was shown, or the plan commit he approved. Run needs or Decisions that differ from it, committed or not, are refused (`CHANGED_TERMS`): ask again on the current text.
- It writes one commit of the plan's history holding only the row's change to `ready # go DATE · <note>` and the epic's place last in `queue`, plus the epic file when its approved text is not yet committed (a later edit of it stays uncommitted). Its message carries `Go-Epic`, `Go-Date`, `Approval-Source`, `Approved-Text` and `Approved-File`. Other changed or staged files stay as they were and out of the commit; the board's other uncommitted rows stay uncommitted. The branch moves only if it did not move meanwhile; then the index entry (if it was not staged) and the working board follow, and the commit is read back.
- Refused, writing nothing (exit 1, the code names the missing fact): `NO_OWNER_GO`, `NO_APPROVED_TEXT`, `CHANGED_TERMS`, `CONFLICT` (a stale token), `FINISHED`, `NO_EPIC`, `NOT_COMMITTED` (the epic's rows are not in the history yet), `UNREADABLE_HISTORY`, `COMMIT_FAILED`, `DETACHED`, `NO_HISTORY`, `NOT_DEFAULT_CHECKOUT` (a tracked plan, from a linked worktree), `BMAD` (a BMAD board keeps its dated go comment).
- The same request again finds its commit (`already recorded`) and only completes what a crash left undone, so one act never records two gos; after the go was withdrawn it is refused (`WITHDRAWN`).

dev-auto reads the go back with `run_needs.py N`: GO, its commit, the recorded source and the approved text. A go committed by hand before this command stands, its source unrecorded: one committed before 2026-10-27 and before the history's first `Go-Epic` commit. A hand-committed go after either names no act of his and grants nothing (`NO_GO_RECORD`); so does one whose commit names an approved text it does not hold; a row put back to `backlog` or `dropped` withdraws it. The approved text is Run needs and Decisions only: a story or criterion changed with the go or after it is not bound to it, and `CHANGED_SINCE_GO` does not name it.

### Changing one row safely

`TOKEN` is the row token from `bmn plan status --json`; it covers the row's status and note. `set`:

1. takes the board's sibling lock, `.status.yaml.lock`, present only while a writer works and naming its process and a nonce. A dead writer's lock is cleared by one reclaimer at a time (it holds `.status.yaml.lock.reclaim`) and only while it still holds that writer's text; a writer removes only the lock with its own nonce. A reclaimer that dies leaves its guard, and no writer removes a guard it did not create: a guard alone never blocks a writer, but a dead writer's lock behind a dead reclaimer's guard stays, and `bmn plan set` refuses with `LOCKED`, naming both files, until someone stops every `bmn plan set` and removes both by hand;
2. rereads the file and refuses with exit 1 (`CONFLICT`, showing the row now and its token) when the row no longer matches `TOKEN`;
3. replaces that one line (the note is kept unless `--note` is given) and leaves every other byte as it was, line endings included;
4. keeps the version before in `~/.local/state/bmn/plan-versions/<board hash>/` (the last 20, with `board-path.txt` naming the board);
5. writes a temporary file with the board's mode, checks that the board is still what it read, and renames it into place. When another row changed in the meantime it reads again and retries, at most 5 times.

A missing `--expect`, an unknown row or status, or a note it would write over 160 characters (1,000 on a BMAD board) is refused with exit 2. A board tracked by the product repository and read from a linked worktree is changed in both copies, the default checkout's too: both copies are locked (in one order) and checked before either is written, so a cooperating writer's change refuses the whole set and changes nothing; when the default checkout's row differs, `--expect-default` gives its token. A refusal after one copy was written (possible only for a writer that ignores the lock) names the copy already written and its token (`written` in `--json`).

**What it guarantees, and what not.** Cooperating writers (`bmn plan set`) on different rows both land; the same row is refused as a conflict; the owner's save before the read, or between the read and the final check, is kept (a change to his row is a conflict, a change elsewhere is reread). An editor's save in the instant between the final check and the rename, or a stale editor buffer saved later, is outside the guarantee: the later save wins. Recover from the kept versions: `ls ~/.local/state/bmn/plan-versions/*/board-path.txt` finds the board's folder, and each `.yaml` there is a whole earlier board to compare or copy back.

## Not worse than BMAD: the parity map

Every row names what runs after BMAD is gone.

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
