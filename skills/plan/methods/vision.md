# MODULE: vision.md - Record the owner's vision using project evidence and optional shared memory
# Vision

Use when a project has no `plan/VISION.md`, when the owner states a new principle, or when an epic seems to pull against what the project is for. The result is `plan/VISION.md` (template in `../templates/VISION.md`): the foundation `PLAN.md` and every epic build on.

## Steps

1. **Collect his recorded words.** Read the plan's Decisions, the epics' Why sections and the cards the owner answered. If the project keeps a shared memory, also read its project note (Vision or Goal and Log) and linked philosophy notes. Work from the project's records when it has no shared memory. Note each principle-like statement with its date and source. Never invent one; a strong pattern without a quote is a sourced synthesis.
2. **Write the vision.** One paragraph: what the project becomes, for whom, what it changes for them.
3. **Write the principles.** Numbered, one line each, then the source: his words with their date, or "synthesis of <sources>". Five to twelve is typical; merge overlaps; keep only rules that would change a decision. Mark anything he has not confirmed *provisional*.
4. **We refuse.** Only the refusals he has stated or that follow directly from a principle.
5. **One card.** Show him the draft (the principles, provisional ones marked) and ask for approval or changes in one card. Record his answer in the Log with its date; drop *provisional* from what he confirmed.
6. **Check.** `bmn plan check` passes (sections, unique principle numbers, at most 8 KiB).

## Changing it

Only the owner changes substance. When he states a new principle or reverses one, add or reword it under the next free number (never renumber; a retired principle stays with *retired YYYY-MM-DD*), and add a Log line with his words. Then run [change-impact.md](change-impact.md) on unfinished epics that cite it.

## Done when

An agent reading only `VISION.md` can say why the project exists, which principles would make it refuse a tempting plan, and where each principle came from.
