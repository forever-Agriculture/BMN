// MODULE: doctor-startup-round.test.ts - Startup passes the same validated Sixel and fallback TERM as sessions
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { bundledTerminfoAsset, installBundledTerminfo, terminalGraphicsEnvironment } from '../utility/terminal-graphics'
import { installAgentsIpcHandlers } from './agents-ipc'

const calls = vi.hoisted(() => [] as NodeJS.ProcessEnv[])
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile: (_program: string, _args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: null, out: string, err: string) => void) => {
    calls.push(options.env); callback(null, '{}', ''); return {}
  }
}))
const roots: string[] = []
afterEach(() => { calls.splice(0); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('recovery round: startup validates the session terminfo and passes it through the filtered environment, with standard fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-doctor-term-')); roots.push(root)
  vi.stubEnv('HOME', root); vi.stubEnv('PATH', '/usr/bin:/bin')
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) vi.stubEnv(key, undefined)
  const resources = join(root, 'resources'), data = join(root, 'data'), output = join(root, 'out/main')
  const source = join(resources, 'terminfo/x/xterm-sixel-256color')
  mkdirSync(join(source, '..'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../../resources/terminfo/x/xterm-sixel-256color', import.meta.url)), source)
  const asset = bundledTerminfoAsset(data, resources, output)
  installBundledTerminfo(data, asset.source)
  const handle = installAgentsIpcHandlers({ handle: () => {} }, {
    senderIsAllowed: () => true, cliScript: () => join(root, 'bmn'), environment: () => ({ HOME: root, PATH: '/usr/bin:/bin', TERM: 'dumb', SYNTHETIC_SECRET: 'never-forward' }),
    doctorTerminalEnvironment: environment => terminalGraphicsEnvironment(null, environment, asset), autoTestKinds: [], startInstalls: []
  })
  await handle.doctorAtStart()
  expect(calls[0]?.TERM).toBe('xterm-sixel-256color'); expect(calls[0]?.TERMINFO_DIRS).toContain(asset.directory)
  expect(calls[0]).not.toHaveProperty('SYNTHETIC_SECRET')
  writeFileSync(join(asset.directory, 'x/xterm-sixel-256color'), 'invalid asset')
  await handle.doctorAtStart()
  expect(calls[1]?.TERM).toBe('xterm-256color')
})
