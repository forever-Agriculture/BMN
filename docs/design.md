# MODULE: design.md - Shared screen rules, the approved Health doctor design and the Now sheet
# Screen design rules

These are the rules every BMN screen follows. Fable wrote them in Story 80.2 from a review of every screen, and
the owner approved them on 2026-10-19. A screen that breaks one is fixed, or the exception is named here. Each
rule has an ID that reviews and commits cite. "Text 8%" means `color-mix(in srgb, var(--text) 8%, transparent)`.

## Buttons

- **B1 Plate.** A button is a filled plate: transparent border, fill text 8%, radius 6 in panes and 10 in
  dialogs, weight 500. No `button` rule sets a border colour other than transparent, except on a selected
  sidebar row (`.session-row.selected`): its F2 bar is its left border, and its F1 ring a border on `::after`.
- **B2 Primary.** A screen's one primary button is filled `--text` with `--ground` text; its focus ring is
  `--ground`. It is the only bright plate on the screen.
- **B3 States.** Hover text 13%, active text 16% with no inset ring, disabled text 4% at 0.55 opacity. No state
  draws a line.
- **B4 Toggles.** A toggle (`aria-pressed`) shows state, not action (7ead0fc): a muted word when off; when on,
  the word in `--text` with a 2px bar under it, no fill and no border. The project plate is the one filled thing
  in a pane header; pressed (Quick Look open) it deepens to `--selected`, still borderless. Recording on Speak
  is a toggle that is on: the bar, not a red edge.
- **B5 Quiet word.** In an action row every acting button is a plate. One declining word per row (Cancel,
  Discard, Grant none, Not leaving, Close) may be a ghost: no fill, no border, muted. Icon buttons (×, …,
  chevrons) are bare glyphs.
- **B6 Segmented choice.** A choice among a few named options is one trough (`--raised`); the chosen segment is
  a plate with the gold bar under its word (tabs, the agent app, Researcher, Keep history, the grant choices).
- **B7 Rows.** Items in a menu, list or palette are rows, not plates: no border, a hover tint, selection by the
  bar (F2).
- **B8 Choice cards.** A card you pick (the agent picker) is a `--raised` plate with no border and a hover
  tint; chosen, it takes the `--selected` fill and the gold bar on its left edge.

## Lines, panels and boxes

- **L1 Section.** A section is an uppercase head (11px, 0.08em, muted) over or under one hairline
  (`.inspector-section`, `.group-head`). Never a frame.
- **L2 List and key/value.** Rows are parted by hairline bottoms. Facts sit in `.kv` rows: a fixed label column,
  paths cut at the tail with the whole path in `title`. Never a frame.
- **L3 Plate and well.** Content that must stand apart is a filled surface with a radius and no border. A plate
  is `--raised` on `--surface` or `--ground`; a well is `--ground` inside a plate or dialog (code, a command, a
  preview, a draft, saved output).
- **L4 Floating sheet.** A dialog, menu, search bar, brief notice or Quick Look is one lifted sheet: `--raised`
  (dialogs tinted identity 3%), a shadow, and a 1px rim of text 9% (`--rim`, one token). The rim is the only
  line allowed on all four sides; never `--border`, never `--hairline` as a frame. Exception: Quick Look while
  peeking (no fill, no shadow) keeps its 32% rim so it reads over terminals.
- **L5 Field.** An input, textarea or select opener is a well with a 1px edge of text 12% (hover 22%), radius 8
  in panes and 10 in dialogs. On focus the edge turns `--focus` with the 14% halo. Invalid: an inset 1px
  `--error` ring and a message.
- **L6 Control.** A checkbox or radio is 14px with a 1px `--border` edge, filled `--text` when checked.
  `--border` draws nothing else.
- **L7 Chip and key cap.** A badge ("Shell", "Read-only", "stale", "AWAY GRANT") and a key cap are small plates
  (text 8%, muted text), never outlined. Attention on a chip is the dot (F3), not a coloured edge.
- **L8 Nothing else.** No other rule draws a line on all four sides: `boxes.py` (in the planning references)
  lists no box outside L4 rims, L5 edges, L6 controls and the invalid ring.

## Selects

- **S1.** No native `<select>`. BMN's select is a plate opener (the value and a muted chevron) that opens a
  popup-menu list of `menuitemradio` rows. Five places use it: When windows close and Terminal images (the
  launcher), Send to session (the file reference dialog), Notify on (Notifications) and Language (Voice). Each
  keeps the value it saved before.
