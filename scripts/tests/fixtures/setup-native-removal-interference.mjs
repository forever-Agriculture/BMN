// MODULE: setup-native-removal-interference.mjs - Actual helper inode mismatch after an independent replacement inside its native window
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const [home, raceHelper] = process.argv.slice(2)
process.env.HOME = home
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete process.env[key]
fs.mkdirSync(join(home, '.codex'), { recursive: true })
const target = { kind: 'rules', app: 'codex', path: join(home, '.codex/AGENTS.md'), entry: 'rules' }
const originalSpawn = childProcess.spawnSync
const nativeReceipts = []
childProcess.spawnSync = function (program, args, options) {
  const inject = basename(program) === 'defaults-publish' && args[0] === 'AGENTS.md' && args[1].startsWith('.bmn-hold-')
  const result = originalSpawn(inject ? raceHelper : program, args, options)
  if (inject) nativeReceipts.push(JSON.parse(result.stdout))
  return result
}
syncBuiltinESMExports()
try {
  const { withDefaultsAdmission } = await import('../../../apps/desktop/bin/defaults-admission.mjs')
  const { initializeDefaultsOwnership } = await import('../../../apps/desktop/bin/defaults-ownership.mjs')
  const { installSetupFile, restoreSetupFileTransaction } = await import('../../../apps/desktop/bin/setup-file-defaults.mjs')
  const setupId = 'synthetic-native-removal'
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
  const installed = installSetupFile(target, 'synthetic setup rules', { setupId })
  if (installed.code !== 'OK') throw new Error('Synthetic file installation failed')
  const folder = join(home, '.config/bmn/agents/state/rules/transactions', installed.transaction)
  const manifest = JSON.parse(fs.readFileSync(join(folder, 'manifest.json'), 'utf8'))
  const result = await restoreSetupFileTransaction(manifest, folder, { yes: true, asJson: true })
  console.log(JSON.stringify({ nativeReceipts, code: result.code, recovery: result.recovery,
    targetText: fs.existsSync(target.path) ? fs.readFileSync(target.path, 'utf8') : null,
    holdings: fs.readdirSync(join(home, '.codex')).filter(name => name.startsWith('.bmn-hold-')).map(name => fs.readFileSync(join(home, '.codex', name), 'utf8')),
    retry: (await restoreSetupFileTransaction(manifest, folder, { yes: true, asJson: true })).code }))
} finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports() }
