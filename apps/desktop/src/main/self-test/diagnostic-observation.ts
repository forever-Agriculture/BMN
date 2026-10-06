// Self-test observations keep the failure that triggered them; they never decide ordinary acceptance.
export interface DiagnosticObservation {
  failure: string
  observation: Record<string, unknown>
  observationError?: { label: string; kind: 'rejected' | 'unavailable' | 'timeout' }
}

export async function observeDiagnosticFailure(
  failure: string, label: string, operation: () => unknown | Promise<unknown>, timeoutMs = 2_000,
  valid: (value: Record<string, unknown>) => boolean = () => true
): Promise<DiagnosticObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('diagnostic timeout')
  const unavailable = (kind: 'rejected' | 'unavailable' | 'timeout'): DiagnosticObservation => ({
    failure, observation: { unavailable: `${label}: ${kind}` }, observationError: { label, kind }
  })
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), timeoutMs) })
    ])
    if (value === timedOut) return unavailable('timeout')
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !valid(value as Record<string, unknown>)) return unavailable('unavailable')
    return { failure, observation: value as Record<string, unknown> }
  } catch { return unavailable('rejected') }
  finally { clearTimeout(timer) }
}
