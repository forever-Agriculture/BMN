---
name: team-page
description: Write the one-page HTML report for finished work (an epic, a project, an investigation) in the owner's fixed structure, check it with the bundled script and publish it privately. Use when a piece of work is complete and its readers should learn what changed, what to trust and what to do next.
---
# MODULE: SKILL.md - the team-page skill: one calm HTML page per finished piece of work, its fixed structure, writing rules, check and publishing

# Team page

One page carries finished work to people who read results, not handoffs: the owner, and anyone
he names (a teammate, a customer contact). A reader should know within a few minutes what changed,
what to trust, what is still open and what to do. The structure and the look are fixed so every
page reads the same on every app; you fill it in.

## When

- Write a page when a piece of work is **complete**: an epic accepted, a project finished, an
  investigation answered. dev-auto writes one at the end of every completed epic.
- A parked, blocked or half-done run gets a short terminal summary, not a page.
- One page per piece of work and audience. A second audience (for example a developer who
  deploys) gets a labelled group (`<h3>For Dana</h3>` and its own numbered list) inside the
  `next` part of the same page, not a second page, unless what they need differs in most parts.

## The structure

Copy `template.html` and keep its order. Each part is a `<section data-part="…">`; the check reads
those names, not the headings, so you may word a heading for the reader ("What a customer sees
now" instead of "What changes").

| Part | `data-part` | Required | What goes in |
| --- | --- | --- | --- |
| Header | `<header>` | yes | `<title>` of 2–4 words, eyebrow `Project · work identifier · date` (`BMN · Epic 76 · 17 October 2026`), a heading of 2–8 words, a lede of 2–3 sentences (what is different now, compared with before), 2–5 status chips |
| Why we built it | `why` | yes | the need in the reader's words: who asked, what hurt, with the source (a date, a feedback point) |
| What changes | `changes` | yes | bullets with a bold opening phrase each, then **one** example (`.exhibit`): a screen, a message, a command and its output |
| What keeps it safe | `safety` | if relevant | the guard, what it stops, and what it cannot stop |
| Money / usage | `money` | if it costs or limits | limits in a table, what was measured, the worst case, the switch that turns it off |
| How we checked it | `checks` | yes | a `Check \| Result` table: each check's scope and its observed outcome, quantified where meaningful, nothing claimed without a run |
| Known limits | `limits` | yes | what was not checked or does not work, plainly, and who accepted it, or "acceptance pending" |
| Decided for you | `decided` | owner page only | choices you made under his delegation, each with its reason, so he can reverse one |
| Waits on you / For <who> | `next` | yes | numbered steps for the reader, the first one the most urgent; "Nothing" is a valid step list of one |
| My honest opinion | `opinion` | yes | 2–4 short paragraphs in the first person: worth, risk and what to watch; how the work went if it changes what the reader trusts |
| Footer | `<footer>` | yes | who wrote it (app and model) and where the evidence is: a link to the PR or commit, or the records named in `<code>` |

Leave an optional part out entirely rather than writing "not applicable".

## Writing it

- **Results, not process.** No run ids, review rounds, handoff terms or tool narration in the body;
  the footer may link the records. Say "two independent reviews; every finding fixed", not which
  reviewer said what in which round, unless it changes what the reader trusts.
- **Plain words.** Explain each term on first use or drop it. Name people the reader knows by name.
- **Numbers with their basis.** "0 of 10 questions triggered a search", "$0.62 of a $10 cap".
  Estimates as ranges with what they rest on.
- **Honest status.** A chip or a check says UNVERIFIED or "not yet verified" where it is; never
  round a partial pass up. Implemented and verified are different words.
- **Claims within their checks.** Scope every behaviour claim to the build and environment that
  was tested. A synthetic illustration is not runtime evidence. An opinion or next step must not
  imply broader verification than the checks establish.
- **Short.** Use only the words needed; 600–1,200 is guidance, not a minimum. Every part earns its
  place: if a sentence repeats another part, cut it. The check fails a page over 1,500 words.
- **Private data.** Synthetic examples only; no credentials, no customer or personal data, no
  paths in a home folder, no private transcripts. An example from a test bed says so in its
  caption.

## The look

The template holds the whole look; do not restyle it. One ~720px reading column on a calm paper
background, Source Serif 4 for headings, Public Sans for text, JetBrains Mono for code, one accent
colour and one warning colour, light and dark themes from the same tokens. Tables sit in
`.table-wrap` so a phone scrolls them sideways and never the page. No scripts, no images unless
the example needs one, no icons, no extra boxes: shape and spacing carry the structure.

## Check it

```sh
python3 <this skill>/check.py page.html            # PASS/FAIL per rule, exit 0 only when all pass
python3 <this skill>/check.py page.html --owner    # also requires the Decided for you part
```

Fix every FAIL before publishing. The check proves structure and hygiene, not that the page is
true or useful: reread it once as its reader.

## Publish it

- **Claude Code**: publish the file as a private Artifact (the Artifact tool; icon `report`). An
  update republishes the same file to the same URL. Give the reader the link.
- **Codex, OpenCode or anything else in a BMN session**: `bmn publish page.html --key
  <work-audience-revision>` and give the reader the id it prints. Reuse a key only to retry that
  same publication; changed content needs a new revision key and gives a new id.
- Keep the source file next to the work's evidence (dev-auto: `.dev-auto/evidence/<epic>/team-page/`).
- A page goes to anyone beyond the owner only when he says so.
