// MODULE: qa-cli.mjs - Epic 100.2: read-only local report check, using the shipped skill's one validator
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runQaCommand(argv) {
  if (argv[0] !== 'report' || argv[1] !== 'check') {
    process.stderr.write('Usage: bmn qa report check REPORT --brief BRIEF\n')
    return 2
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const checker = [resolve(here, '../skills/manual-qa/check.mjs'), resolve(here, '../../../skills/manual-qa/check.mjs')].find(existsSync)
  if (checker === undefined) { process.stderr.write('bmn qa: shipped manual-qa checker is unavailable\n'); return 1 }
  const { runReportCheck } = await import(pathToFileURL(checker).href)
  return runReportCheck(argv.slice(2))
}
