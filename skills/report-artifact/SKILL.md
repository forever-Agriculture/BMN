---
name: report-artifact
description: Write the one-page HTML report artifact for finished work (an epic, a project, an investigation) in the owner's fixed sections and look, check it with the bundled script and publish it privately. Use when a piece of work is complete and its readers should learn what changed, what to trust and what to do next.
---
# MODULE: SKILL.md - the report-artifact skill: one HTML report page per finished piece of work, its fixed sections, writing rules, look, check and publishing

# Report artifact

One page carries finished work to people who read results, not handoffs: the owner, and anyone
he names (a teammate, a customer contact). A reader should know within a few minutes what changed,
what to trust, what is still open and what to do. The sections and the look are fixed so every
page reads the same on every app; you fill them in.

## When

- Write a page when a piece of work is **complete**: an epic accepted, a project finished, an
  investigation answered. dev-auto writes one at the end of every completed epic.
- A parked, blocked or half-done run gets a short terminal summary, not a page.
- One page per piece of work and audience. A second audience (for example a developer who
  deploys) gets a labelled group (`<h3>For Dana</h3>` and its own steps) inside the `next` part
  of the same page, not a second page, unless what they need differs in most parts.

## The sections

The owner's order: **why we built it, what changes, any other important thing to mention, the
honest opinion at the end.** Copy `template.html` and keep its order. Each part is a
`<section data-part="…">`; the check reads those names, not the headings, so you may word a
heading for the reader ("What a customer sees now" instead of "What changes"). Every part stays
visible: no folds.

| Part | `data-part` | Required | What goes in |
| --- | --- | --- | --- |
| Header | `<header>` | yes | `<title>` of 2–4 words; eyebrow `Project · work identifier · date` (`BMN · Epic 76 · 17 October 2026`); a heading of 2–8 words; 2–5 status chips; the hero card: one big figure or status word on the left, the lede (2–3 sentences: what is different now, compared with before) on the right; then 2–4 number tiles (label, figure, note) when the work has figures worth showing |
| Why we built it | `why` | yes | the need in the reader's words: who asked, what hurt, with the source (a date, a feedback point) |
| What changes | `changes` | yes | 2–6 cards (a pill label, a bold title, one or two sentences, a muted note), then **one** example (`.exhibit`): a screen, a message, a command and its output |
| What keeps it safe | `safety` | if relevant | one "Rule n" card per guard: what it stops; then what it cannot stop |
| Money / usage | `money` | if it costs or limits | limits as tiles or a table, what was measured, the worst case, the switch that turns it off |
| How we checked it | `checks` | yes | counted checks as score bars in one card; the rest in a `Check \| Result` table: each check's scope and its observed outcome, nothing claimed without a run |
| Known limits | `limits` | yes | callouts: what was not checked or does not work, plainly, and who accepted it, or "acceptance pending" |
| Decided for you | `decided` | owner page only | one "Decision n" card per choice you made under his delegation, with its reason, so he can reverse it |
| Waits on you / For <who> | `next` | yes | numbered steps per reader, the first the most urgent; "Nothing" is a valid list of one; a sequence someone executes (a release) as `.flow` steps with arrows; a text to approve in a grey callout |
| My honest opinion | `opinion` | yes, always last | 2–4 short paragraphs in the first person in an `.opinion` callout, the first sentence bold: worth, risk and what to watch; how the work went if it changes what the reader trusts |
| Footer | `<footer>` | yes | who wrote it (app and model) and where the evidence is: a link to the PR or commit, or the records named in `<code>` |

Leave an optional part out entirely rather than writing "not applicable".

## Writing it

- **Results, not process.** No run ids, review rounds, handoff terms or tool narration in the body;
  the footer may link the records. Say "two independent reviews; every finding fixed", not which
  reviewer said what in which round, unless it changes what the reader trusts.
- **Show figures, don't tell them.** A count, a total or a pass rate goes in a tile or a bar, not a
  sentence. "0 of 10 questions triggered a search", "$0.62 of a $10 cap". Estimates as ranges with
  what they rest on.
- **Plain words.** Explain each term on first use or drop it. Name people the reader knows by name.
- **Honest status.** A chip, a tile or a check says UNVERIFIED or "not yet verified" where it is;
  never round a partial pass up, and never colour an open state green. Implemented and verified are
  different words.
- **Claims within their checks.** Scope every behaviour claim to the build and environment that
  was tested. A synthetic illustration is not runtime evidence. An opinion or next step must not
  imply broader verification than the checks establish.
- **Short.** Use only the words needed; 700–1,000 is guidance, not a minimum. Every part earns its
  place: if a sentence repeats another part, cut it. The check fails a page over 1,500 words.
- **Private data.** Synthetic examples only; no credentials, no customer or personal data, no
  paths in a home folder, no private transcripts. An example from a test bed says so in its
  caption.

## The look

The template holds the whole look; do not restyle it. It is the look of the review page Denys sent
the owner: one dark theme on a GitHub-like ground, a plain system sans, a 1120px column, bordered
rounded cards in two-up grids, a hero card, number tiles, score bars, callouts with a coloured left
edge, and flow steps with arrows. Colour carries meaning and nothing else:

| Colour | Classes | Means |
| --- | --- | --- |
| green | `.g`, `.t-grn`, `.callout.grn`, a bar's default | done, good, passed |
| orange | `.o`, `.t-ora`, `.callout` | needs attention, still open |
| red | `.r`, `.t-red`, `.callout.red`, `i.red` | a problem, failed |
| yellow | `.y`, `.t-yel`, `i.yel` | partial |
| blue | `.b`, `.t-blu`, links | information |
| violet | `.v` | a plain label |
| grey | `.callout.grey`, plain figures | neutral |

Tables sit in `.table-wrap` so a phone scrolls them sideways and never the page; the Check | Result
table keeps `class="stack"`, which stacks each check over its result on a phone. Grids, the hero
and the flow fall to one column on a phone. No scripts, no images unless the example needs one, no
icons.

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
- Keep the source file next to the work's evidence (dev-auto: `.dev-auto/evidence/<epic>/report-artifact/`).
- A page goes to anyone beyond the owner only when he says so.
