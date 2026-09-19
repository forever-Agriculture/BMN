# BMN repository instructions

- After ready BMN implementation changes are committed and pushed to `main`, run `pnpm run update:desktop`.
- That command owns local packaging: it queues a persistent user service, waits for packaged BMN to exit, packages and smoke-tests the clean `origin/main` commit, refreshes the desktop launcher, and sends a completion notification.
- Never run `pnpm run package` while packaged BMN is open. Tell the owner to close BMN and wait for the “BMN updated” notification before reopening.
- Planning artifacts may use BMAD. Do not use BMAD workflows for implementation.
