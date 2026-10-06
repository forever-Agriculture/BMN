import { describe, expect, it } from 'vitest'
import { diagnosticCustodyEntries, diagnosticJobSnapshotRecord, scrolledExperimentPartial } from '../lib/scrolled-diagnostic-result.mjs'
const arm = index => {
  const name = ['control', 'split', 'static'][index % 3]
  const passive = { failure: 'original SCROLLED failure', failureAtMs: 11000, scrollTypedAtMs: 0,
    controllerPokes: [], samples: [{ outputBytes: 42 }], observationErrors: [] }
  return { index, arm: name, receiptCount: 1, observationCount: 1,
    outcome: { code: 0, signal: null }, custody: 'confirmed', profileRemoved: true,
    observation: { selfTest: 'scrolled-diagnostic-observation', diagnosticOnly: true, arm: name,
      initialScrolledWithinBudget: false, lateMembers: 0, passiveObservation: { ...passive } },
    receipt: { selfTest: 'scrolled-diagnostic', diagnosticOnly: true, arm: name, graceful: true,
      initialScrolledWithinBudget: false, animationPassed: true, anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 },
      finalState: { outputBytes: 42 }, lateMembers: 0, passiveObservation: passive,
      sixelAnimation: { storageMB: 1, imageLinesAfterScroll: 4, noViewRebuild: true, quietPaneUnchanged: true, quietSelectionKept: true } } }
}
const complete = () => ({ partial: false, arms: Array.from({ length: 6 }, (_, index) => arm(index)) })
describe('SCROLLED experiment completeness', () => {
  it('allows six completed observations even though each original SCROLLED assertion failed', () => {
    expect(scrolledExperimentPartial(complete())).toBe(false)
  })
  it.each(['launch-failure', 'missing-receipt', 'timeout', 'cleanup-error', 'duplicate-receipt', 'wrong-arm', 'unconfirmed-custody', 'profile-retained', 'guard-error'])('marks six attempted arms partial when %s prevents a complete observation', defect => {
      const record = complete()
      for (const row of record.arms) {
        if (defect === 'launch-failure') row.outcome = { launchError: 'ENOENT' }
        if (defect === 'missing-receipt') delete row.receipt
        if (defect === 'timeout') row.timedOut = true
        if (defect === 'cleanup-error') row.cleanupError = 'EPERM'
        if (defect === 'duplicate-receipt') row.receiptCount = 2
        if (defect === 'wrong-arm') row.receipt.arm = 'another-arm'
        if (defect === 'unconfirmed-custody') row.custody = 'unconfirmed'
        if (defect === 'profile-retained') row.profileRemoved = false
        if (defect === 'guard-error') row.guardError = 'unconfirmed'
      }
      expect(scrolledExperimentPartial(record)).toBe(true)
    })
  it('marks a budget-truncated experiment partial', () => {
    const record = complete(); record.arms.pop()
    expect(scrolledExperimentPartial(record)).toBe(true)
  })
})

const custody = () => ({ selfTest: 'scrolled-diagnostic-custody', diagnosticOnly: true, arm: 'control', mainPid: 10,
  snapshot: { listed: 1, identified: 1, entries: [{ pid: 10, creationTimeMs: 100, creationFileTime: '116444736001000000' }] } })
