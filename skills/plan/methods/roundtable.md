# Roundtable

Use when a question deserves several independent views: a contested design, an epic's direction, a risk you cannot judge alone. The views come from real teammates, not voices you imagine, so they do not share your reasoning.

## Steps

1. **One question file.** The decision to make, the options you see, the evidence (paths, measurements), the constraints, and what you want back (a recommendation, the strongest objection, a risk you missed). No credentials, no private data beyond what the teammate may read.
2. **Pick the seats** from the owner's team: `bmn roster role consultant --json` (and other roles: `epic-reviewer`, `designer`, `focused-reviewer`). Two or three seats from different providers when the question is consequential; one when it is not. Honor his named picks.
3. **Ask each, read-only, in parallel:**
   `bmn team ask --role consultant --agent <id> --question-file q.md --project <path> --key <date>-<topic>-<id> --json`
   Each answer is advice. Keep the records (`bmn team asks export <id> --output plan/references/<epic>/<name>`).
4. **Synthesize.** Where they agree, where they disagree and why, what each saw that others did not. Weigh by evidence, not by count.
5. **Decide or card.** Decide what is yours and record it; a choice only the owner makes goes as one card with the views summarized and your recommendation. Record each finding's disposition (applied, rejected with the reason) in the epic's Reviews.
