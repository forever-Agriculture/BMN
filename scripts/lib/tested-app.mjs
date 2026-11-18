// MODULE: tested-app.mjs - the BMN a live script starts: this checkout's development build, or a packaged build named with --binary
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/**
 * `--binary PATH` starts that packaged BMN instead of Electron with this checkout's app folder (Epic 75: the
 * acceptance runs on a packaged build). `rest` is the script's own arguments without the option. The script's own
 * `cliPath` names this build's own JavaScript CLI, including for calls outside its sessions.
 */
export function testedApp(appDirectory, argv = process.argv.slice(2)) {
  const at = argv.indexOf('--binary')
  const rest = at < 0 ? [...argv] : argv.filter((_, index) => index !== at && index !== at + 1)
  if (at < 0) return { executablePath: createRequire(join(appDirectory, 'package.json'))('electron'), appArgs: [appDirectory], cliPath: join(appDirectory, 'bin/bmn'), build: 'development', rest }
  const binary = resolve(argv[at + 1] ?? '')
  if (!existsSync(binary)) throw new Error(`--binary names no file: ${binary}`)
  const cliPath = join(dirname(binary), 'resources/bin/bmn.mjs')
  if (!existsSync(cliPath)) throw new Error(`--binary has no bundled BMN CLI: ${cliPath}`)
  return { executablePath: binary, appArgs: [], cliPath, build: binary, rest }
}
