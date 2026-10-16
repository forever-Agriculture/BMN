# dev-auto runs

Open **dev-auto runs…** in the command palette, or **Review results… → dev-auto runs…**
for one workspace. It reads current handoffs and their selected sprint-board rows by itself: on
opening, when the window gets the focus, when a request changes, and every 30 seconds while it is
shown in a visible window, so a handoff dev-auto rewrites outside BMN shows without a press.
BMN shows owning checkouts, copies, unknown ownership and unavailable sources separately.
It never changes handoffs, boards, decisions or agent requests. Open request titles navigate
to the corresponding live session.


## Morning digest

Enable Morning digest and choose a local time in Preferences → Telegram. It is off by default,
and needs Telegram enabled and connected. It obeys quiet hours and skips days with no eligible send.

The message groups finished runs, new decisions still present in current handoffs, requests waiting
for you and paused runs, and blocked runs. Each line identifies its workspace, checkout and epics.
Copied handoffs are excluded. Missing or truncated sources are marked incomplete; the message
points to the laptop when more items fit there. The reader checks at most once every ten minutes
while the digest is eligible. Stored history contains only fingerprints and the claimed day.
