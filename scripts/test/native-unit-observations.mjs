// Temporary, named observations retain the original acceptance deadlines.
// Larger Windows fixture ceilings collect stages; they cannot close these gates.
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
  ].map(name => ({ file: dataFile, fullName: `${dataSuite} ${name}`, originalBudgetMs: 5000 })),
  { file: backupFile, fullName: 'backup keeps two exports at the same timestamp independent and preserves the first snapshot', originalBudgetMs: 5000 },
  { file: backupFile, fullName: 'backup exports every ready artifact, not only the newest 1,000', originalBudgetMs: 30000 }
]
export const nativeUnitOriginalBudgets = [
  ...nativeUnitObservations,
  { file: 'scripts/tests/windows-release-transaction.test.mjs',
    fullName: 'Windows versioned release activation refuses source drift inside the lease immediately before selecting a candidate', originalBudgetMs: 5000 }
]