- **S2 States.** Closed: a plate (B1), the value in `--text`, the chevron muted, an empty value ("Choose a
  session…") muted. Hover: text 13%. Focused: the F1 ring. Open: the opener filled `--selected`; the list is an
  L4 sheet under the opener, flipped above when there is no room. The current value's row has the gold bar and
  the `--selected` fill; the highlighted row has the F1 ring; hover only tints. Disabled (a busy dialog, an
  archived workspace): text 4% at 0.55 opacity, not focusable, deaf to clicks and keys.
- **S3 Keys.** Closed and focused: Enter, Space, ArrowDown, ArrowUp or Alt+ArrowDown open it with focus on the
  current value. Open: ArrowDown and ArrowUp move and wrap, Home and End jump, Enter or Space choose, Escape
  closes with no change, Tab closes with no change and moves on, and typed letters jump to the next option
  starting with them (the buffer clears after 700 ms). A click toggles it, a click outside closes it, a click on
  a row chooses. Opening moves focus into the list; closing always returns it to the opener.
- **S4 Sizes.** The opener matches the fields beside it: 32px tall in the launcher, 36px in dialogs, radius 8
  and 10. Rows are 28px; the list shows at most 8 rows (232px), then scrolls. The list is at least the
  opener's width, aligned to its left edge, and never wider than its column; a long detail (a session's path)
  is cut at the tail on a muted second line.

## Focus, selection and attention

- **F1 Focus.** A 2px `--focus` ring, inset 2px, on buttons, rows and cards; on fields the edge turns `--focus`
  with the halo; on the primary plate the ring is `--ground`. Shown on `:focus-visible` only.
- **F2 Selection.** A gold bar: 2–3px on the left of a selected row (a sidebar session, a palette option, an
  open ask, a tree row, a chosen card) or under a chosen word (a segment, a tab, a toggle that is on), with the
  `--selected` fill. Inline, as for the current search match, the bar runs under the text with the
  `--selection` fill. Never a ring.
- **F3 Attention.** A filled gold dot before the words (`.status-dot.needs-you`, `<Dot label="Needs you">`).
  Never a coloured border, an outlined badge or a tinted surface.
- **F4 Outcome colours.** `--verified` and `--error` appear in words, dots and the invalid ring only; a danger
  action takes the error tone on hover only. Never a surface.

## Words

- **W1 Limit.** A text shown in a rendered screen state is at most 120 characters; a label, caption or button
  at most 40. A text built at run time counts its fixed words; fixed words over 110 count as over.
- **W2 Form.** Labels name things; a help line is one sentence that says what happens; buttons are verbs, with
  "…" when a sheet follows. One help line per control. A list of facts is `.kv` rows or lines, never a
  paragraph joined with semicolons or " · ".
- **W3 Second thoughts.** What the owner needs only sometimes (how a test works, what is checked, what cannot
  be seen) goes behind the page's Advanced or "?" disclosure: at most 4 lines, each at most 160 characters.
  Long test and privacy notes keep one line on their sheet with the rest behind its "?". Nothing is dropped
  without the owner's card.
- **W4 Exceptions.** Each may pass 120 characters for its reason:
  - (a) verbatim: a path, command, URL, hash or file content shown whole, because cutting it changes what runs
    or where;
  - (b) quoted: an agent's, program's or file's own words (messages, hook payloads, a skill's description,
    updater output), because BMN quotes and never edits them; shown on one line with an ellipsis and whole in
    `title`;
  - (c) an error or refusal with `role="alert"`, up to 200, because it must name the cause and the next step;
  - (d) a list built from data (event names, role names, session names): the fixed words count and the list
    does not, because BMN cannot shorten names; a long list shows its count, with the names in `title`;
  - (e) a line behind a disclosure, up to 160 (W3), because he opened it to read.
- **W5 Test.** `prose.cjs` (in the planning references) reports nothing over 120 outside its allowlist, which
  names each W4 text and its letter.

## Colour

- **C1 Tokens.** The existing tokens of each colour mode, plus `--rim`. No new hex values; a new tint is a
  `color-mix` of `--text` or `--identity` over transparent at 16% or less for a fill; an edge follows L4 and L5. On
  the primary, `--ground` stands in for `--text`.
- **C2 One accent.** Identity gold (`--identity` = `--attention`, #c9a45c) marks identity (the mark, the project
  name) and attention (dots, bars). No second hue.
