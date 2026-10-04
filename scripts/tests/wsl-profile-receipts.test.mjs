// Shared receipt logic under simulated platform guards; no WSL/root process runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureRestrictedGuestProfile, measureRootRestrictedGuestProfile } from '../test/wsl-restricted-profile-spike.mjs'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const distribution = 'BMN-Epic53-Systemd-00000000-0000-0000-0000-000000000000'
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.stubEnv('GITHUB_ACTIONS', 'true')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})
const rows = count => Array.from({ length: count }, () => ({ retainedPidfds: 3, allExited: true,
  peer: { procAliasDenied: true }, outsideActorsCreated: 0, unrelatedSentinelsAlive: true,
  outsideBrokersDenied: [{}, {}, {}] }))
const routes = [
  ['ordinary profile', measureRestrictedGuestProfile, () => ({ socketBroker: [{ survivedCallerExit: true }, { deniedErrno: 1 }],
    lifecycle: rows(3), profileComplete: false })],
  ['root profile', measureRootRestrictedGuestProfile, () => ({ outsideBrokerPositiveControls: 4,
    i386PositiveControl: true, i386AndX32Denied: true, lifecycle: rows(4), syntheticFilesRemoved: true,
    callbackFailure: { exit: 70, callerCleanupUnwound: false }, uidLeases: { workerThreadFsUidNotReused: true }, syslogSizeProbe: { contentsRead: false, filteredPolicyErrno: 13 }, profileComplete: false })]
]
describe.each(routes)('%s receipt gate', (_name, measure, valid) => {
  it('returns FAIL for malformed zero-exit output so the outer native gate cannot lose the failure', () => {
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: 'not-json' }) }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it.each(['throw', 'undefined'])('normalizes a guest %s into a durable FAIL receipt', mode => {
    const guest = mode === 'throw' ? () => { throw new Error('synthetic guest failure') } : () => undefined
    expect(measure({ distribution, uid: 1000, guest }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it('returns FAIL when a zero-exit receipt reports a surviving owned process', () => {
    const receipt = valid(); receipt.lifecycle[0].allExited = false
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it('retains a valid scoped measurement with profileComplete false', () => {
    const receipt = valid()
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject(receipt)
  })
})
