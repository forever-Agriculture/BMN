# BMN repository instructions

- After ready BMN implementation changes are committed and pushed to `main`, run `pnpm run update:desktop`.
- That command owns local packaging: it queues a persistent user service, waits for packaged BMN to exit, packages and smoke-tests the clean `origin/main` commit, refreshes the desktop launcher, and sends a completion notification.
- Never run `pnpm run package` while packaged BMN is open. Tell the owner to close BMN; opening it from the desktop launcher waits until the update finishes and then starts the new build.
- Planning artifacts may use BMAD. Do not use BMAD workflows for implementation.
- Platform policy: [Epic 53](docs/epic-53-windows-support.md) establishes full Windows support alongside Linux. During the port, add newly merged features to its parity checklist. After Epic 53 is accepted, every feature and fix must support both OSes: shared implementation where possible, OS-specific adapters where needed, and passing checks on both before completion or merge. Record unrun platform acceptance as UNVERIFIED, never done; WSL testing alone does not verify native Windows. Apply this rule equally to Claude Code and Codex.
