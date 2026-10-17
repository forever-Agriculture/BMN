# Research

Use when a plan rests on facts outside the project: current practice, a library's limits, prices, a provider's behavior, how others solve it, or a choice between candidates.

## Ways

- **Ask the web through the team:** `bmn research ask --question-file q.md` sends one public question to the team's researcher; the answer names its pages. Use one question per fact; never put private details in it.
- **Search yourself** when your app has web search; cite each source with its date.
- **A research brief** for the owner to run in his own tool when the question is large: the question, why it matters, the sub-questions, what counts as a good source, the output shape. Save as `plan/references/<topic>/research-brief.md`.
- **Read a finished report** he gives you into a short summary with cited sources, in `plan/references/<topic>/`.

## Choosing between candidates

1. Name the candidates and the decision they serve.
2. Fix the criteria and their weights first, from the owner's goals and constraints (cost, fit, risk, lock-in, effort, maturity).
3. Gather evidence per candidate per criterion, each with its source; mark what you could not verify.
4. Try the riskiest candidate on a representative sample when that is cheap.
5. Table, verdict and the runner-up's case; a card when the choice is his.

## Rules

Facts carry their source and date; an unverified claim is marked. Research is input to a decision, never the decision. Large output goes to `plan/references/`, linked from the epic.
