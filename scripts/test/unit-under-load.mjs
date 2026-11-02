// MODULE: unit-under-load.mjs - runs test:unit beside busy loops at twice the core count and prints PASS or FAIL per run
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const runs = option('--runs', 3)
const loops = option('--loops', availableParallelism() * 2)
/** What follows `--` goes to vitest, for trying a few files under the same load; a gate run names none. */
const only = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []

const load = Array.from({ length: loops }, () =>
  spawn(process.execPath, ['-e', 'for (;;);'], { stdio: 'ignore' }))
const stopLoad = () => {
  for (const child of load) child.kill('SIGKILL')
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopLoad()
    process.exit(1)
  })
}
process.on('exit', stopLoad)

/** Each failed test's file and name from vitest's JSON report; a report that cannot be read counts as a failure. */
const failuresIn = (report) => {
  try {
    const { testResults } = JSON.parse(readFileSync(report, 'utf8'))
    return testResults.flatMap((file) => {
      const failed = file.assertionResults.filter((test) => test.status === 'failed')
      const name = file.name.replace(`${repo}/`, '')
      if (failed.length > 0) return failed.map((test) => `${name}: ${test.fullName} [${String(test.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 120)}]`)
      return file.status === 'failed' ? [`${name}: the file itself failed`] : []
    })
  } catch (error) {
    return [`vitest wrote no readable report (${error.code ?? error.message})`]
  }
}

const folder = mkdtempSync(join(tmpdir(), 'bmn-unit-under-load-'))
const results = []
try {
  for (let run = 1; run <= runs; run += 1) {
    const report = join(folder, `run-${run}.json`)
    const began = Date.now()
    const { status } = spawnSync('pnpm', ['run', 'test:unit', ...only, '--reporter=json', `--outputFile=${report}`], {
      cwd: repo,
      stdio: 'ignore',
    })
    const failures = failuresIn(report)
    if (status !== 0 && failures.length === 0) failures.push(`test:unit exited ${status} with no failed test`)
    const seconds = Math.round((Date.now() - began) / 1000)
    const load1 = loadavg()[0].toFixed(0)
    results.push(failures.length)
    console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}: run ${run} of ${runs}, ${failures.length} failed, ${loops} loops, load ${load1}, ${seconds} s`)
    for (const failure of failures) console.log(`  ${failure}`)
  }
} finally {
  stopLoad()
  rmSync(folder, { recursive: true, force: true })
}
process.exit(results.every((count) => count === 0) ? 0 : 1)
