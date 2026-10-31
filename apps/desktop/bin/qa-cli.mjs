// MODULE: qa-cli.mjs - Epic 100.2: read-only local report check, using the shipped skill's one validator
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runQaCommand(argv) {
  if (['start', 'wait', 'stop'].includes(argv[0])) return runQaSessionCommand(argv)
  if (argv[0] === 'grant') return runQaGrantCommand(argv.slice(1))
  if (argv[0] !== 'report' || argv[1] !== 'check') {
    process.stderr.write('Usage: bmn qa report check REPORT --brief BRIEF\n       bmn qa start --brief BRIEF --key K | wait ID [--timeout SECONDS] | stop ID\n       bmn qa grant ID --account NAME --origin ORIGIN --activity ACTIVITY=COUNT... --hours H --key K\n')
    return 2
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const checker = [resolve(here, '../skills/manual-qa/check.mjs'), resolve(here, '../../../skills/manual-qa/check.mjs')].find(existsSync)
  if (checker === undefined) { process.stderr.write('bmn qa: shipped manual-qa checker is unavailable\n'); return 1 }
  const { runReportCheck } = await import(pathToFileURL(checker).href)
  return runReportCheck(argv.slice(2))
}

async function runQaSessionCommand(argv) {
  const [command, ...args] = argv
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--brief', '--key', '--timeout'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) options[arg.slice(2)] = args[++index]
    else if (arg === '--json') options.json = true
    else if (!arg.startsWith('--')) positional.push(arg)
    else { process.stderr.write('bmn qa: unknown or incomplete option\n'); return 2 }
  }
  if (command === 'start' ? positional.length || !options.brief || !options.key || options.timeout : positional.length !== 1 || options.brief || options.key) {
    process.stderr.write('Usage: bmn qa start --brief BRIEF --key K | wait ID [--timeout SECONDS] | stop ID\n'); return 2
  }
  const seconds = options.timeout === undefined ? 300 : Number(options.timeout)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) return 2
  try {
    const { call, readCredentials } = await import('./bmn-commands.mjs')
    const { textFile } = await import('./agents-team-inputs.mjs')
    const { socketPath, token } = readCredentials({})
    const params = command === 'start' ? { brief: JSON.parse(textFile(options.brief).bytes.toString('utf8')), key: options.key } : { id: positional[0] }
    let result = await call(socketPath, token, command === 'wait' ? 'qa.status' : `qa.${command}`, params, command === 'start' ? 90_000 : 10_000)
    const deadline = Date.now() + seconds * 1000
    while (command === 'wait' && ['preparing', 'running'].includes(result.state) && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 1000))
      result = await call(socketPath, token, 'qa.status', params)
    }
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : `${result.id}: ${result.result?.verdict ?? result.failure ?? result.state}\n`)
    return command === 'wait' && result.state !== 'finished' ? 1 : 0
  } catch (error) { process.stderr.write(`bmn qa: ${error.code ?? 'QA_FAILED'} ${error.message}\n`); return 1 }
}

/** A lead's planning request: it opens the owner's grant card and grants nothing until he answers (100.6, D19). */
async function runQaGrantCommand(args) {
  const usage = () => { process.stderr.write('Usage: bmn qa grant ID --account NAME --origin ORIGIN --activity ACTIVITY=COUNT... --hours H --key K [--json]\n'); return 2 }
  const options = { activity: [] }, positional = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--account', '--origin', '--activity', '--hours', '--key'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) {
      const value = args[++index]
      if (arg === '--activity') options.activity.push(value); else options[arg.slice(2)] = value
    } else if (arg === '--json') options.json = true
    else if (!arg.startsWith('--')) positional.push(arg)
    else return usage()
  }
  const hours = Number(options.hours)
  const limits = options.activity.map(item => /^([a-z]+\.[a-z]+)=([1-9][0-9]*)$/.exec(item)).map(match => match && { activity: match[1], count: Number(match[2]) })
  if (positional.length !== 1 || !options.account || !options.origin || !options.key || !limits.length || limits.some(item => !item) || !Number.isFinite(hours) || hours <= 0 || hours > 24) return usage()
  try {
    const { call, readCredentials } = await import('./bmn-commands.mjs')
    const { socketPath, token } = readCredentials({})
    const grant = await call(socketPath, token, 'qa.grant.ask', { id: positional[0], key: options.key, accountId: options.account, origin: options.origin, limits,
      expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString() })
    process.stdout.write(options.json ? JSON.stringify(grant, null, 2) + '\n' : `${grant.id}: ${grant.state}; the owner answers its card\n`)
    return 0
  } catch (error) { process.stderr.write(`bmn qa: ${error.code ?? 'QA_FAILED'} ${error.message}\n`); return 1 }
}
