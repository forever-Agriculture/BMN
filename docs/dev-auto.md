# dev-auto runs

Open **dev-auto runs…** in the command palette, or **Review results… → dev-auto runs…**
for one workspace. It reads current handoffs and their selected sprint-board rows by itself: on
opening, when the window gets the focus, when a request changes, and every 30 seconds while it is
shown in a visible window, so a handoff dev-auto rewrites outside BMN shows without a press.
BMN shows owning checkouts, copies, unknown ownership and unavailable sources separately.
It never changes handoffs, boards, decisions or agent requests. Open request titles navigate
to the corresponding live session.

The board rows come through the same resolver and streamed reader as `bmn plan` (Epic 77,
[planning.md](planning.md)): BMN's own `plan/status.yaml` or a BMAD `sprint-status.yaml`, of any
size, read in the checkout the plan's tracking names. Both plans present, an unknown schema or a
malformed own board shows as "Board unavailable" with the reason.

A handoff's `- Run id:` (written once when the run starts) and each Decided-for-you line's leading
entry id (`[d3]`, never renumbered) make a decision the same decision through text edits, compaction
and a new lead; a line ending in `(bmn: SESSION/KEY)` names the BMN decision record the lead made for
it while you were away, by the session and key `bmn decision record` returned, so the two join by that
identity, never by text, and only while the record is in the list. Lines without an id are legacy and
are known only by their text; a line that kept only `(bmn: KEY)` proves no record and shows apart. dev-auto reads the away state with `bmn away --status --json`, which
gives an agent the state, since and revision, never your note.


## Morning digest

Enable Morning digest and choose a local time in Preferences → Notifications → Telegram. It is off by default,
and needs Telegram enabled and connected. It obeys quiet hours and skips days with no eligible send.

The message groups finished runs, new decisions still present in current handoffs, requests waiting
for you and paused runs, and blocked runs. Each line identifies its workspace, checkout and epics.
Copied handoffs are excluded. Missing or truncated sources are marked incomplete; the message
points to the laptop when more items fit there. The reader checks at most once every ten minutes
while the digest is eligible. Stored history contains only fingerprints and the claimed day.
