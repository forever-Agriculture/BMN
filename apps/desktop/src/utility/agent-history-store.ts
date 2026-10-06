// MODULE: agent-history-store.ts - shared pieces of the history adapters: read-only agent databases, PATH lookup, the delete command
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, win32 } from 'node:path'
import { findWindowsExecutable, prepareWindowsExecutableLaunch, windowsEnvironment, windowsEnvironmentValue } from './windows-launch'
import type { DatabaseConnection } from './database-initialization'

/**
 * Opens an agent's database read-only. The agents keep their databases in WAL mode: a read-only
 * connection sees rows still in the WAL, while `immutable=1` misses them (docs/agent-history.md).
 */
export type OpenReadOnly = (path: string) => DatabaseConnection & { close(): unknown }

/** The first executable called `name` on PATH, or null. */
export function findOnPath(name: string, path?: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const searchPath = path ?? (process.platform === 'win32' ? windowsEnvironmentValue(environment, 'PATH') : environment.PATH) ?? ''
  if (process.platform === 'win32') return findWindowsExecutable(name, process.cwd(), { ...windowsEnvironment(environment), PATH: searchPath })
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue
    const candidate = `${directory}/${name}`
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/** Runs one query on a fresh read-only connection and closes it. */
export function readOnlyQuery<T>(open: OpenReadOnly, path: string, work: (database: DatabaseConnection) => T): T {
  if (!existsSync(path)) throw new Error(`${path} does not exist`)
  const database = open(path)
  try {
    return work(database)
  } finally {
    database.close()
  }
}

/** The table's columns, so a store whose shape changed reads as not recognised instead of misread. */
export function missingColumns(database: DatabaseConnection, table: string, required: readonly string[]): string[] {
  const rows = database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>
  const present = new Set(rows.map((row) => row.name))
  return required.filter((column) => !present.has(column))
}

export interface RunResult { code: number | null; output: string }

/** One agent command, no shell, bounded in time; the last line of its output explains a failure. */
export function runAgentCommand(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<RunResult> {
  const environment = options.env ?? process.env
  let launch = { executable, argv: [...args] }
  if (process.platform === 'win32') {
    try {
      launch = prepareWindowsExecutableLaunch(executable, args, options.cwd ?? process.cwd(), environment)
      if (win32.basename(launch.executable).toLowerCase() === 'cmd.exe') throw new Error('History commands require a native executable or an unchanged npm Node shim')
    } catch (error) {
      return Promise.resolve({ code: null, output: error instanceof Error ? error.message : 'Cannot prepare native history command' })
    }
  }
  return new Promise((resolve) => {
    execFile(launch.executable, launch.argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: process.platform === 'win32' ? windowsEnvironment(environment) : environment,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 256 * 1024
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      resolve({ code, output: `${stdout}\n${stderr}` })
    })
  })
}

/** The line that says why a command failed, without colour codes. */
export function failureLine(output: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('WARNING:'))
  return (lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? 'no output').slice(0, 160)
}

/** The environment an agent command runs in: the app's own, minus anything that would route it back into BMN. */
export function agentCommandEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = process.platform === 'win32' ? windowsEnvironment(base) : { ...base }
  for (const key of Object.keys(env)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key
    if (name.startsWith('BMN_') || name.startsWith('AITERM_')) delete env[key]
  }
  return env
}
