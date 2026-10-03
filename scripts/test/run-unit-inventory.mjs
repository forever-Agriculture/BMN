// Native CI entrypoint: preserve child exit evidence even when no test report is produced.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output = join(root, 'test-results')
mkdirSync(output, { recursive: true })
const receipt = { platform: process.platform, startedAt: new Date().toISOString(), children: [], completed: false }
function save() {
  const path = join(output, 'unit-process.json'), temporary = `${path}.${process.pid}.tmp`
  const serialized = JSON.stringify(receipt, null, 2)
  writeFileSync(temporary, serialized, { mode: 0o600 }); renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== serialized) throw new Error('Unit process receipt readback differs')
}
async function run(role, arguments_, cwd) {
  const entry = { role, startedAt: new Date().toISOString(), completed: false }
  receipt.children.push(entry); save()
  return await new Promise(resolve => {
    const child = spawn(process.execPath, arguments_, { cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    entry.pid = child.pid; save()
    child.once('error', error => { entry.launchError = error.code ?? 'UNKNOWN' })
    child.once('close', (code, signal) => {
      Object.assign(entry, { completed: true, exitCode: code, signal, completedAt: new Date().toISOString() })
      save(); console.info(`Unit inventory ${role}: exit=${code} signal=${signal ?? 'none'}`)
      resolve(code === 0 && !signal && !entry.launchError ? 0 : 1)
    })
  })
}
save()
let status = await run('protocol-build', [join(root, 'shared/protocol/node_modules/typescript/bin/tsc'), '-b'], join(root, 'shared/protocol'))
if (status === 0) status = await run('vitest', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=50%',
  '--exclude', '.claude/**', '--exclude', '.dev-auto/**', '--reporter=default', '--reporter=json',
  '--outputFile.json=test-results/unit.json'], root)
Object.assign(receipt, { completed: true, completedAt: new Date().toISOString(), exitCode: status }); save()
writeFileSync(join(output, 'unit-exit-code'), `${status}\n`, { mode: 0o600 })
process.exitCode = status
