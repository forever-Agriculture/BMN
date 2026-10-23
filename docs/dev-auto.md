# MODULE: dev-auto.md - run visibility, cleanup and owner-controlled worktree retirement
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

## What a run leaves running

dev-auto records each server, daemon and container it starts in its local handoff's
`## Started` list, using a PID and its `/proc` start ticks or a full container id and
name. Before a finished, blocked or paused report, `scripts/check.py leftovers CHECKOUT`
in dev-auto lists live resources whose recorded identities still match as **Owned**,
and processes or container mounts under that checkout as **Candidates**. It changes
nothing and excludes BMN, the checker and its ancestors. Candidates need separate
ownership confirmation; a path match alone never authorizes a stop. The lead rechecks
identity immediately before stopping its resources and signals a process through a
Linux pidfd, so PID reuse cannot redirect the signal. Containers use full ids. Commands
show executables and option names, with operand values hidden. Unrecorded process
discovery covers the current user; recorded identities are checked across user ids.
The lead records any deliberately kept
resource and its reason, then reruns the inventory. An incomplete scan is UNVERIFIED.

`scripts/check.py worktrees CHECKOUT` lists each worktree's branch, handoff status,
ancestry against the local default branch, uncommitted count and disk bytes. Ancestry
does not recognize squash merges. Active, dirty, unmerged or unknown runs are marked
**keep**. Finished, clean, merged runs can be offered on one card, and only the exact
worktrees the owner names are removed. Uncommitted files never get a forced removal
without his explicit approval for that worktree; needed evidence is preserved first.

## Runs on the plan's decisions

An epic planned from Epic 90 on lists its **Run needs** ([planning.md](planning.md)): extra repair rounds
per boundary, the criteria or stories that may be deferred and when, a money cap, and named actions for an
Away card. Your go on the epic approves them as your instruction for its runs, day or night. A run reads
them with the skill's `scripts/run_needs.py`, from the plan commit that recorded your go: an edit made after
the go does not count until you give a new go, and the run tells you about it. An epic without Run needs, or
without a recorded go, runs as before.

A run decides a technical point itself only when the evidence is complete; otherwise it asks the consultant
first. A point that is yours (spend beyond what you approved, a change to the work or its criteria, a
reserved action, credentials or private data, your own check, a model choice), or one still uncertain after
the consultant, goes at once under **Needs your decision** in its handoff, and the run carries on with every
story that point does not block. It asks you only when no remaining work can go on, and never while you are
Away; its final report lists every open entry. When a boundary's rounds are used up, a criterion your Run
needs list as deferrable is deferred (the story is marked done with the deferral noted and named under Known
limits, and a new story is proposed); anything else waits as Needs your decision.

Money: every paid job a run launches goes through the skill's `scripts/spend_ledger.py`, one ledger per plan
and epic under `~/.local/state/dev-auto/budgets/`. It reserves the job's maximum against your go's cap before
the job starts and refuses what does not fit; a cap of `none` refuses every paid launch, and a new go never
resets what was already spent or reserved. The ledger covers dev-auto's own paid launches only, not every
provider call an agent might make, so it is a guard on those launches, not a hard limit on all spending.

## The Away grant

When you say you are leaving, or press Away, BMN tells each running session once. A dev-auto run with
authorised work left for the night then sends one card with `bmn grant ask`. For an epic with a go, the
card is filled from its Run needs: only the named actions it lists (such as merging one of its PRs), never
repair rounds, which your go already gave; with no named actions, the run says it needs nothing. A run
without a go asks for only what its work needs: extra repair rounds per boundary (2, 3 or 4) and named
actions with their targets. You answer in the window or on Telegram; an unanswered card grants nothing, and
every grant ends when you are back.

The skill's `references/away-grant.md` says how a run uses it. Right before each step a grant would pay
for, it reads the grant fresh (`scripts/check.py grant`, which reads `bmn grant --run`), never from the
handoff. It records the use first with `bmn grant use`; a refused use means the step waits as it would
without a grant. A round at a parked boundary, from your go or from a grant, still needs new evidence and a
method the consultant agrees, recorded first; your go's rounds come first. Before the last round the run
puts the whole boundary to the consultant once (the step back), and when the rounds are used the boundary
defers what Run needs allow or waits as Needs your decision. Rounds count per boundary across resumes, new
leads, gos and Away periods. After each granted step the run reports what it did with `bmn grant report`,
and the morning summary shows those reports apart from BMN's own record. What code enforces (who answers,
expiry, the counts it records) and what is the run's rule are in [agent-control.md](agent-control.md), "The
Away grant".


## Morning digest

Enable Morning digest and choose a local time in Preferences → Notifications → Telegram. It is off by default,
and needs Telegram enabled and connected. It obeys quiet hours and skips days with no eligible send.

The message groups finished runs, new decisions still present in current handoffs, requests waiting
for you and paused runs, and blocked runs. Each line identifies its workspace, checkout and epics.
Copied handoffs are excluded. Missing or truncated sources are marked incomplete; the message
points to the laptop when more items fit there. The reader checks at most once every ten minutes
while the digest is eligible. Stored history contains only fingerprints and the claimed day.
