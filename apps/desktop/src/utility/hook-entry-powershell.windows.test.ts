// MODULE: hook-entry-powershell.windows.test.ts - The hook entry BMN writes on Windows, run by real PowerShell.
// Codex and Cursor run hook commands through PowerShell on Windows, and Claude Code does for an entry pinned to it.
// This runs the exact entry `bmn hooks install` writes the way such a harness would: PowerShell given the entry
// as its command and the payload on standard input. The harnesses themselves are not run here.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { useStandInLauncher, writeNodeProgram } from '../main/self-test/programs'

const native = process.platform === 'win32'
const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Records what it was called with; a non-ASCII payload shows the bytes arrive unchanged.
const RECORDER = `const { readFileSync, writeFileSync } = require('node:fs')
writeFileSync(process.env.BMN_TEST_HOOK_RECORD, JSON.stringify({ argv: process.argv.slice(2),
  stdin: readFileSync(0).toString('base64') }))`

function shells(): Array<[string, string]> {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const core = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  return [['Windows PowerShell', system], ...(existsSync(core) ? [['PowerShell 7', core] as [string, string]] : [])]
}

describe.runIf(native)('the Windows hook entry under PowerShell (Story 53.6)', () => {
  it('runs bmn hook with the payload only inside a BMN session that has the CLI, and always exits 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-hook-entry-'))
    roots.push(root)
    const file = join(root, 'hooks.json')
    execFileSync(process.execPath, [CLI, 'hooks', 'install', '--yes', 'codex', '--file', file, '--json'],
      { env: { ...process.env, USERPROFILE: root, HOME: root }, encoding: 'utf8' })
    const entry = (JSON.parse(readFileSync(file, 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } })
      .hooks.Stop[0]!.hooks[0]!.command
    expect(entry).toMatch(/^if \(\$env:BMN_CONTROL_SOCKET/u)

    useStandInLauncher(fileURLToPath(new URL('../../native-out/windows-cli/bmn.exe', import.meta.url)))
    const cliFolder = join(root, 'cli')
    writeNodeProgram(cliFolder, 'bmn', RECORDER)
    const payload = `{"hook_event_name":"Stop","note":"Grüße — 日本"}`
    const base = { ...process.env }
    delete base.BMN_CONTROL_SOCKET
    for (const [label, shell] of shells()) {
      const run = (env: Record<string, string | undefined>, record: string) => {
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', entry],
          { input: Buffer.from(payload, 'utf8'), env: { ...base, ...env, BMN_TEST_HOOK_RECORD: record }, encoding: 'utf8', timeout: 60_000, windowsHide: true })
        return { status: result.status, stderr: result.stderr, recorded: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null }
      }
      const withCli = `${cliFolder};${process.env.PATH ?? ''}`

      const inSession = run({ BMN_CONTROL_SOCKET: join(root, 'control.sock'), PATH: withCli }, join(root, `${label}-session.json`))
      expect(inSession, label).toMatchObject({ status: 0, stderr: '' })
      expect(inSession.recorded?.argv, label).toEqual(['hook', 'codex'])
      expect(Buffer.from(inSession.recorded?.stdin ?? '', 'base64').toString('utf8'), label).toBe(payload)

      const outside = run({ PATH: withCli }, join(root, `${label}-outside.json`))
      expect(outside, label).toEqual({ status: 0, stderr: '', recorded: null })

      const noCli = run({ BMN_CONTROL_SOCKET: join(root, 'control.sock') }, join(root, `${label}-no-cli.json`))
      expect(noCli, label).toEqual({ status: 0, stderr: '', recorded: null })
    }
  }, 180_000)
})
