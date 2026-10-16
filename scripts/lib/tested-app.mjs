// MODULE: tested-app.mjs - the BMN a live script starts: this checkout's development build, or a packaged build named with --binary
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/**
 * `--binary PATH` starts that packaged BMN instead of Electron with this checkout's app folder (Epic 75: the
 * acceptance runs on a packaged build). `rest` is the script's own arguments without the option. The script's own
 * `bmn` calls outside BMN's sessions stay this checkout's; inside a session BMN puts its own CLI first.
 */
export function testedApp(appDirectory, argv = process.argv.slice(2)) {
  const at = argv.indexOf('--binary')
  const rest = at < 0 ? [...argv] : argv.filter((_, index) => index !== at && index !== at + 1)
  if (at < 0) return { executablePath: createRequire(join(appDirectory, 'package.json'))('electron'), appArgs: [appDirectory], build: 'development', rest }
  const binary = resolve(argv[at + 1] ?? '')
  if (!existsSync(binary)) throw new Error(`--binary names no file: ${binary}`)
  return { executablePath: binary, appArgs: [], build: binary, rest }
}
