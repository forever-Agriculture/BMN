---
name: report-artifact
description: Write the one-page HTML report for finished work (an epic, a project, an investigation) for a reader who knows nothing about it: a Problem | Fix | What happens now table, what is still open, next steps and two opinions; check it with the bundled script, publish it privately and open it in the owner's browser. Use when a piece of work is complete and its readers should learn what changed, what to trust and what to do next.
---
# MODULE: SKILL.md - the report-artifact skill: one short HTML report page per finished piece of work, its parts, writing rules, two opinions, screenshots, look, check, publishing and opening

# Report artifact

One short, calm page carries finished work to people who were not there: the owner, who runs
several projects and does not remember each one, and teammates who know nothing about the work.
A reader should know within a few minutes what the product is, what was wrong, what changed, what
is still open and who does what next. The parts and the look are fixed so every page reads the same
from every app; you fill them in.

## When

- Write a page when a piece of work is **complete**: an epic accepted, a project finished, an
  investigation answered. dev-auto writes one at the end of every completed epic.
- A parked, blocked or half-done run gets a short terminal summary, not a page.
- One page per piece of work. A second reader with their own steps (a developer who deploys) gets
  their own `<h3>` inside Next steps, not a second page.

## The parts

Copy `template.html` and keep its order. Each part is a `<section data-part="…">`; the check reads
those names. Word a heading for the reader if it helps. Every part stays visible: no folds.

| Part | Where | What goes in |
| --- | --- | --- |
| Header | `<header>` in the band | `<title>` of 2–4 words; eyebrow `Project · work · date` (`BMN · Epic 95 · 25 October 2026`); a title of 2–8 words that says what changed; **one** status line with status words (`✓ Done · checked on a local copy · ○ not yet in production · 2 steps wait on Artem`) |
| In short | `in-short` | 3–4 sentences for a stranger: what the product is, what was wrong (who found it, when), what this work changed and how it helps |
| What changed | `changes` | **one** table, Problem \| Fix \| What happens now, 1–6 rows, one issue per row, each complete on its own; the last line of each What happens now cell is its proof (`<p class="proof">`). Then the screenshots, each right after the table near the row it shows; then Also fixed, one line per smaller fix; then **one** checks line (`<p class="checks">`): the whole suite, reviews and CI |
| Still open | `still-open` | 1–3 plain lines: what was not checked, known risks. "None known." is valid |
| Next steps | `next` | an `<h3>` per person, their steps numbered when there are two or more; "Nothing." is valid. Choices you made under the owner's delegation go here as **Choices you can reverse**, one line each with what changes it |
| Two opinions | `opinions` | always last: the lead's and the independent reviewer's (below) |
| Footer | `<footer>` | who wrote it (app and model) and where the evidence is: a link to the PR or commit, or the records named in `<code>` |

## Writing it

- **For a stranger.** Write for someone who has never heard of the project. Explain each term
  where it first appears or drop it. No run ids, review rounds, handoff terms or tool narration in
  the body; the footer may link the records. Give a person's role where they first appear
  ("Artem, who deploys B2Buster").
- **One issue, one row.** A row says what hurt, the fix, and the behaviour now with its limit,
  figure or off switch. Everything a reader needs about that issue sits in its row, not spread
  over several parts.
- **Proof within its checks.** Each proof line names what checked it and its scope: "✓ backend
  tests, including a recovered report", "saved and synthetic reports only · ○ not yet on a new real
  report". Never a generic tick ("✓ two reviews"). A synthetic illustration is not runtime
  evidence. Behaviour, status words and opinions never claim more than the checks showed.
- **Honest status.** Status words carry a shape and a word: `<span class="ok">✓ done</span>`,
  `<span class="open">○ not yet …</span>`, `<span class="bad">✕ failed</span>`. An open state is
  never `.ok`; implemented and verified are different words.
- **Also fixed never holds a risk.** A fix with something left to watch gets a row, and the
  watching goes to Still open.
- **Short.** At most 900 words of report text; fewer is better. The check counts the text once:
  header, headings, cells, lists, captions, opinions and footer. It leaves out the title, alt
  text, image data and the full-size view's bar. A word is anything holding a letter or a digit,
  so `·`, `✓` and `○` are free.
- **The project's own people.** Next steps and the status line name only people the project's own
  records tie to it: its plan, its vault project note, the owner's words for that work. Artem and
  Anton belong to B2Buster, Denys to Piche, and BMN has the owner alone. Never carry a name over
  from another project's page.
- **Private data.** Synthetic examples only; no credentials, no customer or personal data, no
  paths in a home folder, no private transcripts. A screenshot from a test bed says so in its
  caption.

## Two opinions

The page ends with two opinion blocks side by side, so the reader sees where the lead and an
independent reader agree and where to look. Each block (`<div class="opinion">`) holds:

- a role line (`<p class="who">`): the real model and its role, `Opus 5.5 · led the work` or
  `Astra · independent review`;
