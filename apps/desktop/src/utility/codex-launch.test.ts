import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { windowsEnvironmentValue } from '../../bin/windows-env.mjs'

const wrapper = fileURLToPath(new URL('../../bin/codex', import.meta.url))

it('runs the real Codex with local hooks in BMN and preserves explicit remote launches', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-codex-launch-'))
  try {
    const fake = join(root, 'codex')
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const shellPath = (value: string) => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    const path = `${shellPath(dirname(wrapper))}:${shellPath(root)}:/usr/bin:/bin`
    const programFiles = windowsEnvironmentValue(process.env, 'ProgramFiles')
    const bash = process.platform === 'win32' ? join(programFiles ?? '', 'Git', 'bin', 'bash.exe') : null
    const essentials = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec'].flatMap(key => {
      const value = windowsEnvironmentValue(process.env, key)
      return process.platform === 'win32' && value ? [[key, value]] : []
    }))
    const run = (args: string[], inBMN: boolean) => {
      const result = spawnSync(bash ?? wrapper, bash ? [shellPath(wrapper), ...args] : args, {
        env: { ...essentials, PATH: path, HOME: root, ...(process.platform === 'win32' ? { USERPROFILE: root } : {}),
          ...(inBMN ? { BMN_CONTROL_SOCKET: '/synthetic/socket', BMN_TOKEN: 'synthetic' } : {}) },
        encoding: 'utf8'
      })
      expect(result.status).toBe(0)
      return result.stdout.trim().split('\n')
    }
    expect(run(['-C', '/work'], true)).toEqual(['--no-daemon', '-C', '/work'])
    expect(run(['--remote', 'unix:///tmp/owner.sock'], true)).toEqual(['--remote', 'unix:///tmp/owner.sock'])
    expect(run(['--no-daemon'], true)).toEqual(['--no-daemon'])
    expect(run(['--', '--remote'], true)).toEqual(['--no-daemon', '--', '--remote'])
    expect(run(['--', '--no-daemon'], true)).toEqual(['--no-daemon', '--', '--no-daemon'])
    expect(run(['-C', '/work', 'agents', '--help'], true)).toEqual(['-C', '/work', 'agents', '--help'])
    expect(run(['--enable', 'agents'], true)).toEqual(['--no-daemon', '--enable', 'agents'])
    expect(run(['--disable', 'agents', 'agents', '--help'], true)).toEqual(['--disable', 'agents', 'agents', '--help'])
    expect(run(['-C', '/work'], false)).toEqual(['-C', '/work'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
