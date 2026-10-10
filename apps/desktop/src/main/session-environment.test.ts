// MODULE: session-environment.test.ts - Epic 60.6/60.7: the app reads the environment a session's shell ends up with, falls back in words, and asks the shell once per burst
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionEnvironmentReader, parseShellEnvironment, readSessionEnvironment, sessionShell, type SessionEnvironment } from './session-environment'

let home: string
/** What a desktop start gives BMN: a short PATH and no settings of the owner's shell. */
const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin', ...extra })
const settings = (text: string): void => writeFileSync(join(home, '.bashrc'), text)

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-session-environment-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('the environment a session\'s shell ends up with', () => {
  it('takes what the shell\'s settings add: a folder on PATH and where an app is told to send data', async () => {
    mkdirSync(join(home, 'synthetic-manager/bin'), { recursive: true })
    settings(`export PATH="${home}/synthetic-manager/bin:$PATH"\nexport OPENAI_BASE_URL="https://proxy.example.test/v1"\n`)
    const found = await readSessionEnvironment(base({ KEPT: 'from the app' }))
    expect(found.source).toBe('shell')
    expect(found.reason).toBeUndefined()
    expect(found.env.PATH?.split(':')[0]).toBe(`${home}/synthetic-manager/bin`)
    expect(found.env.PATH).toContain('/usr/bin')
    expect(found.env).toMatchObject({ HOME: home, OPENAI_BASE_URL: 'https://proxy.example.test/v1', KEPT: 'from the app' })
    // What the shell sets for itself says nothing about a session.
    expect(Object.keys(found.env).filter((name) => ['_', 'SHLVL', 'PWD', 'OLDPWD'].includes(name))).toEqual([])
  })

  it('ignores what the settings print, also a value with line breaks', async () => {
    settings('echo "Welcome back"\nexport SYNTHETIC_NOTE="two\nlines"\nexport PATH="/synthetic/bin:$PATH"\necho "more noise" >&2\n')
    const found = await readSessionEnvironment(base())
    expect(found.source).toBe('shell')
    expect(found.env.SYNTHETIC_NOTE).toBe('two\nlines')
    expect(found.env.PATH?.startsWith('/synthetic/bin:')).toBe(true)
  })

  it('reads only the settings an interactive start reads, as a session does', async () => {
    // The usual guard: settings that stop for a shell that is not interactive still run here.
    settings('case $- in *i*) ;; *) return;; esac\nexport PATH="/synthetic/interactive:$PATH"\n')
    expect((await readSessionEnvironment(base())).env.PATH?.startsWith('/synthetic/interactive:')).toBe(true)
  })

  it('falls back to BMN\'s own environment, with the reason in words, when the shell cannot be asked', async () => {
    const own = base()
    expect(await readSessionEnvironment({ ...own, SHELL: '/usr/bin/fish' })).toEqual({ env: { ...own, SHELL: '/usr/bin/fish' }, source: 'app', reason: 'BMN does not know how to ask fish for its settings' })
    expect(await readSessionEnvironment({ ...own, SHELL: join(home, 'missing/bash') })).toMatchObject({ source: 'app', reason: 'bash could not be started' })
    // A stand-in shell that answers nothing BMN can read.
    mkdirSync(join(home, 'quiet'))
    writeFileSync(join(home, 'quiet/bash'), '#!/bin/sh\necho "no marks here"\n')
    chmodSync(join(home, 'quiet/bash'), 0o755)
    expect(await readSessionEnvironment({ ...own, SHELL: join(home, 'quiet/bash') })).toMatchObject({ env: { PATH: '/usr/bin:/bin' }, source: 'app', reason: 'bash did not report its settings' })
  })

  it('stops a shell whose settings never finish, with everything they started, and falls back', async () => {
    settings(`sleep 30 &\necho $! > "${home}/started"\nwait\n`)
    const started = Date.now()
    const found = await readSessionEnvironment(base(), { timeoutMs: 400 })
    expect(found).toMatchObject({ source: 'app', reason: 'bash did not answer in 0 seconds' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(existsSync(join(home, 'started'))).toBe(true)
    // What the settings started went with the shell.
    const pid = Number(readFileSync(join(home, 'started'), 'utf8').trim())
    const gone = (): boolean => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }
    for (let attempt = 0; attempt < 50 && !gone(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pid > 1 && gone()).toBe(true)
  })

  it('picks the shell a session would start', () => {
    expect([sessionShell({ SHELL: '/bin/zsh' }), sessionShell({ BMN_SHELL: '/bin/bash', SHELL: '/bin/zsh' }), sessionShell({})]).toEqual(['/bin/zsh', '/bin/bash', '/bin/bash'])
  })

  it('reads the variables between the two marks and nothing around them', () => {
    const mark = '__BMN_SESSION_ENVIRONMENT__\0'
    expect(parseShellEnvironment(`noise\n${mark}A=1\0B=x=y\0EMPTY=\0broken\0${mark}trailing`)).toEqual({ A: '1', B: 'x=y', EMPTY: '' })
    expect(parseShellEnvironment(`${mark}A=1\0`)).toBeNull()
    expect(parseShellEnvironment('nothing')).toBeNull()
  })
})

describe('the reader the Team and Rules pages use', () => {
  it('answers with BMN\'s own environment until the shell was asked, then with the shell\'s', async () => {
    const shell: SessionEnvironment = { env: { PATH: '/synthetic/shell' }, source: 'shell' }
    const reader = createSessionEnvironmentReader(() => ({ PATH: '/synthetic/app' }), { read: async () => shell })
    expect(reader.current()).toEqual({ env: { PATH: '/synthetic/app' }, source: 'app', reason: 'the shell was not asked yet' })
    await reader.refresh()
    expect(reader.current()).toBe(shell)
  })

  it('asks the shell once for a burst of calls and again when the reading is old', async () => {
    let clock = 1000
    let asked = 0
    const reader = createSessionEnvironmentReader(() => ({}), { ttlMs: 15_000, now: () => clock, read: async () => ({ env: { ASKED: String(asked += 1) }, source: 'shell' }) })
    await Promise.all([reader.refresh(), reader.refresh(), reader.refresh()])
    expect(asked).toBe(1)
    clock += 14_999
    await reader.refresh()
    expect(asked).toBe(1)
    clock += 1
    await reader.refresh()
    expect([asked, reader.current().env.ASKED]).toEqual([2, '2'])
  })
})