- a bold verdict of 1–4 words (`<p class="verdict"><strong>Ship, then watch prices.</strong></p>`);
- 2–3 plain sentences: worth, risk and what to watch.

**The first block is yours**, the lead's: `<your model> · led the work`.

**The second block is the work's independent reviewer**, named by its real model (Astra, Sol,
Fable, Opus), never "Astra" by default. dev-auto's full review writes it and its final recheck
refreshes it against the accepted revision; copy it as written, shortened only to fit.

**Where no independent review ran**, or the review's output has no opinion (an older run), ask
for one read-only opinion before publishing:

```sh
bmn team ask --role consultant --agent astra --project "$PROJECT" \
  --question-file opinion-ask.md --key "$(date -u +%Y%m%d)-<work>-opinion" --json
```

Use `--agent opus-2` instead when Astra led the work. The question holds the drafted page
**without your opinion block**, the evidence paths, and the request: "Give an opinion for this
report: a 1–4-word verdict and 2–3 plain sentences on worth, risk and what to watch, from the page
and its evidence." Label its block `<model> · report and evidence review`. A refusal or failure is
reported, never worked around: the second block then reads `No independent opinion` as its verdict,
the role line `<asked model> · report and evidence review`, and one sentence with the refusal's
reason.

**Disagreement stays as written.** When the two differ, keep both words, and put the consequence
in Still open or Next steps. An unresolved material disagreement never sits beside a plain
"✓ Done" status line.

## Screenshots

Add a screenshot only when it shows the reader something the table cannot. Each one:

- is **embedded** in the page as data (`src="data:image/png;base64,…"`), so the page stays one file
  for every publisher; no other way (a link, a separate file, a hosted image) is used;
- shows at the full width of the column at its natural ratio: declare its real `width` and
  `height`, never crop it or put it in a fixed-height frame;
- has alt text and a caption that names its build or test bed;
- opens at full size: the image is wrapped in `<a href="#shot-N">`, and right after the figure a
  `<div class="shot" id="shot-N">` holds the same image at its natural width under a bar whose
  Close link points at the section's id (`#what-changed`). It needs no script and works the same
  in an Artifact, a file stored by `bmn publish` and a local file.

Keep a page with several screenshots well under the publishers' limits (an Artifact page 16 MB,
`bmn publish` 250 MiB): a screenshot embeds at about 4/3 of its file size, twice (inline and full
size), so prefer PNG or WebP of a few hundred KB.

## The look

The template holds the whole look; do not restyle it. A calm reading page: a solid header band,
then one centred 1040px column. Prose keeps a reading measure of about 66 characters on the
column's axis; the table, the screenshots and the two opinion plates take the full column. IBM
Plex Sans and Mono, a ruled table with a filled header row and a tinted Problem column, uppercase
section heads under a strong rule. It follows the system's light or dark setting (and
`data-theme`). On a phone each table row becomes a labelled block, the opinions stack, and the
page never scrolls sideways; every table cell keeps its `data-label` for this.

Colour carries meaning and nothing else: `.ok` (done), `.open` (still open), `.bad` (failed) on
status words, blue on setting names in `<code>` and on links. No inline styles, no other colours.

The page's only element kinds are paragraphs, one table, lists, the two opinion blocks and
screenshots. Nothing else: no boxes, badges, number panels, progress bars, arrows, folds, icons
or scripts; the check fails them.

## Check it

```sh
python3 <this skill>/check.py page.html    # PASS/FAIL per rule, exit 0 only when all pass
```

Fix every FAIL before publishing. The check proves the shape and hygiene, not that the page is
true or useful: reread it once as a stranger would.

## Publish it, then open it

- **Claude Code**: publish the page as a private Artifact (the Artifact tool; icon `report`). The
  Artifact wraps the page in its own doctype and charset, so publish a copy without the page's
  first three tags (`<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`):
  `sed '1,6{/^<!doctype html>$/d;/^<html lang="en">$/d;/^<meta charset="utf-8">$/d}' page.html > page.artifact.html`.
  An update republishes that copy's path to the same URL. Then open the Artifact link in the
  owner's default browser.
- **Codex, OpenCode or anything else in a BMN session**: `bmn publish page.html --key
  <work>-<first12 of the page's sha256>` and give the reader the id it prints; changed bytes need a
  new key, a retry of the same bytes keeps its key. Then open the **checked local page** in the
  owner's default browser: BMN's stored copy has no web link and its Open action refuses HTML.
- **Open without asking**: `xdg-open "<link or absolute path>"` on Linux, `open "<…>"` on macOS,
  right after publishing. Record its exit code. A failed or unavailable open never blocks: report
  it with the page's link or path and go on.
- Keep the source file next to the work's evidence (dev-auto: `.dev-auto/evidence/<epic>/report-artifact/`).
- A page goes to anyone beyond the owner only when he says so.
