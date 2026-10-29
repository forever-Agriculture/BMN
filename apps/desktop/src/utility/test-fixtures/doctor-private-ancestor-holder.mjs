// MODULE: doctor-private-ancestor-holder.mjs - keep a real inspection namespace alive across its paired acquisition
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
try {
  const context = JSON.parse(readFileSync(0, 'utf8'))
  const readyAt = Date.now()
  if (readyAt >= context.start) throw new Error('OVERLAP_NOT_PROVEN')
  await sleep(context.start - Date.now())
  const scanStart = Date.now()
  const child = spawn(process.execPath, ['--no-warnings', process.argv[2], '{}', String(context.deadline)], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = [], stderr = []
  child.stdout.on('data', value => stdout.push(value))
  child.stderr.on('data', value => stderr.push(value))
  child.stdin.end(JSON.stringify({ mode: 'acquire', keys: context.keys }))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  if (code !== 0) throw new Error('INSPECTION_FAILED')
  const scanEnd = Date.now()
  if (scanEnd >= context.release) throw new Error('OVERLAP_NOT_PROVEN')
  await sleep(context.release - Date.now())
  const heldUntil = Date.now()
  process.stdout.write(Buffer.concat(stdout))
  process.stderr.write(JSON.stringify({ rows: JSON.parse(Buffer.concat(stderr).toString()), readyAt, scanStart, scanEnd, heldUntil }))
} catch (error) {
  process.stdout.write(JSON.stringify({ failure: error.message === 'OVERLAP_NOT_PROVEN' ? error.message : 'INSPECTION_FAILED' }))
  process.exitCode = 1
}
