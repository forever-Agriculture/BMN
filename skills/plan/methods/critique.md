# Critique

Use on a draft (an epic, a frame, a design decision) before readiness, when it would gain from deliberate pressure. Pick the technique that fits; one is often enough.

- **Pre-mortem.** It is three months later and this failed. Write the five most likely reasons, each concrete (which story, which assumption, which dependency). For each: an early signal and a change to the plan that prevents or detects it.
- **Red team.** Argue against the plan as someone who wants it to fail or who pays for its mistakes: a hostile input, a race, a privacy leak, a cost overrun, an owner surprise. Each attack names the story and criterion it breaks and the criterion that would catch it.
- **First principles.** Strip the plan to the goal and the hard constraints. Rebuild the simplest plan that meets them from scratch. Compare with the draft: what does the draft carry that nothing requires?
- **Inversion.** List what would guarantee failure; check the plan avoids each.
- **Scale and edges.** What happens at zero, one, many, huge; on restart; when a dependency is down; with the owner away?
- **Cost of being wrong.** For each consequential decision: reversible or not, and what it costs to undo. Irreversible ones deserve a stop gate or a card.

Write the findings as concrete changes to stories and criteria; apply yours, card his. Record the critique's verdict in the epic's Reviews. A teammate's independent critique: [roundtable.md](roundtable.md).
