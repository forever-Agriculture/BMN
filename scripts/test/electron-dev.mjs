// MODULE: electron-dev.mjs - Isolate BMN development data while preserving agent apps' installed paths
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWithTemporaryRoot, temporaryRootContracts } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const requireFromApp = createRequire(join(appDirectory, 'package.json'))
const electronVite = join(dirname(requireFromApp.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
const { temporaryRoot, value: child } = startWithTemporaryRoot(
  temporaryRootContracts.electronDevelopment,
  ({ roots }) => spawn(process.execPath, [electronVite, 'dev'], {
    cwd: appDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Agents inherit this environment too: their updates must survive BMN's temporary-root cleanup.
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn')
    }
  })
)

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  temporaryRoot.cleanup()
}

process.once('exit', cleanup)

child.once('error', (error) => {
  cleanup()
  console.error(`[BMN] development launch failed: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  cleanup()
  if (signal) console.error(`[BMN] development launch ended from ${signal}`)
  process.exitCode = code ?? 1
})
