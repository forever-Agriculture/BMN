# Readiness

Run before asking the owner for his go on an epic (or a set of epics). The question: **could an implementing agent build these stories without inventing a decision nothing records?** `bmn plan check` covers structure; this is the content check.

## Checks

1. **Traceability forward.** List every requirement (the epic's `RN-FR`/`RN-NFR`, and the Outcome). Each appears in at least one story's Coverage, and that story's criteria actually establish it.
2. **Traceability back.** Each story names what it covers; a story covering nothing is cut or tied to a requirement.
3. **Missing decisions.** For each story, name the decisions it relies on (a data shape, a library, a screen, a limit, a provider, who may do what). Each is recorded (the epic's Decisions, `PLAN.md` Decisions, a truth document) or it is a finding. A decision only the owner can make becomes a card; a technical one you decide and record.
4. **Conflicts.** Compare the epic with the truth documents it touches, with `PLAN.md`'s constraints and with other unfinished epics (their Boundary and their stories on the same files). Every disagreement is a finding: name both sides with their locations.
5. **Story shape.** Each story: one lead session; depends only on earlier stories; numbered testable criteria; a named Verification.
6. **Starting points, story by story.** For every story (owner checks, blocked and dropped ones included) open each `file:line` it names in this pass and mark it `exists` (that code is there today, at that line) or `new` (an earlier story creates it; name the story). In a project that has code, every story needs at least one `exists` anchor **in code** (source, tests, scripts, config), not only in documentation: a story that changes docs or is checked by the owner names the code its words describe, and a dropped story keeps the code anchor it was planned on. A story without one is a finding, unless it names the file it creates and the existing code that will call it. Put the table (story, anchor, exists/new, what is there) in `plan/references/<epic>/readiness-<date>.md` and link it from Reviews.
7. **Truth impact** names every document the stories change.
8. **Vision.** The epic's Why names the `VISION.md` principles it serves; nothing in it works against another principle or a refusal. A conflict is a finding with both sides quoted; resolving it is the owner's card, never a quiet rewrite.
9. **Architecture.** For each part, invariant, shared contract, quality target and provider the stories touch, the criteria keep it or the epic proposes the change (Truth impact names the document). An invariant a story would break, or a contract changed without its owner's consumers, is a finding. Open decisions the stories depend on are findings until decided.
10. **Capability and proof.** For each criterion: does the real system expose what it needs (the hook event, the API field, the screen state, the permission), checked in its code, documentation or a measurement, not assumed? And can the named Verification observe it on the path the owner uses (packaged build, real app, his phone), not only in a unit test? A criterion that cannot be proved as written is a finding: add a measure-first story or change the check.
11. **Design and rollout, when they apply.** A screen story cites an approved design and names its states and sizes ([design.md](design.md)). An epic that changes stored data, compatibility or the installed release has a Rollout section with recovery and an installed-build check.
12. **Order and gates.** Stop gates (measure first) come first; owner-only checks are their own story; the Boundary names what is out of scope.

## Verdict

- **PASS**: one line, then ask for the go (one card).
- **CONCERNS**: list each with its location and your proposed fix; fix what is yours, card what is his, then rerun.
- **FAIL**: the plan cannot be built as written; findings by severity, each with the fix; do not ask for the go.

Record the verdict and its date in the epic's Reviews.
