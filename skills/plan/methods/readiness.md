# Readiness

Run before asking the owner for his go on an epic (or a set of epics). The question: **could an implementing agent build these stories without inventing a decision nothing records?** `bmn plan check` covers structure; this is the content check.

## Checks

1. **Traceability forward.** List every requirement (the epic's `RN-FR`/`RN-NFR`, and the Outcome). Each appears in at least one story's Coverage, and that story's criteria actually establish it.
2. **Traceability back.** Each story names what it covers; a story covering nothing is cut or tied to a requirement.
3. **Missing decisions.** For each story, name the decisions it relies on (a data shape, a library, a screen, a limit, a provider, who may do what). Each is recorded (the epic's Decisions, `PLAN.md` Decisions, a truth document) or it is a finding. A decision only the owner can make becomes a card; a technical one you decide and record.
4. **Conflicts.** Compare the epic with the truth documents it touches, with `PLAN.md`'s constraints and with other unfinished epics (their Boundary and their stories on the same files). Every disagreement is a finding: name both sides with their locations.
5. **Story shape.** Each story: one lead session; depends only on earlier stories; numbered testable criteria; a named Verification; starting points that exist (open each `file:line`).
6. **Truth impact** names every document the stories change.
7. **Order and gates.** Stop gates (measure first) come first; owner-only checks are their own story; the Boundary names what is out of scope.

## Verdict

- **PASS**: one line, then ask for the go (one card).
- **CONCERNS**: list each with its location and your proposed fix; fix what is yours, card what is his, then rerun.
- **FAIL**: the plan cannot be built as written; findings by severity, each with the fix; do not ask for the go.

Record the verdict and its date in the epic's Reviews.
