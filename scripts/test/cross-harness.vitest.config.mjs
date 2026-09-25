// Explicit only: ordinary unit discovery must never launch paid real-provider trials.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['scripts/test/cross-harness-trial.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000
  }
})
