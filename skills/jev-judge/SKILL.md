---
name: jev-judge
description: Ask the team's judge Jev typed questions about one text with `bmn judge ask` and read its numbers by the proof's one rule. Use for a second opinion on one fact of a text, never for a decision.
---

# Jev, the judge

Jev (`jev-1.13`, TypeSafe AI's "System One" model, reached through OpenCode's gateway) writes no
text. One call carries a text and typed questions about it, and numbers come back: how true a
statement is, one label with a confidence, or a number on a rubric. A call takes about a second
and costs about two thousandths of a cent. BMN itself makes the call; no agent app runs Jev.

An answer is advice for whoever reads it. Nothing may be granted, accepted, stopped or spent
because of one.

## What the proof measured

The owner's proof (`~/code/jev-eval`, 2026-10-12) asked 150 invented cases three times each under
a rule fixed beforehand. On the 100 held-out cases all 84 confident answers were right; Jev
stayed silent on about a quarter of the cases where it should have spoken. The bar was 95% of
confident answers right, speaking on 60% of the cases that call for it, and at most 2% of
answers changing between repeats. All of it is synthetic text: a new use is measured there, on
labelled cases, before anything acts on it.

Three uses met the bar:

| Use | Confident answers | Right | Spoke when it should | Changed between repeats |
|---|---|---|---|---|
| Does a pricing-page excerpt give this input price for this model? | 15 | 15 | 75% | 0% |
| Does a report claim "done" while admitting a required check is not done? | 14 | 14 | 70% | 0% |
| Does a review finding name a requirement, a reproduction and a consequence? | 27 | 27 | 90% | 0% |

Two did not, and Jev is not to be used for them:

| Use | Confident answers | Right | Spoke when it should | Changed between repeats | Why it failed |
|---|---|---|---|---|---|
| What does an agent's final message need from the owner? | 10 | 10 | 50% | 0% | speaks on too few cases |
| Is an agent trying the same method against the same failure again? | 18 | 18 | 78% | 5% | answers at 0.88 to 0.90 flipped between repeats |

## How to ask well

- One fact per question. "The report claims the work is complete" and "The report says a
  required check was not run" are two questions, not one.
- A `noul` question is a statement that is true or false of the text, not a question with a
  question mark.
- Give the text and nothing else: no instructions inside it, no second document.
- Name the purpose with `--purpose <word>` (a project, `dev-auto`, `brain`), so the owner sees
  what Jev is used for.
- Where a decision would hang on the second decimal, use `--twice`: the reading is kept only
  where two calls agree, and it is counted as two requests.

## The rule, and "no answer"

BMN reads Jev's numbers under the one rule the proof tested:

- a `noul` of 0.90 or more reads **yes**;
- a `choice` whose confidence and winning probability are both 0.90 or more reads its label;
- a `score` with a confidence of 0.90 or more reads its number, marked sure;
- everything else reads **no answer**. So does a timeout, a failed request and an answer that is
  not Jev's shape.

"No answer" is not "no". A low `noul` was not measured as a denial: it means Jev did not say, and
you decide without it. An answer within 0.02 of the line is marked "near the line".

## What may be sent

Public text only, declared with `--data public`, unless the owner's team allows private work for
both the gateway that receives the request and TypeSafe AI that runs the model; then `--data
private` passes. Private text, or text from a workspace BMN does not hold public, is refused
otherwise. Never put a credential, a key or a token into a text or a question.

## What Jev must never decide

- a permission, or whether a dialog may be answered;
- acceptance of work, an epic or a story;
- waiving a test or a check;
- lifting a stop;
- spending money;
- replacing a review the workflow asks for.

## A worked example

```sh
cat > questions.json <<'EOF'
{
  "claims_complete": {"type": "noul", "instructions": "The report claims that the work is complete."},
  "unfinished_check": {"type": "noul", "instructions": "The report says that at least one required check was not run, failed, or is still pending."}
}
EOF
bmn judge ask --state-file report.txt --questions-file questions.json --data public --purpose dev-auto
```

```text
claims_complete: yes (noul 0.97)
unfinished_check: no answer (noul 0.31)
jev (jev-1.13) · 1 request · 412 input tokens · $0.000017 · 0.8 s
```

Read it as: the report claims to be complete, and Jev did not say that a check is unfinished.
That is not proof that every check ran. `--json` gives the same with Jev's numbers unchanged;
`bmn judge --help` has the three question types and the exit codes (0 answered, 10 refused with
what to do next, 11 to 13 no answer).
