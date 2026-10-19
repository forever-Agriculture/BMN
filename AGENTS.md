# BMN repository instructions

- After ready BMN implementation changes are committed and pushed to `main`, queue `pnpm run update:desktop` without asking; closing, killing or restarting packaged BMN is the owner's.
- Pushes, merges and pull requests follow BMN's policy: read `bmn policy --repo` before each push, merge or PR write and act only within what it authorizes; anything else needs the owner's separate authorization.
- That command owns local packaging: it queues a persistent user service, waits for packaged BMN to exit, packages and smoke-tests the clean `origin/main` commit, refreshes the desktop launcher, and sends a completion notification.
- Never run `pnpm run package` while packaged BMN is open. Tell the owner to close BMN; opening it from the desktop launcher waits until the update finishes and then starts the new build.
- BMN's planning lives in `plan/` (its own local Git repository, ignored here; `docs/planning.md`) and is done with the `plan` skill; `bmn plan status|check|set` reads and changes its board.
- Commit subjects are at most 100 characters (Unicode code points, Conventional prefix included; `Merge ` and `Revert "` exempt): the tracked `.githooks/commit-msg` refuses longer ones, so put the detail in the body.
