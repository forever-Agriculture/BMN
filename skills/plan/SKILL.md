---
name: plan
description: >-
  Plan a project's work with the owner: frame a project, plan or revise epics and stories with testable criteria, check readiness before his go, and keep the board he reads (plan/status.yaml, or a BMAD project's own files). Use for any planning, epic or story writing, readiness check, change of course, brainstorm, idea critique or planning research in any project; not for implementation.
---
# MODULE: SKILL.md - Story 77.3 (revision 5: a BMAD project read through one table, Sol review F8; revision 4: vision and architecture as the foundation, owner 2026-10-17): the plan skill: how any agent plans a project in BMN's own format (or a BMAD project's existing files) to at least BMAD's standard, with methods loaded on demand

# Plan

Planning turns the owner's intent into epics an implementing agent can deliver without inventing decisions. You write the plan; he decides. The format is in BMN's `docs/planning.md`; the templates are beside this file in `templates/`.

## First: which plan

Run `bmn plan status --json` in the project (no BMN needed). It names the product root, the plan root, the board, the format (`bmn-plan` or `bmad`) and the history mode.

- **`bmn-plan`**: write `plan/VISION.md`, `plan/PLAN.md`, `plan/epics/NNN-slug.md` and rows in `plan/status.yaml`.
- **`bmad`**: write the project's existing BMAD files in their existing shape (its epics file or epic files, its `sprint-status.yaml`), with the same rules below read through [In a BMAD project](#in-a-bmad-project). Never create `plan/` or any of its files in a BMAD project and never reformat or migrate its files.
- **No plan yet** (`NO_PLAN`): create `plan/` from the templates, and add `/plan/` to `.gitignore` only when the owner says the plan stays out of the product repository (then `git init` inside `plan/`, no remote).
- **An error** (`BOTH_PLANS`, `UNKNOWN_SCHEMA`, `MALFORMED`): stop and tell the owner; never pick one plan yourself.

Read `VISION.md` (what the project is for and its principles) and `PLAN.md` (the frame and its Architecture), then only the epic files and rows your task needs; open references and logs on demand. A `bmn-plan` project without `VISION.md` gets one first ([methods/vision.md](methods/vision.md)).

### In a BMAD project

This skill and its methods name BMN's files and statuses. In a `bmad` project read each name through this table, keep BMAD's shape and vocabulary, and never write anything the table does not name:

| The skill says | In a BMAD project |
| --- | --- |
| `VISION.md`, its principles | the project's existing vision: its product brief or PRD, else a `## Vision` section in the epics file's front matter, added only with the owner's yes (a card) |
| `PLAN.md`, its Architecture | the existing PRD, architecture and UX documents and the epics file's front matter |
| `plan/epics/NNN-slug.md` | the project's epics file (or its epic files), in its existing heading shape |
| `plan/references/<x>/` | the folder beside its planning files (`_bmad-output/planning-artifacts/<x>/` unless its config names another) |
| status `ready` and the `queue` | a story `ready-for-dev`; an epic's go is a dated `go YYYY-MM-DD` comment on its row; the order is the epics file's |
| `blocked`, `paused`, `dropped` | the row keeps its BMAD status, with a dated comment naming the state and its reason |
| `bmn plan set` | the same command; it takes BMAD's statuses (`backlog`, `ready-for-dev`, `in-progress`, `review`, `done`) |

Every other rule holds as written.

## The rules every plan keeps

