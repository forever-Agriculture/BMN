// MODULE: windows-launch.mjs - native Windows program lookup shared by BMN's utility process and its Windows launchers
// PATH never implicitly searches BMN's own cwd. The utility process imports this through
// src/utility/windows-launch.ts; the Windows `codex` launcher (codex.mjs) runs it directly.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

/** The last spelling of a name wins, as in a later environment layer.
 * @param {Readonly<Record<string, string | undefined>>} environment @param {string} name */
export function windowsEnvironmentValue(environment, name) {
  const folded = name.toUpperCase()
  let value
  for (const [key, candidate] of Object.entries(environment)) {
    if (key.toUpperCase() === folded) value = candidate
  }
  return value
}

/** Later layers/entries win; undefined removes a name. Emit only one PATH spelling.
 * @param {...Readonly<Record<string, string | undefined>>} layers @returns {Record<string, string>} */
export function windowsEnvironment(...layers) {
  const values = new Map()
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      const folded = name.toUpperCase()
      if (value === undefined) values.delete(folded)
      else values.set(folded, { name: folded === 'PATH' ? 'PATH' : name, value })
    }
  }
  return Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]))
}

/** @param {string} path */
function executableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.F_OK)
    return true
  } catch { return false }
}

/**
 * @param {string} command @param {string} cwd @param {Readonly<Record<string, string | undefined>>} environment
 * @param {(path: string) => boolean} [exists] @returns {string | null}
 */
export function findWindowsExecutable(command, cwd, environment, exists = executableFile) {
  if (!command || command.includes('\0')) return null
  // BMN-generated batch commands and persistent agent prompts use the system
  // interpreter. A PATH entry must not replace it with a same-named program.
  if (command.toLowerCase() === 'cmd.exe') {
    const systemRoot = windowsEnvironmentValue(environment, 'SystemRoot') ?? 'C:\\Windows'
    if (!win32.isAbsolute(systemRoot)) return null
    const interpreter = win32.join(systemRoot, 'System32', 'cmd.exe')
    return exists(interpreter) ? interpreter : null
  }
  const extensions = (windowsEnvironmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').filter((value) => /^\.[A-Za-z0-9]+$/.test(value))
  const names = win32.extname(command) ? [command] : extensions.map((extension) => command + extension)
  const explicit = /[\\/]/.test(command) || /^[A-Za-z]:/.test(command)
  const directories = explicit ? [cwd] : (windowsEnvironmentValue(environment, 'PATH') ?? '')
    .split(';').map((directory) => directory.replace(/^"(.*)"$/, '$1')).filter((directory) => win32.isAbsolute(directory))
  for (const directory of directories) {
    for (const name of names) {
      const candidate = win32.resolve(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** Exact cmd-shim@8.0.0 Node wrapper with no shebang arguments/environment setup.
 * Unknown or modified scripts retain their batch semantics; never skip their code.
 * @param {string} contents @returns {string | null} */
export function npmNodeShimTarget(contents) {
  const text = contents.replaceAll('\r\n', '\n')
  const prefix = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\'
  ].join('\n')
  const suffix = '" %*\n'
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null
  const target = text.slice(prefix.length, -suffix.length)
  if (!target || /["\r\n\0]/.test(target) || win32.isAbsolute(target) || /^[A-Za-z]:/.test(target)) return null
  return target
}

/**
 * @param {string} executable @param {readonly string[]} argv @param {string} cwd
 * @param {Readonly<Record<string, string | undefined>>} environment @returns {{ executable: string, argv: string[] }}
 */
export function prepareWindowsExecutableLaunch(executable, argv, cwd, environment) {
  let file = findWindowsExecutable(executable, cwd, environment)
  if (!file) throw new Error('The Windows program is not available on the session PATH: ' + executable)
  let args = [...argv]
  if (/\.(cmd|bat)$/i.test(file)) {
    const target = statSync(file).size <= 16384 ? npmNodeShimTarget(readFileSync(file, 'utf8')) : null
    if (!target) throw new Error('This script interprets batch syntax. Use Batch command mode to run it explicitly.')
    const entry = win32.resolve(win32.dirname(file), target)
    if (!executableFile(entry)) throw new Error('The npm shim entrypoint is missing')
    const localNode = win32.join(win32.dirname(file), 'node.exe')
    const node = executableFile(localNode) ? localNode : findWindowsExecutable('node', cwd, {
      ...windowsEnvironment(environment),
      PATHEXT: (windowsEnvironmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((value) => value.toUpperCase() !== '.JS').join(';')
    })
    if (!node || !/\.(exe|com)$/i.test(node)) throw new Error('The npm shim needs a native Node executable; use Batch command mode for a custom runtime wrapper')
    file = node
    args = [entry, ...args]
  }
  return { executable: file, argv: args }
}
