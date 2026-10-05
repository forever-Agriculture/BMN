// Native Windows launch lookup. PATH never implicitly searches BMN's own cwd. The lookup itself lives in
// bin/windows-launch.mjs, which the Windows `codex` launcher also runs.
import { win32 } from 'node:path'
import { quoteWindowsArgv } from '@bmn/protocol'
import { prepareWindowsExecutableLaunch, windowsEnvironmentValue } from '../../bin/windows-launch.mjs'

export {
  findWindowsExecutable,
  npmNodeShimTarget,
  prepareWindowsExecutableLaunch,
  windowsEnvironment,
  windowsEnvironmentValue
} from '../../bin/windows-launch.mjs'

type Environment = Readonly<Record<string, string | undefined>>

export function windowsDefaultShell(environment: Environment): string {
  return windowsEnvironmentValue(environment, 'BMN_SHELL') ?? windowsEnvironmentValue(environment, 'AITERM_SHELL') ??
    win32.join(windowsEnvironmentValue(environment, 'SystemRoot') ?? windowsEnvironmentValue(environment, 'WINDIR') ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** node-pty's Windows string overload takes the raw tail after the executable. */
export function windowsPtyArgumentTail(executable: string, argv: readonly string[]): string {
  if (argv.some((value) => value.includes('\0'))) throw new Error('Arguments cannot contain NUL')
  if (win32.basename(executable).toLowerCase() === 'cmd.exe') {
    const commandIndex = argv.findIndex((value) => /^\/[ck]$/i.test(value))
    if (commandIndex >= 0) {
      if (argv.length !== commandIndex + 2) throw new Error('Pass the batch command as one command-text argument, or use Batch command mode')
      const before = argv.slice(0, commandIndex).filter((value) => !/^\/(d|s|v:(on|off))$/i.test(value))
      return `${quoteWindowsArgv(['/d', '/v:off', '/s', ...before, argv[commandIndex]!])} "${argv[commandIndex + 1]}"`
    }
  }
  return quoteWindowsArgv(argv)
}

export function prepareWindowsPtyLaunch(executable: string, argv: readonly string[], cwd: string, environment: Environment): {
  executable: string
  arguments: string
} {
  const launch = prepareWindowsExecutableLaunch(executable, argv, cwd, environment)
  return { executable: launch.executable, arguments: windowsPtyArgumentTail(launch.executable, launch.argv) }
}