0. **Build on the vision and the architecture.** Every epic serves named `VISION.md` principles (its Why says which) and keeps `PLAN.md`'s Architecture: its invariants, contracts and targets, or it proposes the change openly. A plan that pulls against a principle goes to the owner as a card; only he changes the vision.
1. **Ground it.** Read the code and the measured use before writing a word: what exists today, with `file:line` starting points you opened yourself, for every story, in code and not only in docs (a later story's code or a README line is not a starting point on its own). Count real use where it decides scope (rows in a database, transcripts, logs), read-only. A claim you did not check is marked as such.
2. **His words, dated.** Quote the owner's words with their date in the epic's Why and wherever a decision rests on them. Never invent a past decision; look it up in the plan's Decisions and epic Logs, and in the project's shared memory if it keeps one.
3. **One card per decision.** A choice only he can make (scope, money, privacy, public interfaces, a trade-off the evidence cannot settle) goes to him as one selectable card with your recommendation first, in the session (AskUserQuestion; `bmn ask` only mirrors it). Log each answer in the epic's Decisions with its date. Decide everything else yourself and say so in one line.
4. **Small stories.** One lead session finishes a story. A story has a user-visible or owner-visible result, depends only on earlier stories, and creates only what it needs (no "set up everything" stories). A stop gate (measure first) is its own story, first.
5. **Testable criteria.** Numbered Given/When/Then criteria, each observable, with a **Verification** naming the check, where it runs (unit, isolated live run, packaged build, the owner's phone), what it observes and who runs it. The real system must expose what each criterion needs; when that is not yet known, measure first. No criterion says "works well".
6. **Requirements traced both ways.** Each requirement (`RN-FR1`, `RN-NFR1`) is covered by a story (its Coverage line); each story covers at least one requirement or the Outcome.
7. **People from the team.** The suggested lead, designer and reviewer come from `bmn roster role lead|designer|epic-reviewer --json` (and `bmn team --all --json` for each agent's app and provider), never from memory: one line right under the epic heading, `**Suggested lead:** Opus 🇺🇸 — reason tied to this epic`, with its flag, and the same hint at the start of the epic row's note. Pick by scope and risk: a provider the project keeps private data away from never leads it.
8. **Designer first for screens.** An epic that adds or changes screens starts with a design story by the team's designer ([methods/design.md](methods/design.md): flows, states, sizes, interaction); the owner approves the design before any screen story starts, and the approved design becomes a truth document.
9. **Consult when it pays.** When the owner asks, or a named risk calls for it (security, privacy, data loss, a migration, a contract other teams depend on), ask a teammate with `bmn team ask --role consultant|epic-reviewer` (read-only, a stable `--key`), apply what holds, and record each finding's disposition in the epic's Reviews or a `references/` file. Advice is not a decision.
10. **Truth impact.** Every epic names the truth documents and contracts it adds, changes or removes (or `none` with a reason). Truth lives in the project's docs; the epic proposes the change.
11. **Readiness before the go.** Run [methods/readiness.md](methods/readiness.md) before asking for his go. His go is recorded as the epic row's status `ready` with the date in its note, and the epic joins `queue` (a BMAD project: the table above). The go never covers push, merge or deploy; implementing stays with the invocation that selects the work.
12. **Check before handing back.** `bmn plan check` passes (it is structural only; your readiness pass is the content check).

## Writing an epic

In a BMAD project, write the epic in its epics file in the shape its other epics have, with this section's content; the paths and statuses below are BMN's format's.

Copy `templates/epic.md` to `plan/epics/NNN-slug.md` (three digits at least). Fill Outcome, Why (with the principles it serves), Boundary and dependencies (order of stories, what is out of scope), Truth impact and Stories; add What exists today, Requirements, Decisions, Assumptions and Rollout when they carry weight. Keep an active epic under 60 KiB: measurements and long evidence go to `plan/references/<epic>/` and are linked.

Add its rows (and, at his go, the epic's number in `queue:`) to `status.yaml` by editing the file in place; `bmn plan set` only changes rows that exist: `epic-N: backlog # Suggested lead: … · short note` and one `N-M-slug: backlog` per story, below the last epic's rows. Keep every other line as it is; notes stay under 160 characters (the run log goes in the epic's Log). Change an existing row with `bmn plan set <row> <status> --expect TOKEN` (the token from `bmn plan status --json`), never by rewriting the file. It keeps the board's last 20 versions under `$XDG_STATE_HOME/bmn/plan-versions/` (default `~/.local/state`).

Identifiers are never renumbered: a dropped story keeps its number and gets status `dropped` with the decision in its note.

## Revising

A change to a planned or running epic uses [methods/change-impact.md](methods/change-impact.md): affected stories, criteria and truth documents, a dated decision with its source, the operative criteria updated in place, the earlier revision kept in the plan's history (the plan repository's commit, or the epic's Log naming what changed). Never edit a `done` story's criteria; plan the change as new work.

## Methods (load the one you need)

| Need | Method |
| --- | --- |
| A new project or a product decision: frame, users, goals, working backwards | [methods/frame.md](methods/frame.md) |
| What the project is for and its principles; a new or changed principle | [methods/vision.md](methods/vision.md) |
| Parts, invariants, contracts, quality targets, providers | [methods/architecture.md](methods/architecture.md) |
| Screens and flows a person sees: states, sizes, interaction | [methods/design.md](methods/design.md) |
| Before the go: can it be built as written? | [methods/readiness.md](methods/readiness.md) |
| A change mid-flight | [methods/change-impact.md](methods/change-impact.md) |
| Many options, little shape | [methods/brainstorm.md](methods/brainstorm.md) |
| A half-formed idea to test | [methods/question-an-idea.md](methods/question-an-idea.md) |
| Stress a draft: pre-mortem, red team, first principles | [methods/critique.md](methods/critique.md) |
| Several independent views | [methods/roundtable.md](methods/roundtable.md) |
| Facts from the web, a research brief, choosing between candidates | [methods/research.md](methods/research.md) |

Each method runs with BMAD absent and needs nothing but the project, `bmn` and the team.

## History and commits

Where the plan has its own repository (`history: plan-repository`), commit at each planning checkpoint (a drafted epic, a revision, a recorded go):

1. If `git -C plan status --porcelain` shows changes you did not make (the owner's or dev-auto's board edits), commit those first, alone: `git -C plan add -A && git -C plan commit -m "owner and run edits before <your change>"`.
2. Then commit only the plan files you changed, naming them: `git -C plan add status.yaml epics/078-x.md && git -C plan commit -m "plan: <what changed>"`.

Never stage files outside `plan/`, never add a remote, never commit in the product repository for an ignored plan. A plan the product repository tracks is committed with the product repository's normal rules; ask before committing there.

## Handing back

End with: what you planned or changed (paths), the decisions you took for him (one line each), the cards still open, the readiness verdict, and `bmn plan check`'s result. The owner reads the board and the epic; keep the reply short.
