# Architecture

Use when framing a project, when an epic adds or changes a component, shared data, an interface, a provider or a quality target, and in readiness. The result is `PLAN.md`'s **Architecture** section: a link to the architecture truth document with a two-line summary, the contract inline, or `None needed: <reason>` (a small tool whose stories share no state or contracts).

## What it holds

Keep only what epics must respect; a rule that changes no decision does not belong.

- **Parts and owners:** each component or module, what it owns, what it may depend on.
- **Invariants:** `A1`, `A2`, … never renumbered: the rule, its scope and the failure it prevents. An invariant is enforceable: a test, a check or a review can show it broken.
- **Shared data and interfaces:** data, files, APIs and events that several stories touch, and their contract (shape, owner, compatibility).
- **Quality targets:** only budgets that matter (latency, size, memory, privacy, reliability), each with how it is measured.
- **Technology choices:** the choice, why, the evidence; an alternative rejected only when that rejection keeps being re-asked.
- **Privacy and providers** (when data leaves the machine or crosses an authority boundary): data → destination or provider → who authorized it → retention; each credible abuse or failure → its control or check.
- **Glossary** (when ambiguity has cost something): the term, its one meaning, the states it can be in.
- **Assumptions and open decisions:** the assumption or question, what would settle it, the work it blocks.

## Steps

1. **Read what is there.** The code layout, the architecture document if any, the tests that pin contracts, the plan's Decisions. Write facts with `file:line`.
2. **Write or update** the section (or the linked document, for a product with real structure). A proposed change stays in its epic until delivered; the epic's Truth impact names the document.
3. **Decide or card.** A technical choice the evidence settles, you decide and record with its reason. A product, privacy or money trade-off is one card to the owner.
4. **Review when it pays.** A change to a shared contract, an invariant, a provider or a migration gets one consultant review (`bmn team ask --role consultant`); record dispositions.

## Done when

An implementing agent can tell, before writing code, which parts it may touch, which invariants its change must keep, which contracts others rely on and which targets it must not break.
