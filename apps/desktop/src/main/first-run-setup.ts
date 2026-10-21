// MODULE: first-run-setup.ts - Protect existing profiles from automatic setup
import { lstatSync } from 'node:fs'
import { masterPath } from '../../bin/agents-rules.mjs'
import { approvedIfAny } from '../../bin/agents-state.mjs'
import type { FirstRunSetupRecord } from '@bmn/protocol'

/** IPC registers before the host initializes its persisted profile. Startup writes must wait for that result. */
export function createSetupProfileReadiness(): {
  readonly ready: Promise<void>
  readonly fresh: boolean
  initialize(state: FirstRunSetupRecord['state']): void
} {
  let initialized = false, fresh = false
  let resolve!: () => void
  const ready = new Promise<void>(done => { resolve = done })
  return {
    ready,
    get fresh() { return initialized && fresh },
    initialize(state) {
      if (initialized) return
      fresh = state !== 'existing'
      initialized = true
      resolve()
    }
  }
}

interface ProfileEvidence {
  masterExists(): boolean
  teamApproved(): boolean
}

export function hasExistingSetupProfile(evidence: ProfileEvidence = {
  masterExists: () => { lstatSync(masterPath()); return true },
  teamApproved: () => approvedIfAny() !== null
}): boolean {
  try {
    if (evidence.masterExists()) return true
  } catch (error) {
    // Unreadable and dangling masters are still the user's; uncertainty is not a fresh profile.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
  }
  try { return evidence.teamApproved() } catch { return true }
}
