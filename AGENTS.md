# MODULE: AGENTS.md - BMN repository instructions
# BMN repository instructions

- After ready BMN implementation changes are committed and pushed to `main`, queue `pnpm run update:desktop` without asking; closing, killing or restarting packaged BMN is the owner's.
- Pushes, merges and pull requests follow BMN's policy: read `bmn policy --repo OWNER/NAME` (OWNER/NAME: the repository you write to) before each push, merge or PR write and act only within what it authorizes; anything else needs the owner's separate authorization.
- That command owns local packaging: it queues a persistent user service that packages and smoke-tests the newest clean `origin/main` commit while BMN stays open, offers the owner the restart only once that build passed, swaps it in after BMN exits, refreshes the desktop launcher, and sends a notification.
- Never run `pnpm run package` while packaged BMN is open; the update's staged build is the only packaging allowed then. The owner restarts BMN himself; opening it from the desktop launcher waits only while the passed build is swapped in.
- BMN's planning lives in `plan/` (its own local Git repository, ignored here; `docs/planning.md`) and is done with the `plan` skill; `bmn plan status|check|set` reads and changes its board.
- For BMN desktop QA, the implementing lead runs the [disposable bench](docs/qa-checklist.md#lead-run-desktop-bench) directly. Use its brief, report and receipt gate. Keep any explicit requirement for independent QA as a separate acceptance check.
- Claude Code and Codex must behave the same; change rules in BMN's master, skills and hooks, for both.
- Commit subjects are at most 100 characters (Unicode code points, Conventional prefix included; `Merge ` and `Revert "` exempt): the tracked `.githooks/commit-msg` refuses longer ones, so put the detail in the body.
