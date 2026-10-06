// Bounded synthetic test-stage metadata; no paths, SQL, file bytes or errors.
export function nativeTimings(name, originalBudgetMs = 5000) {
  const started = performance.now(), stages = []
  const mark = stage => { if (stages.length < 100) stages.push({ stage, elapsedMs: Math.round(performance.now() - started) }) }
  const measure = (stage, operation) => {
    mark(`${stage}:begin`)
    try { return operation() } finally { mark(`${stage}:end`) }
  }
  const report = () => {
    if (process.platform === 'win32') console.log(JSON.stringify({ nativeDiagnostic: name, observationOnly: true,
      originalBudgetMs, exceededOriginalBudget: performance.now() - started > originalBudgetMs, stages }))
  }
  return { mark, measure, report }
}