- **C3 Quick Look** keeps its tint for literals (`--ql-plate-*`, the owner's one exception); its lines follow
  L4, L5 and F2 all the same.

## Health doctor

Approved by the owner on 2026-10-20, Story 81.2 AC3; Fable design ask
`20261020T084008-353e3b99`, corrected notes in the run's `design-81-2-notes.md`.

- Add Doctor after Hooks and before Local control. Keep existing Health controls and its row grid,
  hairlines, theme tokens and responsive layout at 1280×800 and 800×800.
- Checks run automatically. Show problems, unavailable or stale checks, and show-only leftovers.
  Only problems count as Needs-you; leftovers may be deliberately retained.
- Show All well only when every applicable check passed fresh. While checking, keep previous results
  and each result's own timestamp. Adopt refreshed rows through Health's existing calm-state rule.
- Rows name the app/check, path or command, state, safe reason/fix and checked/tried time. Withhold
  secret-bearing contents. Checks leave the owner's files unchanged.
- Put timing, version qualification and the checked scope behind one What is checked disclosure.
  Existing sheets keep their focus-return behavior. Story 96.6 (owner approval 2026-10-26, see below) adds the
  Leftovers disclosure and its groups' disclosures as the only other keyboard stops.
- Leftovers say Review it yourself; BMN leaves it. There is no cleanup control, Check now or switch.
  Since Story 96.6 they are grouped, not one row each: one Leftovers disclosure (“Leftovers · 335 in 9 groups ·
  show-only”) holds one group per app × kind × reason, largest first, as label | count, its numeric locations inside.
- Leftovers partial results use the owner-approved86.2 counts: “N folders too large to check”,
  “N databases too large to check”, “N sources changed during the check”, “N items could not be read”,
  or “N scan steps did not finish”. Details give the applicable limit or coverage gap without names or paths.
  App-doctor wording stays unchanged.
- Names are withheld even when ordinary-looking. Acquisition4 locations use structural root, parent/object,
  numeric route and entry coordinates, plus line/column or rowid where applicable, with full text in the title.
  They are current only after fresh item-and-reason verification; historical coordinates are marked stale.
  A fully checked item whose location is inherently ambiguous or unavailable says “location unavailable”;
  this alone is not incomplete reason coverage (owner card epics-85-87-completion-scope). Ambiguous coordinates
  stay refused and actual unread, changed or uncertain reason inputs stay partial.
  Manual resolution stays behind the existing What is checked disclosure. Health refreshes locations automatically
  when visible and calm; unrelated settings/action snapshots project saved status, followed by that automatic refresh.

## Health clarification (Story 96.6)

Approved by the owner on 2026-10-26 (card in run `dev-auto/epic-96-20261026`: “Approve as proposed”), design
`plan/references/096/health-design.md` with its planner corrections.

- **One issue, one count.** An issue is one app × one area × one cause with one fix. A Health row needing the owner
  counts each distinct cause it shows (at least one) and each of its tests that failed (the skills listing and
  loading tests apart), so one row can hold several issues. A Doctor hook, tool, skill or rules finding names its
  cause as the entry's state word from a closed list (`missing`, `unlisted-exposed`, `missing:Stop`), never a name or
  path; an unknown state word makes the check partial. One whose app, area and cause a Health row needing the owner
  shows now is that issue: shown faint in Doctor, counted on the row. Others count in Doctor, once per cause: another
  cause of the same app and area, a stale result Health no longer shows; an older result without a cause or a
  finding naming no app counts by itself. Matching words alone never merge two issues.
- **Head.** “Refreshing…” only while BMN re-reads the machine, otherwise “Read 13:39”, “· stale” past the Health
  rule's limit, then “· N need you: Hooks, Tools”. Tests and Doctor runs say their state on their own rows; Doctor's
  line says “Doctor ran 13:31” or “Doctor running · results below are from 13:31”. Only the head is a live status.
- **Exact scope.** Rules files say “Rules test …”; Agent apps say “routing-tested”; context says “Not yet proven on X”
  with the scheduler's actual state; tools say “N tool connections available · no approved destination recorded”;
  OpenCode's earlier plugin says “Older plugin · stopped turns cannot be distinguished…” and needs the owner. Older
  wording stays faint only where it does the same.
- **Coverage.** How fully leftovers were read is shown on the Leftovers line, never counted, and blocks All well;
  an item that could not be read counts. All well needs every check passed and current and no section needing him.
- **Calm refresh.** A background read keeps known failures and leaves unrelated buttons usable; disclosures keep
  their open state; a focused group a refresh removed hands the focus to the Leftovers summary.
- **Sizes.** 889×768 keeps the four-column grid; at ≤680 px rows take two columns (name | state, the path across,
  time and actions left on a third line). Locations wrap; nothing scrolls sideways.

## Now sheet (Story 110.9)

Approved by the owner on 2026-11-06 ("Approve as drawn", card `epic110-now-design-2`); the drawn design is
`.dev-auto/evidence/110/now-design/index.html` in the Epic 110 run. It replaced the dev-auto runs dialog.

- **Opening.** `Ctrl Shift N` or the list icon beside search (no dot on it), from anywhere; the same key closes
  it. The palette entry is **Now…**; Review results… and the Away summary link to it.
- **Sheet.** An L4 dialog, 960 wide at most and centred. Head line: `Read 09:40 · 12 sessions · ● 2 wait on you`
  with Copy standup, a plain plate (B1), at its right. Then column labels and one scrolling list; the head stays.
- **Rows.** One per session, parted by hairlines (L2): status dot (the sidebar's, F3), Session, Doing (with
  `D of T` faint and a `stale` chip, L7), Waits on, Left. Columns `7 · 96–196 · 1fr · 96–176 · 128`; under a
  780 px sheet `7 · 84–132 · 1fr · 72–124 · 112`. A long name is cut at its tail, whole in the tooltip and in
  the open row. A row's chevron or → opens its explanation as label and value rows (Status, Next step, Card,
  Time left, Stories, Decided, Folder); the card's title is a button that opens the session.
