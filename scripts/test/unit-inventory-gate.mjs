#!/usr/bin/env node
// Epic 53 unit/integration regression gate.
//
// The full suite always runs on both operating systems. Failures that a port story
// still owns are listed per platform in docs/epic-53-known-failures.json; this gate
// fails on any other failing test, a failed suite, a vitest error without a failing
// test, or a suspiciously small run. Listed failures stay open, are reported by
// owning story and never count as passing. A listed test that now passes is reported
// so the list only shrinks.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const testKey = (root, file, fullName) =>
  `${relative(root, file).split('\\').join('/')} > ${fullName}`

export const evaluateInventory = ({ report, known, platform, root, vitestExit }) => {
  const listed = known.platforms?.[platform] ?? {}
  const failing = new Map()
  for (const file of report.testResults ?? []) {
    const failed = (file.assertionResults ?? []).filter(test => test.status === 'failed')
    for (const test of failed) failing.set(testKey(root, file.name, test.fullName), test)
    if (file.status === 'failed' && failed.length === 0) failing.set(testKey(root, file.name, '(suite)'), file)
  }
  const unexpected = [...failing.keys()].filter(key => !(key in listed)).sort()
  const nowPassing = Object.keys(listed).filter(key => !failing.has(key)).sort()
  const openByStory = {}
  for (const key of failing.keys()) {
    const story = listed[key]
    if (story) openByStory[story] = (openByStory[story] ?? 0) + 1
  }
  const problems = []
  if ((report.numTotalTests ?? 0) < (known.minimumTests ?? 1)) {
    problems.push(`ran ${report.numTotalTests ?? 0} tests, expected at least ${known.minimumTests}`)
  }
  if (unexpected.length > 0) problems.push(`${unexpected.length} failing tests are not owned by a port story`)
  if (vitestExit !== 0 && failing.size === 0) problems.push(`vitest exited ${vitestExit} without a failing test`)
  return {
    platform,
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: failing.size,
    skipped: report.numPendingTests ?? 0,
    openByStory,
    unexpected,
    nowPassing,
    problems,
    fullSuitePassing: failing.size === 0 && vitestExit === 0
  }
}

const main = () => {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : fallback
  }
  const root = resolve(option('--root', process.cwd()))
  const reportPath = resolve(root, option('--report', 'test-results/unit.json'))
  const knownPath = resolve(root, option('--known', 'docs/epic-53-known-failures.json'))
  const exitPath = resolve(root, option('--exit-file', 'test-results/unit-exit-code'))
  if (!existsSync(reportPath)) {
    console.error(`unit inventory report missing: ${reportPath}`)
    process.exit(1)
  }
  const vitestExit = existsSync(exitPath) ? Number(readFileSync(exitPath, 'utf8').trim()) : 0
  const result = evaluateInventory({
    report: JSON.parse(readFileSync(reportPath, 'utf8')),
    known: JSON.parse(readFileSync(knownPath, 'utf8')),
    platform: option('--platform', process.platform),
    root,
    vitestExit
  })
  console.log(JSON.stringify(result, null, 2))
  for (const key of result.unexpected) console.log(`::error::Unowned failing test: ${key}`)
  for (const key of result.nowPassing) console.log(`::warning::Listed failure now passes; remove it: ${key}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const stories = Object.entries(result.openByStory).map(([story, count]) => `| ${story} | ${count} |`)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### Unit inventory (${result.platform})`,
      `${result.passed} passed, ${result.failed} failing, ${result.skipped} skipped of ${result.total}.`,
      result.fullSuitePassing ? 'Full suite passing.' : 'Full suite NOT passing; open failures are owned below and are not waived.',
      '', '| Owning story | Open failures |', '| --- | --- |', ...stories, ''
    ].join('\n'))
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(problem)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
