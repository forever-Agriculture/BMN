// MODULE: codex-launch.mjs - keeps a Codex run in a BMN session off the shared app-server daemon
// A Codex app-server daemon keeps its first client's environment, so its hooks cannot address
// this session. The session manager applies codexWithoutSharedDaemon to the agents it starts;
// the Windows `codex` launcher (codex.mjs) uses realCodexLaunch for Codex typed in a session's
// shell, as bin/codex does on Linux.
import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { prepareWindowsExecutableLaunch, windowsEnvironment, windowsEnvironmentValue } from './windows-launch.mjs'

/** Options whose next word is their value, never a command. */
const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '-C', '--cd', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
  '-a', '--ask-for-approval', '--remote-auth-token-env', '--add-dir', '-i', '--image', '--local-provider',
  '--enable', '--disable'
])

/** Adds --no-daemon unless the run already chooses a server or manages the shared daemon itself.
 * @param {readonly string[]} argv @returns {readonly string[]} */
export function codexWithoutSharedDaemon(argv) {
  let skipValue = false
  let command = null
  for (const arg of argv) {
    if (skipValue) { skipValue = false; continue }
    // Following `--`, even flag-shaped words are prompt text.
    if (arg === '--') break
    if (arg === '--no-daemon' || arg === '--remote' || arg.startsWith('--remote=')) return argv
    if (CODEX_VALUE_OPTIONS.has(arg)) { skipValue = true; continue }
    if (!arg.startsWith('-') && command === null) command = arg
  }
  if (['agents', 'app-server', 'remote-control'].includes(command ?? '')) return argv
  return ['--no-daemon', ...argv]
}

/** A folder as Windows compares it: resolved through links and 8.3 names where it exists, case-folded.
 * @param {string} folder */
function comparableFolder(folder) {
  let path = win32.resolve(folder)
  try { path = realpathSync.native(path) } catch { /* A missing folder compares by its resolved name. */ }
  return path.replace(/\\+$/u, '').toLowerCase()
}

/** The PATH without the given folders, however they are spelled, so the lookup cannot find a launcher again.
 * @param {string} path @param {readonly string[]} folders @param {(folder: string) => string} [compare] */
export function pathWithoutFolders(path, folders, compare = comparableFolder) {
  const excluded = new Set(folders.map(compare))
  return path.split(';').filter((entry) => {
    const folder = entry.replace(/^"(.*)"$/u, '$1')
    return !win32.isAbsolute(folder) || !excluded.has(compare(folder))
  }).join(';')
}

/**
 * The real Codex and the arguments it receives. BMN's launcher folders are those named by the
 * launcher, the session and this script's own folder.
 * @param {readonly string[]} argv @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} cwd @param {string} scriptFolder
 */
export function realCodexLaunch(argv, environment, cwd, scriptFolder) {
  const inSession = !!windowsEnvironmentValue(environment, 'BMN_CONTROL_SOCKET') &&
    !!windowsEnvironmentValue(environment, 'BMN_TOKEN') && !windowsEnvironmentValue(environment, 'CODEX_EXEC_SERVER_URL')
  // The launcher's runtime flag and folder are this script's; Codex gets the session's environment.
  const childEnvironment = windowsEnvironment(environment, { ELECTRON_RUN_AS_NODE: undefined, BMN_LAUNCHER_DIRECTORY: undefined })
  const folders = [windowsEnvironmentValue(environment, 'BMN_LAUNCHER_DIRECTORY'),
    windowsEnvironmentValue(environment, 'BMN_CLI_BIN_DIR'), scriptFolder].filter((folder) => !!folder && win32.isAbsolute(folder))
  const lookup = { ...childEnvironment, PATH: pathWithoutFolders(windowsEnvironmentValue(childEnvironment, 'PATH') ?? '', folders) }
  const launch = prepareWindowsExecutableLaunch('codex', inSession ? codexWithoutSharedDaemon(argv) : argv, cwd, lookup)
  return { ...launch, environment: childEnvironment }
}
