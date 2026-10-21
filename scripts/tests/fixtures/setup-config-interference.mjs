// MODULE: setup-config-interference.mjs - Independent replacement at a setup shared-config publication boundary
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const [home, mode] = process.argv.slice(2)
process.env.HOME = home
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete process.env[key]
const path = join(home, '.codex/hooks.json'), foreign = '{"synthetic_foreign":"independent-config-writer"}\n'
const originalRename = fs.renameSync, originalSpawn = childProcess.spawnSync
let armed = false, replaced = false
const interfere = () => {
  if (!armed || replaced) return
  const result = originalSpawn(process.execPath, ['--input-type=module', '-e', `
    import {writeFileSync,renameSync} from 'node:fs';
    const path=process.argv[1];writeFileSync(path+'.external',process.argv[2]);renameSync(path+'.external',path)
  `, path, foreign], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000 })
  if (result.status !== 0) throw new Error('Independent shared-config writer failed')
  replaced = true
}
fs.renameSync = function (source, target, ...args) {
  if (target === path) interfere()
  return originalRename(source, target, ...args)
}
childProcess.spawnSync = function (program, args, ...rest) {
  if (basename(program) === 'defaults-publish' && [args[0], args[1]].includes(basename(path))) interfere()
  return originalSpawn(program, args, ...rest)
}
syncBuiltinESMExports()
try {
  const { installSetupHook, restoreSetupHookTransaction } = await import('../../../apps/desktop/bin/setup-hook-defaults.mjs')
  fs.writeFileSync(path, '{"synthetic_original":true}\n')
  const options = { setupId: 'synthetic-hooks-79', environment: { HOME: home, PATH: '/usr/bin:/bin' } }
  let outcome
  if (mode === 'install') outcome = installSetupHook('codex', 'Stop', { ...options, beforePublish: () => { armed = true } })
  else {
    const installed = installSetupHook('codex', 'Stop', options)
    if (installed.code !== 'OK') throw new Error('Synthetic hook prerequisite failed')
    const folder = join(home, '.config/bmn/agents/state/rules/transactions', installed.transaction)
    const manifest = JSON.parse(fs.readFileSync(join(folder, 'manifest.json'), 'utf8'))
    outcome = await restoreSetupHookTransaction(manifest, folder, { yes: true, asJson: true, beforeRemove: () => { armed = true } })
  }
  armed = false
  console.log(JSON.stringify({ replaced, code: outcome.code, message: outcome.message, foreign,
    targetText: fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null,
    holdings: fs.readdirSync(join(home, '.codex')).filter(name => name.startsWith('.bmn-hold-')).map(name => fs.readFileSync(join(home, '.codex', name), 'utf8')) }))
} finally {
  fs.renameSync = originalRename; childProcess.spawnSync = originalSpawn; syncBuiltinESMExports()
}
