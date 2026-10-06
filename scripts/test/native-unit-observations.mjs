// Temporary, named observations retain the original acceptance deadlines.
// Larger Windows fixture ceilings collect stages; they cannot close these gates.
import { relative } from 'node:path'
const dataFile = 'scripts/tests/windows-release-data.test.mjs'
const dataSuite = 'release data compatibility and snapshot'
const backupFile = 'apps/desktop/src/utility/companion-service.test.ts'
export const nativeUnitObservations = [
  ...[
    'checks a matching schema read-only without producing a snapshot',
    'makes and verifies a consistent private recovery file before a newer migration',
    'refuses a newer or unrecognized schema before writing any recovery file',
    'supports a provisioned snapshot subdirectory and refuses a sibling outside data',
    'backs up committed WAL data consistently without losing uncheckpointed records'
  ].map(name => ({ file: dataFile, fullName: `${dataSuite} ${name}`, runnerName: `${dataSuite} > ${name}`, originalBudgetMs: 5000 })),
  { file: backupFile, fullName: 'backup keeps two exports at the same timestamp independent and preserves the first snapshot',
    runnerName: 'backup > keeps two exports at the same timestamp independent and preserves the first snapshot', originalBudgetMs: 5000 },
  { file: backupFile, fullName: 'backup exports every ready artifact, not only the newest 1,000',
    runnerName: 'backup > exports every ready artifact, not only the newest 1,000', originalBudgetMs: 30000 },
  { file: 'apps/desktop/src/utility/agent-history-claude.test.ts',
    fullName: 'Claude history folders writes through a symlinked settings file and keeps the link',
    runnerName: 'Claude history folders > writes through a symlinked settings file and keeps the link', originalBudgetMs: 5000 },
  { file: 'scripts/tests/windows-installed-worker.test.mjs',
    fullName: 'smokes with fresh homes and excludes owner credentials, Node flags and BMN bindings',
    runnerName: 'smokes with fresh homes and excludes owner credentials, Node flags and BMN bindings', originalBudgetMs: 5000 }
]
export const nativeUnitOriginalBudgets = [
  ...nativeUnitObservations,
  { file: 'scripts/tests/windows-release-transaction.test.mjs',
    fullName: 'Windows versioned release activation refuses source drift inside the lease immediately before selecting a candidate', originalBudgetMs: 5000 }
]

export const nativeObservationPattern = row => `^${row.runnerName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`

export function evaluateNativeObservation(report, row, root) {
  const executed = (report.testResults ?? []).flatMap(file => (file.assertionResults ?? [])
    .filter(test => test.status === 'passed' || test.status === 'failed').map(test => ({ file: file.name, ...test })))
  const expected = executed.length === 1 && executed[0].fullName === row.fullName &&
    relative(root, executed[0].file).split('\\').join('/') === row.file
  const test = expected ? executed[0] : null
  return { executedCount: executed.length, executedExpected: expected,
    accepted: Boolean(test && test.status === 'passed' && Number.isFinite(test.duration) && test.duration <= row.originalBudgetMs),
    originalBudgetMs: row.originalBudgetMs, durationMs: test?.duration ?? null }
}
