---
name: web-question
description: Ask the web one public question with `bmn research ask` and read its marked answer. Use when a fact must be looked up and you cannot search yourself, as in a dispatched helper run.
---

# Web question

`bmn research ask` puts one question to the web through a researcher the owner's team names. It
runs behind BMN's research fence: the researcher sees the question and nothing else of the
owner's. The answer comes back with every claim tied to a page, and BMN reads each page itself.

## When it is the right tool

- You need a fact that lives on public pages: a price, a version, a limit, how a tool is used.
- You are a helper another agent dispatched. Web tools given to such a run are usually denied,
  and other ways to switch them on are refused by `bmn roster check`. This one is checked.
- You can search yourself in your own session and that works: then you do not need it.

One question is one short public text, at most 2,000 characters. There are 20 a day and one runs
at a time, up to 10 minutes. `a research is running` means wait and ask again; it is not queued.

## What never goes into a question

The question's words leave the computer: to the researcher's provider, and as search terms and
page addresses to whatever sites the search touches. So a question never holds:

- code, or the contents of any file;
- anything from a private repository beyond names that are already public;
- names of people or customers;
- credentials, keys or tokens of any kind;
- a path inside the owner's home folder.

BMN refuses what it can recognise (a credential-shaped word, a home path). It cannot recognise
the rest: that part is yours. Rewrite the question with public names only, or do not ask it.

## How to ask

```sh
printf '%s\n' 'How do people use <public thing>? Name the page for each claim.' | bmn research ask
bmn research ask --question-file question.txt --json
```

`--agent <id>` names another researcher of the team; without it the owner's pick is used.
Exit 0 is an answer, 10 a refusal (its `next` says what to do), 1 a run that failed.

## How to read the answer

Each claim carries the page it came from, a passage quoted from it, and one mark BMN set by
reading that page itself:

- **passage found on the page**: BMN read the page and the quoted passage is there. The claim is
  backed by that page. Whether the page is right is still your judgement.
- **page read, passage not found**: BMN read the page and the passage is not there. The claim is
  not evidence. Do not repeat it as a fact.
- **page not readable**: BMN could not read the page (it needs a sign-in, it is gone, it is not
  public). Unchecked: treat it as a lead to verify, never as a finding.

`not_found` lists what the researcher looked for and did not find. "No usable answer" means the
researcher did not answer in the asked shape: nothing was repaired or guessed, ask again or stop.

Report only what a found passage backs, name its page, and say which claims were not checked.

## When it is refused

- "Agents may ask the web" is off: the owner switched agents' questions off. Ask the owner.
- The day's limit is reached, or no researcher can research now: say so and go on without it.
- The question was refused for what it holds: remove that part. Never rephrase to get around it.
