// Diagnostic completeness is separate from the original SCROLLED verdict and ordinary acceptance.
export function scrolledObservationComplete(row) {
  const receipt = row.receipt, observation = row.observation
  if (row.observationCount !== 1 || observation?.selfTest !== 'scrolled-diagnostic-observation' ||
      observation.diagnosticOnly !== true || observation.arm !== row.arm || observation.lateMembers !== 0 ||
      receipt?.lateMembers !== 0 || typeof receipt.initialScrolledWithinBudget !== 'boolean' ||
      observation.initialScrolledWithinBudget !== receipt.initialScrolledWithinBudget ||
      typeof receipt.animationPassed !== 'boolean' || !Number.isFinite(receipt.finalState?.outputBytes) ||
      receipt.finalObservationError || !Number.isFinite(receipt.anchors?.appStartedAtMs) ||
      !Number.isFinite(receipt.anchors?.prefixStartedAtMs)) return false
  const animation = receipt.sixelAnimation
  if (!animation || typeof animation !== 'object' || Array.isArray(animation) ||
      'unavailable' in animation || 'observationError' in animation ||
      !Number.isFinite(animation.storageMB) || !Number.isFinite(animation.imageLinesAfterScroll) ||
      ['noViewRebuild', 'quietPaneUnchanged', 'quietSelectionKept'].some(key => typeof animation[key] !== 'boolean')) return false
  if (receipt.initialScrolledWithinBudget) return !receipt.passiveObservation && !observation.passiveObservation
  const passive = receipt.passiveObservation
  return typeof passive?.failure === 'string' && passive.failure.length > 0 &&
    Number.isFinite(passive.failureAtMs) && Number.isFinite(passive.scrollTypedAtMs) &&
    passive.failureAtMs - passive.scrollTypedAtMs >= 10000 &&
    observation.passiveObservation?.failureAtMs === passive.failureAtMs &&
    observation.passiveObservation?.scrollTypedAtMs === passive.scrollTypedAtMs &&
    observation.passiveObservation?.failure === passive.failure.slice(0, 500) &&
    Array.isArray(passive.controllerPokes) && passive.controllerPokes.length === 0 &&
    Array.isArray(passive.samples) && passive.samples.length > 0 &&
    passive.samples.every(sample => Number.isFinite(sample.outputBytes)) &&
    Array.isArray(passive.observationErrors) && passive.observationErrors.length === 0
}
export function scrolledExperimentPartial(record) {
  return record.partial || record.arms.length !== 6 || record.arms.some(row =>
    row.receiptCount !== 1 || row.outcome?.code !== 0 || row.outcome?.signal !== null ||
    row.timedOut || row.unavailable || row.cleanupError || row.guardError ||
    row.custody !== 'confirmed' || row.profileRemoved !== true ||
    row.receipt?.selfTest !== 'scrolled-diagnostic' || row.receipt?.diagnosticOnly !== true ||
    row.receipt?.arm !== row.arm || row.receipt?.graceful !== true || !scrolledObservationComplete(row))
}

/** Incomplete query results are evidence only; this projection never authorizes custody. */
export function diagnosticJobSnapshotRecord(record, childPid, arm) {
  if (record?.selfTest !== 'scrolled-diagnostic-job-snapshot' || record.diagnosticOnly !== true ||
      record.arm !== arm || record.mainPid !== childPid || ![0, 1].includes(record.index) ||
      ![record.startedAtMs, record.returnedAtMs].every(value => Number.isSafeInteger(value) && value >= 0)) return null
  const snapshot = record.snapshot
  if (!Number.isInteger(snapshot?.listed) || snapshot.listed < 1 || snapshot.listed > 1024 ||
      !Number.isInteger(snapshot.identified) || snapshot.identified < 0 || snapshot.identified > snapshot.listed ||
      !Array.isArray(snapshot.entries) || snapshot.entries.length !== snapshot.identified) return null
  const seen = new Set(), entries = []
  for (const entry of snapshot.entries) {
    if (!Number.isInteger(entry?.pid) || entry.pid < 1 || entry.pid > 0xffffffff || seen.has(entry.pid) ||
        !Number.isSafeInteger(entry.creationTimeMs) || typeof entry.creationFileTime !== 'string' ||
        !/^[1-9][0-9]{0,19}$/u.test(entry.creationFileTime)) return null
    const ticks = BigInt(entry.creationFileTime)
    if (ticks < 116444736000000000n || ticks > 0xffffffffffffffffn ||
        (ticks - 116444736000000000n) / 10000n !== BigInt(entry.creationTimeMs)) return null
    seen.add(entry.pid)
    entries.push({ pid: entry.pid, creationTimeMs: entry.creationTimeMs, creationFileTime: entry.creationFileTime })
  }
  return { arm, mainPid: childPid, index: record.index, startedAtMs: record.startedAtMs, returnedAtMs: record.returnedAtMs,
    snapshot: { listed: snapshot.listed, identified: snapshot.identified, entries } }
}

/** Only identities from this child's complete existing-job snapshot may arm its retained observer. */
export function diagnosticCustodyEntries(ready, childPid, arm) {
  if (ready?.selfTest !== 'scrolled-diagnostic-custody' || ready.diagnosticOnly !== true ||
      ready.arm !== arm || ready.mainPid !== childPid) return null
  const snapshot = ready.snapshot
  if (!Number.isInteger(snapshot?.listed) || snapshot.listed < 1 || snapshot.listed > 1024 ||
      snapshot.identified !== snapshot.listed || !Array.isArray(snapshot.entries) || snapshot.entries.length !== snapshot.listed) return null
  const seen = new Set(), entries = []
  for (const entry of snapshot.entries) {
    if (!Number.isInteger(entry?.pid) || entry.pid < 1 || entry.pid > 0xffffffff || seen.has(entry.pid) ||
        !Number.isSafeInteger(entry.creationTimeMs) || typeof entry.creationFileTime !== 'string' ||
        !/^[1-9][0-9]{0,19}$/u.test(entry.creationFileTime)) return null
    const ticks = BigInt(entry.creationFileTime)
    if (ticks < 116444736000000000n || ticks > 0xffffffffffffffffn ||
        (ticks - 116444736000000000n) / 10000n !== BigInt(entry.creationTimeMs)) return null
    seen.add(entry.pid); entries.push({ pid: entry.pid, creationTime: entry.creationTimeMs })
  }
  return seen.has(childPid) ? entries : null
}
