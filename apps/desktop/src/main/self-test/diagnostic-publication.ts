// A bounded provisional record precedes cleanup; only the later final receipt can complete an arm.
export interface DiagnosticPublicationState {
  arm: string
  anchors: { appStartedAtMs: number; prefixStartedAtMs: number }
  initialScrolledWithinBudget?: boolean | undefined
  lateMembers: number | null
  passiveObservation?: Record<string, unknown> | undefined
}
const MAX_BYTES = 64 * 1024
export function diagnosticObservationRecord(state: DiagnosticPublicationState): Record<string, unknown> {
  const passive = state.passiveObservation
  const samples = Array.isArray(passive?.samples) ? passive.samples as Record<string, unknown>[] : []
  const kept = samples.length > 16 ? [...samples.slice(0, 8), ...samples.slice(-8)] : samples
  const lines = (passive?.viewAtEnd as { lines?: unknown } | undefined)?.lines
  const errors = Array.isArray(passive?.observationErrors) ? passive.observationErrors as Record<string, unknown>[] : []
  return { selfTest: 'scrolled-diagnostic-observation', diagnosticOnly: true, arm: state.arm,
    anchors: state.anchors, initialScrolledWithinBudget: state.initialScrolledWithinBudget, lateMembers: state.lateMembers,
    ...(passive ? { passiveObservation: {
      failure: String(passive.failure ?? '').slice(0, 500), failureAtMs: passive.failureAtMs, scrollTypedAtMs: passive.scrollTypedAtMs,
      controllerPokes: Array.isArray(passive.controllerPokes) ? passive.controllerPokes.length : null,
      samples: kept.map(sample => ({ atMs: sample.atMs, outputBytes: sample.outputBytes })), samplesDropped: samples.length - kept.length,
      observationErrors: errors.slice(0, 16).map(error => ({ label: String(error.label).slice(0, 100), kind: String(error.kind).slice(0, 32) })),
      viewAtEnd: { lineCount: Array.isArray(lines) ? lines.length : null,
        scrolledVisible: Array.isArray(lines) ? lines.some(line => typeof line === 'string' && line.includes('SCROLLED')) : null }
    } } : {}) }
}

export function diagnosticObservationPublisher(
  read: () => DiagnosticPublicationState,
  write: (line: string, callback: (error?: Error | null) => void) => void = (line, callback) => { process.stdout.write(line, callback) },
  timeoutMs = 2_000
): () => Promise<boolean> {
  let published: Promise<boolean> | undefined
  return () => {
    published ??= new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false
      const finish = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok) } }
      try {
        const line = JSON.stringify(diagnosticObservationRecord(read())) + '\n'
        if (Buffer.byteLength(line) > MAX_BYTES) { finish(false); return }
        timer = setTimeout(() => finish(false), timeoutMs)
        write(line, error => finish(!error))
      } catch { finish(false) }
    })
    return published
  }
}
