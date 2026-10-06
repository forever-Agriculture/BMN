// Secondary evidence cannot replace the first assertion's outcome.
export function diagnosticBeforeVerdict(observe, verdict, report = () => {}) {
  try { observe() }
  catch (error) {
    try { report({ secondary: true, code: error?.code ?? 'observation-error' }) }
    catch { /* Reporting is secondary too; the original verdict still runs. */ }
  }
  return verdict()
}
