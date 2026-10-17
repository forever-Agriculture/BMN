---
name: plan
description: Plan a project's work with the owner: frame a project, plan or revise epics and stories with testable criteria, check readiness before his go, and keep the board he reads (plan/status.yaml, or a BMAD project's own files). Use for any planning, epic or story writing, readiness check, change of course, brainstorm, idea critique or planning research in any project; not for implementation.
---
# MODULE: SKILL.md - Story 77.3 (revision 3: a code starting point for every story): the plan skill: how any agent plans a project in BMN's own format (or a BMAD project's existing files) to at least BMAD's standard, with methods loaded on demand

# Plan

Planning turns the owner's intent into epics an implementing agent can deliver without inventing decisions. You write the plan; he decides. The format is in BMN's `docs/planning.md`; the templates are beside this file in `templates/`.

## First: which plan

Run `bmn plan status --json` in the project (no BMN needed). It names the product root, the plan root, the board, the format (`bmn-plan` or `bmad`) and the history mode.

- **`bmn-plan`**: write `plan/PLAN.md`, `plan/epics/NNN-slug.md` and rows in `plan/status.yaml`.
- **`bmad`**: write the project's existing BMAD files in their existing shape (its epics file or epic files, its `sprint-status.yaml`), with the same rules below. Never create `plan/` in a BMAD project and never reformat or migrate its files.
- **No plan yet** (`NO_PLAN`): create `plan/` from the templates, and add `/plan/` to `.gitignore` only when the owner says the plan stays out of the product repository (then `git init` inside `plan/`, no remote).
- **An error** (`BOTH_PLANS`, `UNKNOWN_SCHEMA`, `MALFORMED`): stop and tell the owner; never pick one plan yourself.

Read `PLAN.md` (the frame) and only the epic files and rows your task needs; open references and logs on demand.

## The rules every plan keeps

1. **Ground it.** Read the code and the measured use before writing a word: what exists today, with `file:line` starting points you opened yourself, for every story, in code and not only in docs (a later story's code or a README line is not a starting point on its own). Count real use where it decides scope (rows in a database, transcripts, logs), read-only. A claim you did not check is marked as such.
2. **His words, dated.** Quote the owner's words with their date in the epic's Why and wherever a decision rests on them. Never invent a past decision; look it up (`~/brain`, the plan's Decisions, the epic Logs).
3. **One card per decision.** A choice only he can make (scope, money, privacy, public interfaces, a trade-off the evidence cannot settle) goes to him as one selectable card with your recommendation first, in the session (AskUserQuestion; `bmn ask` only mirrors it). Log each answer in the epic's Decisions with its date. Decide everything else yourself and say so in one line.
4. **Small stories.** One lead session finishes a story. A story has a user-visible or owner-visible result, depends only on earlier stories, and creates only what it needs (no "set up everything" stories). A stop gate (measure first) is its own story, first.
5. **Testable criteria.** Numbered Given/When/Then criteria, each observable, with a **Verification** naming the check: unit tests, a scripted run, a live check, an owner check. No criterion says "works well".
6. **Requirements traced both ways.** Each requirement (`RN-FR1`, `RN-NFR1`) is covered by a story (its Coverage line); each story covers at least one requirement or the Outcome.
7. **People from the team.** The suggested lead, designer and reviewer come from `bmn roster role lead|designer|epic-reviewer --json` (and `bmn team --all --json` for each agent's app and provider), never from memory: one line right under the epic heading, `**Suggested lead:** Opus 🇺🇸 — reason tied to this epic`, with its flag, and the same hint at the start of the epic row's note. Pick by scope and risk: a provider the project keeps private data away from never leads it.
8. **Designer first for screens.** An epic that adds or changes screens starts with a design story by the team's designer; the owner approves the design before any screen story starts, and the approved design becomes a truth document.
9. **Consult when it pays.** When the owner asks, or a named risk calls for it (security, privacy, data loss, a migration, a contract other teams depend on), ask a teammate with `bmn team ask --role consultant|epic-reviewer` (read-only, a stable `--key`), apply what holds, and record each finding's disposition in the epic's Reviews or a `references/` file. Advice is not a decision.
10. **Truth impact.** Every epic names the truth documents and contracts it adds, changes or removes (or `none` with a reason). Truth lives in the project's docs; the epic proposes the change.
11. **Readiness before the go.** Run [methods/readiness.md](methods/readiness.md) before asking for his go. His go is recorded as the epic row's status `ready` with the date in its note, and the epic joins `queue`. The go never covers push, merge or deploy; implementing stays with the invocation that selects the work.
12. **Check before handing back.** `bmn plan check` passes (it is structural only; your readiness pass is the content check).

## Writing an epic

Copy `templates/epic.md` to `plan/epics/NNN-slug.md` (three digits at least). Fill Outcome, Why, Boundary and dependencies (order of stories, what is out of scope), Truth impact and Stories; add What exists today, Requirements and Decisions when they carry weight. Keep an active epic under 60 KiB: measurements and long evidence go to `plan/references/<epic>/` and are linked.

Add its rows (and, at his go, the epic's number in `queue:`) to `status.yaml` by editing the file in place; `bmn plan set` only changes rows that exist: `epic-N: backlog # Suggested lead: … · short note` and one `N-M-slug: backlog` per story, below the last epic's rows. Keep every other line as it is; notes stay under 160 characters (the run log goes in the epic's Log). Change an existing row with `bmn plan set <row> <status> --expect TOKEN` (the token from `bmn plan status --json`), never by rewriting the file. It keeps the board's last 20 versions under `$XDG_STATE_HOME/bmn/plan-versions/` (default `~/.local/state`).

Identifiers are never renumbered: a dropped story keeps its number and gets status `dropped` with the decision in its note.

## Revising

A change to a planned or running epic uses [methods/change-impact.md](methods/change-impact.md): affected stories, criteria and truth documents, a dated decision with its source, the operative criteria updated in place, the earlier revision kept in the plan's history (the plan repository's commit, or the epic's Log naming what changed). Never edit a `done` story's criteria; plan the change as new work.

## Methods (load the one you need)

| Need | Method |
| --- | --- |
| A new project or a product decision: frame, users, goals, working backwards | [methods/frame.md](methods/frame.md) |
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
