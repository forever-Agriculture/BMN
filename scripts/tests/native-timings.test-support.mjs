// Bounded synthetic test-stage metadata; no paths, SQL, file bytes or errors.
export function nativeTimings(name) {
  const started = performance.now(), stages = []
  const mark = stage => { if (stages.length < 100) stages.push({ stage, elapsedMs: Math.round(performance.now() - started) }) }
  const measure = (stage, operation) => {
    mark(`${stage}:begin`)
    try { return operation() } finally { mark(`${stage}:end`) }
  }
  const report = () => {
    if (process.platform === 'win32') console.log(JSON.stringify({ nativeDiagnostic: name, observationOnly: true,
      originalBudgetMs: 5000, exceededOriginalBudget: performance.now() - started > 5000, stages }))
  }
  return { mark, measure, report }
}
