// MODULE: doctor-inspection-worker.mjs - Trusted inspection entry; public stdout and separately bounded private receipt pipe
import { readFileSync } from 'node:fs'
import { inspectLeftovers } from './doctor-leftovers.mjs'
import { matchContinuity, validRowReceipts, validWorkerKeys } from './doctor-continuity.mjs'

async function main() {
  const context = JSON.parse(readFileSync(0, 'utf8'))
  if (!context || !['acquire', 'resolve'].includes(context.mode) || !validWorkerKeys(context.keys) ||
    Object.keys(context).sort().join(',') !== (context.mode === 'resolve' ? 'keys,mode,rows' : 'keys,mode') ||
    context.mode === 'resolve' && !validRowReceipts(context.rows)) throw new Error('inspection unavailable')
  const deadline = Number(process.argv[3])
  if (!Number.isSafeInteger(deadline)) throw new Error('inspection unavailable')
  const { result, rows } = await inspectLeftovers(JSON.parse(process.argv[2]), { keys: context.keys, privateReceipts: true,
    deadline: Math.min(deadline, Date.now() + 58000) })
  if (!validRowReceipts(rows, result.leftovers?.length ?? 0)) throw new Error('inspection unavailable')
  if (context.mode === 'acquire') {
    process.stderr.write(JSON.stringify(rows))
    process.stdout.write(JSON.stringify(result))
  } else process.stdout.write(JSON.stringify({ result, matches: matchContinuity(context.rows, rows) }))
}
main().catch(() => { process.exitCode = 1 })