- **Sections.** Waits on you first, then each workspace in sidebar order, then **Not running**, folded with
  its count: stopped sessions without an unfinished run, finished runs and runs with no session. An unfinished
  run whose session stopped stays in its project, muted.
- **Words.** Doing is the run's current story, else the `bmn progress` label (`Working: …`), else the terminal
  title, else Working or Idle; `Idle at 110.3` for an idle run with nobody named; `Shell, no agent`, `Stopped`,
  `Finished 2 Nov`, `No session, stopped at 36.4`, `Handoff unreadable`. Waits on says `you: <card>` only for
  an open card, else the handoff's `Waiting on`, blank for nobody, `unknown` (faint) when unreadable. Left is
  `about X-Y h` or `about X-Y days` (+ wait when Waits on is not blank), `done`, or `no estimate` (faint).
- **Gold.** Only the dots of Waits on you and the current session's bar (F2). Nothing waits on you: no gold.
- **Shared activity (113.9).** The PTY host owns one observation per incarnation, including output with no
  attached view. Sidebar, Now and CLI use its timestamps: after 1,500 ms of silence, the 500 ms tick makes
  the resting mark visible within 1.5–2.0 seconds. Unread finished-turn notices keep their reminder without
  gold; only a current request card waits on the owner. A restarted process inherits no activity.
- **Keys and focus.** The list is one Tab stop (roving tabindex): ↑ ↓ Home End move, → ← open and close a row,
  Enter opens the session (its card in front, first enabled action focused) and closes the sheet. The
  Not running fold participates in the same roving sequence; its detail links add no Tab stops.
  Tab steps list, Copy standup, ×; Esc
  closes. It opens on the row he left, same scroll, same rows open, else the first row. F1 ring on focus.
- **Refresh.** Cards and hooks show at once; runs are read every 30 s while open (Story 75.7). Words change in
  place. While pointer or focus is in the list, the first placement shown with a read (a remembered one too)
  holds: no row changes section, and a new row comes after every shown one, under its section's title; all take
  their own places once he leaves the list. Focus is never lost: a row drawn anew keeps it, a row that went
  hands it to the next. Loading: rows at once from memory, run words fill in place, Copy disabled until the read returns.
  Stale: the head says `stale` with one alert line, rows keep their last words.
- **Sizes.** At a sheet of 600 px and under, down to BMN's 320: name and time, then doing, then the wait
  (`Waits on …`); the column labels and "+ wait" go. The sheet's padding narrows at a 680 px window.
- **Motion.** The dialog's own 180 ms settle only, off under reduced motion; dots never pulse, rows open in
  one frame.
- **Standup text.** Copy standup and `bmn now` give one generator's text (`@bmn/protocol` `standupText`):
  `Thu 5 Nov, 09:40. 12 sessions, 2 wait on me.` (or `No agent running.`), then per workspace one line per
  session and `Done since Wed: …` from the start of the previous working day. An agent's `bmn now` covers its
  own workspace and reads `Waits on the owner.` with no card title (D10), and only runs linked to a session of
  that workspace. A session with no run speaks only by its `bmn progress` label, never its terminal title, so
  the clipboard and `bmn now` say the same ([d9]). Both count a session as running an agent by one rule: this
  run's hooks reported one (he types agents inside shells; a launch program or foreground process decides nothing).
  Leaving the list on purpose ends the hold on focus: a later refresh never pulls focus back.
- **Scrollbar.** BMN's 8 px thumb (as the palette's), rimmed in the sheet's colour; the list and the column
  labels both keep a stable gutter, so labels stay over their values.

## Reviews

Every visual change is reviewed by Fable before it is delivered and again after it is built (R80-NFR2). A
board shows only the screens whose layout changes; behaviour details go into the text, not into more frames.
