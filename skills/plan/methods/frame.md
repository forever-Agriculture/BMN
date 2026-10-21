# MODULE: frame.md - Frame a project from repository evidence and optional shared memory
# Frame a project

Use for a new project, or when an existing project's purpose, users or big decisions are unclear. The result is `plan/VISION.md` ([vision.md](vision.md)) and `plan/PLAN.md` (template in `../templates/PLAN.md`), scaled to need: a small tool gets a page; a product gets a page plus linked truth documents.

## Steps

1. **Collect what exists.** Read the repository (README, docs, code layout, tests), the project notes if the project keeps a shared memory, and anything the owner gave you. Work from the repository and supplied evidence when there is no shared memory. Write down the facts with their sources.
2. **Work backwards.** Write the announcement for the finished product in five sentences: who it is for, the problem in their words, what they can now do, why it is better than what they do today, how they start. Then answer, in one or two lines each, the hard questions a skeptical customer and a skeptical engineer would ask: Why would they switch? What does it cost them? What is the riskiest assumption? What is out of scope on purpose? What would make this fail? Keep this as `plan/references/frame/working-backwards.md` when it carried weight; it is not part of `PLAN.md`.
3. **Vision first.** Write or confirm `VISION.md` with [vision.md](vision.md); the frame below builds on its principles.
4. **Fill the frame.** Purpose (one paragraph), Users (each with what they need), Goals (outcomes, measurable where possible), Non-goals (deliberate exclusions), Success signals (what we observe when it works), Standing constraints (platform, privacy, budget, the owner's standing decisions with dates).
5. **Architecture.** Write the Architecture section with [architecture.md](architecture.md): a link to the architecture document, the contract inline, or `None needed` with its reason.
6. **Decisions.** For architecture and design: the decisions in force, each with its date, its reason and its source (a card, a consult, a document). For a product with real structure (several services, a data model, a UI system), write or link a truth document (`docs/architecture.md`, `docs/design.md`) instead of growing `PLAN.md`. Screens: the team's designer designs first (`bmn roster role designer`); the approved result is the design truth.
7. **Truth documents.** Index every document that describes the product as it is now.
8. **Cards.** Each choice only the owner can make (target users, a non-goal he may disagree with, a platform, money) is one card with your recommendation; record the answer in Decisions with its date.
9. **Check.** `bmn plan check` passes; `PLAN.md` stays under 20 KiB.

## Done when

A new agent reading only `VISION.md` and `PLAN.md` can say what the product is for, who uses it, what it will not do, which decisions bind every epic and where the truth documents are.
