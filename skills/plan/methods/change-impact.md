# Change impact

Use when something changes after planning: a measurement disproves an assumption, the owner changes his mind, a review finds a gap, an implementation hits a wall, another epic moves.

## Steps

1. **The trigger.** What changed, with its evidence (a measurement, his dated words, a failing check) and its source location. No evidence, no change: ask for it or measure.
2. **The problem.** One precise statement, and its kind: technical limit found, new requirement, misunderstood requirement, strategy change, failed approach.
3. **Impact.** Walk the plan and list what is affected:
   - stories and criteria of this epic (by identifier: `78.2 AC3`), done ones included;
   - other epics (their Boundary, their stories on the same contracts or files);
   - truth documents and contracts;
   - the board (statuses, queue order);
   - work already built on the old assumption.
4. **Options.** Usually two or three: adjust the stories in place; add a story or an epic; descope (status `dropped` with the reason); stop and ask. For each: cost, risk, what it keeps and loses.
5. **Decision.** Yours when it keeps the owner's requirements, criteria and limits; his (one card, your recommendation first) when it changes scope, acceptance, money, privacy or a public interface. Record it in the epic's Decisions with its date and source.
6. **Apply.** Update the operative criteria in place. Keep the earlier revision recoverable: in a plan with its own repository, commit the plan before and after (SKILL.md, History); otherwise add one Log line naming what changed from what. Never rewrite a `done` story's criteria: plan new work instead. Identifiers stay; new criteria take the next number.
7. **Check.** Rerun [readiness.md](readiness.md) on what changed and `bmn plan check`.
