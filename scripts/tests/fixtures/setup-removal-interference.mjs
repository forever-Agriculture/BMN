// MODULE: setup-removal-interference.mjs - Independent writer after Undo's final content observation
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const home = process.argv[2]
process.env.HOME = home
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete process.env[key]
fs.mkdirSync(join(home, '.codex'), { recursive: true })
const target = { kind: 'rules', app: 'codex', path: join(home, '.codex/AGENTS.md'), entry: 'rules' }
const originalText = '# Synthetic setup-owned rules\n'
let armed = false, replaced = false
const read = fs.readFileSync
fs.readFileSync = function (path, ...args) {
  const value = read(path, ...args)
  if (armed && !replaced && typeof path === 'number' && String(value) === originalText) {
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {writeFileSync,renameSync} from 'node:fs';
      const path=process.argv[1];writeFileSync(path+'.external','independent writer replacement');renameSync(path+'.external',path)
    `, target.path], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000 })
    if (writer.status !== 0) throw new Error('Independent synthetic writer failed')
    replaced = true
  }
  return value
}
syncBuiltinESMExports()
try {
  const { withDefaultsAdmission } = await import('../../../apps/desktop/bin/defaults-admission.mjs')
  const { initializeDefaultsOwnership } = await import('../../../apps/desktop/bin/defaults-ownership.mjs')
  const { installSetupFile, restoreSetupFileTransaction } = await import('../../../apps/desktop/bin/setup-file-defaults.mjs')
  const setupId = 'synthetic-removal-interference'
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
  const installed = installSetupFile(target, originalText, { setupId })
  if (installed.code !== 'OK') throw new Error('Synthetic installation failed')
  const folder = join(home, '.config/bmn/agents/state/rules/transactions', installed.transaction)
  const manifest = JSON.parse(read(join(folder, 'manifest.json'), 'utf8'))
  const outcome = await restoreSetupFileTransaction(manifest, folder, { yes: true, asJson: true, beforeRemove: () => { armed = true } })
  armed = false
  console.log(JSON.stringify({ replaced, code: outcome.code, message: outcome.message,
    targetText: fs.existsSync(target.path) ? read(target.path, 'utf8') : null,
    holdings: fs.readdirSync(join(home, '.codex')).filter(name => name.startsWith('.bmn-hold-')).map(name => ({ name, text: read(join(home, '.codex', name), 'utf8') })) }))
} finally { fs.readFileSync = read; syncBuiltinESMExports() }