const jobRecord = () => ({ ...custody(), selfTest: 'scrolled-diagnostic-job-snapshot', index: 0, startedAtMs: 1, returnedAtMs: 2 })
describe('bounded diagnostic job-query evidence', () => {
  it('retains incomplete zero-identity evidence and strips unapproved fields', () => {
    const record = { ...jobRecord(), command: 'must not persist', snapshot: { listed: 2, identified: 0, entries: [] } }
    const parsed = diagnosticJobSnapshotRecord(record, 10, 'control')
    expect(parsed).toEqual({ arm: 'control', mainPid: 10, index: 0, startedAtMs: 1, returnedAtMs: 2,
      snapshot: { listed: 2, identified: 0, entries: [] } })
    expect(diagnosticCustodyEntries(record, 10, 'control')).toBeNull()
  })
  it('retains exact FILETIME strings and only the three identity fields', () => {
    const record = jobRecord(); record.snapshot.entries[0].path = 'must not persist'
    expect(diagnosticJobSnapshotRecord(record, 10, 'control').snapshot.entries).toEqual(custody().snapshot.entries)
  })
  it.each(['wrong-main', 'wrong-arm', 'wrong-index', 'over-bound', 'negative-count', 'count-mismatch', 'duplicate',
    'time-mismatch', 'unsafe-timestamp', 'overflow-ticks'])('discards %s without producing custody entries', defect => {
    const record = jobRecord()
    if (defect === 'wrong-main') record.mainPid++
    if (defect === 'wrong-arm') record.arm = 'split'
    if (defect === 'wrong-index') record.index = 2
    if (defect === 'over-bound') record.snapshot.listed = 1025
    if (defect === 'negative-count') record.snapshot.identified = -1
    if (defect === 'count-mismatch') record.snapshot.identified = 0
    if (defect === 'duplicate') { record.snapshot.entries.push(record.snapshot.entries[0]); record.snapshot.listed = record.snapshot.identified = 2 }
    if (defect === 'time-mismatch') record.snapshot.entries[0].creationTimeMs++
    if (defect === 'unsafe-timestamp') record.startedAtMs = Number.MAX_SAFE_INTEGER + 1
    if (defect === 'overflow-ticks') record.snapshot.entries[0].creationFileTime = '18446744073709551616'
    expect(diagnosticJobSnapshotRecord(record, 10, 'control')).toBeNull()
    expect(diagnosticCustodyEntries(record, 10, 'control')).toBeNull()
  })
})
describe('diagnostic retained identities', () => {
  it('accepts a complete matching job snapshot with exact FILETIME conversion', () => {
    expect(diagnosticCustodyEntries(custody(), 10, 'control')).toEqual([{ pid: 10, creationTime: 100 }])
  })
  it.each(['wrong-main', 'wrong-arm', 'missing-self', 'duplicate', 'incomplete', 'over-bound', 'time-mismatch', 'malformed-time'])('refuses %s before the retained observer is armed', defect => {
      const ready = custody()
      if (defect === 'wrong-main') ready.mainPid = 11
      if (defect === 'wrong-arm') ready.arm = 'split'
      if (defect === 'missing-self') ready.snapshot.entries[0].pid = 11
      if (defect === 'duplicate') { ready.snapshot.entries.push(ready.snapshot.entries[0]); ready.snapshot.listed = ready.snapshot.identified = 2 }
      if (defect === 'incomplete') ready.snapshot.identified = 0
      if (defect === 'over-bound') ready.snapshot.listed = 1025
      if (defect === 'time-mismatch') ready.snapshot.entries[0].creationTimeMs = 101
      if (defect === 'malformed-time') ready.snapshot.entries[0].creationFileTime = '-1'
      expect(diagnosticCustodyEntries(ready, 10, 'control')).toBeNull()
    })
})

it('accepts a complete true verdict and its matching provisional observation', () => {
  const record = complete()
  for (const row of record.arms) {
    row.receipt.initialScrolledWithinBudget = row.observation.initialScrolledWithinBudget = true
    delete row.receipt.passiveObservation; delete row.observation.passiveObservation
  }
  expect(scrolledExperimentPartial(record)).toBe(false)
})
it.each(['verdict', 'animation', 'anchors', 'finalState', 'finalObservationError', 'lateBefore', 'lateAfter', 'provisionalCount',
  'provisionalArm', 'provisionalVerdict', 'failure', 'failureAt', 'shortBudget', 'samples', 'sampleBytes', 'pokes', 'errors'])('requires the complete observation contract when %s is missing or malformed', defect => {
    const result = complete(), row = result.arms[0], receipt = row.receipt, passive = receipt.passiveObservation
    if (defect === 'verdict') delete receipt.initialScrolledWithinBudget
    if (defect === 'animation') receipt.animationPassed = 'yes'
    if (defect === 'anchors') receipt.anchors = {}
    if (defect === 'finalState') receipt.finalState = { unavailable: true }
    if (defect === 'finalObservationError') receipt.finalObservationError = { kind: 'timeout' }
    if (defect === 'lateBefore') row.observation.lateMembers = 1
    if (defect === 'lateAfter') receipt.lateMembers = null
    if (defect === 'provisionalCount') row.observationCount = 2
    if (defect === 'provisionalArm') row.observation.arm = 'wrong'
    if (defect === 'provisionalVerdict') row.observation.initialScrolledWithinBudget = true
    if (defect === 'failure') passive.failure = ''
    if (defect === 'failureAt') passive.failureAtMs = Infinity
    if (defect === 'shortBudget') passive.failureAtMs = 9999
    if (defect === 'samples') passive.samples = []
    if (defect === 'sampleBytes') passive.samples = [{}]
    if (defect === 'pokes') passive.controllerPokes = ['typed']
    if (defect === 'errors') passive.observationErrors = [{ kind: 'rejected' }]
    expect(scrolledExperimentPartial(result)).toBe(true)
  })
