// MODULE: programs.ts - the self-test's stand-in programs and the shell it types into, per platform
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let windowsLauncher: string | undefined

/** Windows stand-ins are copies of the bmn.exe launcher; the self-test names it once, from the host's environment. */
export function useStandInLauncher(path: string | undefined): void {
  windowsLauncher = path
}

/**
 * Writes `source` as a Node program named `name` in `directory` and returns the path that runs it.
 * POSIX: an executable script with a shebang. Windows has no shebang: a copy of the bmn.exe launcher
 * runs the script on BMN's own runtime as Node through the bmn.runtime sidecar it reads from its own
 * folder, so a folder holds one program and no Node install is needed.
 */
export function writeNodeProgram(directory: string, name: string, source: string): string {
  mkdirSync(directory, { recursive: true })
  if (process.platform !== 'win32') {
    writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
    const executable = join(directory, name)
    writeFileSync(executable, `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}\n${source}`, { mode: 0o700 })
    return executable
  }
  if (!windowsLauncher) throw new Error('the self-test has no bmn.exe launcher for its stand-in programs')
  const script = join(directory, `${name}.cjs`)
  const sidecar = join(directory, 'bmn.runtime')
  const runtime = `${process.execPath}\n${script}\n`
  if (existsSync(sidecar) && readFileSync(sidecar, 'utf8') !== runtime) {
    throw new Error(`${directory} already holds another stand-in program`)
  }
  writeFileSync(script, source)
  writeFileSync(sidecar, runtime)
  const executable = join(directory, `${name}.exe`)
  copyFileSync(windowsLauncher, executable)
  return executable
}

/** The interactive shell the self-test types into: bash on Linux, Windows PowerShell on Windows. */
export interface SelfTestShell {
  readonly windows: boolean
  readonly executable: string
  readonly argv: readonly string[]
}

export function selfTestShell(): SelfTestShell {
  if (process.platform !== 'win32') return { windows: false, executable: '/bin/bash', argv: ['--noprofile', '--norc'] }
  return {
    windows: true,
    executable: join(windowsSystemFolder(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    argv: ['-NoLogo', '-NoProfile']
  }
}

/** A PowerShell single-quoted literal. */
export function powerShellQuote(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}

/** The folder holding Windows' own programs (powershell.exe's tree, cmd.exe). */
export function windowsSystemFolder(): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32')
}

/**
 * The Windows shell-regression checks, run by Windows PowerShell through Invoke-Expression, which
 * no execution policy refuses. The shell asks for primary device attributes itself and reads the
 * reply as keys, as bash does with stty and dd; then it prints its terminal names, a console-API
 * color (which ConPTY turns into a color sequence) and a 256-color sequence.
 */
export const WINDOWS_SHELL_CHECKS = [
  '$e = [char]27',
  "$reply = ''",
  '[Console]::Out.Write("$e[c")',
  '$end = [DateTime]::UtcNow.AddSeconds(3)',
  "while ([DateTime]::UtcNow -lt $end -and -not $reply.EndsWith('c')) {",
  '  if ([Console]::KeyAvailable) { $reply += [Console]::ReadKey($true).KeyChar } else { Start-Sleep -Milliseconds 20 }',
  '}',
  "$da1 = if ($reply) { $reply.Replace([string]$e, '033') } else { 'none' }",
  "Write-Output ('REGRESSION term=' + $env:TERM + ' colorterm=' + $env:COLORTERM)",
  "Write-Output ('REGRESSION2 da1=' + $da1)",
  "Write-Host 'REGRESSION-HOSTCOLOR' -ForegroundColor Green",
  '[Console]::Out.Write("$e[38;5;202mREGRESSION-256$e[0m`n")',
  ''
].join('\r\n')

/** A full-screen program in the shell: alternate screen, SGR mouse and bracketed paste until a key, then restored. */
export const WINDOWS_FULL_SCREEN = [
  '$e = [char]27',
  "[Console]::Out.Write(\"$e[?1049h$e[?1000h$e[?1006h$e[?2004h\" + 'FULL-SCREEN-READY')",
  '$null = [Console]::ReadKey($true)',
  '[Console]::Out.Write("$e[?2004l$e[?1006l$e[?1000l$e[?1049l")',
  "Write-Output 'FULL-SCREEN-DONE'",
  ''
].join('\r\n')
