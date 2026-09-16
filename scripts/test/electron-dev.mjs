import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWithTemporaryRoot, temporaryRootContracts } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const requireFromApp = createRequire(join(appDirectory, 'package.json'))
const electronVite = requireFromApp.resolve('electron-vite/bin/electron-vite.js')
const { temporaryRoot, value: child } = startWithTemporaryRoot(
  temporaryRootContracts.electronDevelopment,
  ({ roots }) => spawn(process.execPath, [electronVite, 'dev'], {
    cwd: appDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      AITERM_CONFIG_HOME: join(roots.config, 'ai-terminal'),
      AITERM_DATA_HOME: join(roots.data, 'ai-terminal'),
      AITERM_STATE_HOME: join(roots.state, 'ai-terminal'),
      AITERM_RUNTIME_HOME: join(roots.runtime, 'ai-terminal')
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
