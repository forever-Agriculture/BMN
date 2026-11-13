// MODULE: native-test-home.test.mjs - Epic 125 Story 125.1 AC1: a native driver refuses every home and profile but the tests' own
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NATIVE_TEST_BMN_ROOTS, NATIVE_TEST_FORBIDDEN_VARIABLES, NATIVE_TEST_HOME_ROOTS, NativeTestEnvironmentError,
  assertNativeTestEnvironment, assertNativeTestSignIn, nativeTestEnvironment, nativeTestRoot, nativeTestSignIns
} from '../test/native-test-home.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let base, root, outside

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-native-home-')))
  root = join(base, 'real-home/.local/state/bmn/test-profiles')
  outside = join(base, 'real-home/.claude')
  for (const folder of ['home', 'claude', 'codex']) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 })
  mkdirSync(outside, { recursive: true, mode: 0o700 })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const good = () => nativeTestEnvironment({ root, caller: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OPENAI_API_KEY: 'never-passed', HOME: '/somewhere/else' } })
const refusal = (env, options = { root }) => {
  try { assertNativeTestEnvironment(env, options) } catch (error) {
    expect(error).toBeInstanceOf(NativeTestEnvironmentError)
    expect(error.code).toBe('NATIVE_TEST_ENVIRONMENT')
    return error.reason
  }
  return null
}

describe('the environment a native driver is started with', () => {
  it('accepts the test home, its XDG roots and the two test profiles, and returns them', () => {
    expect(assertNativeTestEnvironment(good(), { root })).toEqual({ root, home: join(root, 'home'), claude: join(root, 'claude'), codex: join(root, 'codex') })
  })

  it('builds an environment from the test folders alone: no caller home, credential or BMN session is carried', () => {
    const env = nativeTestEnvironment({ root, caller: { PATH: '/usr/bin', HOME: '/home/him', CLAUDE_CONFIG_DIR: '/home/him/.claude', CODEX_HOME: '/home/him/.codex', ANTHROPIC_API_KEY: 'x', BMN_TOKEN: 'y', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } })
    expect(env.HOME).toBe(join(root, 'home'))
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude'))
    expect(env.CODEX_HOME).toBe(join(root, 'codex'))
    expect(env.PATH).toBe('/usr/bin')
    for (const name of NATIVE_TEST_HOME_ROOTS) expect(env[name].startsWith(join(root, 'home') + '/')).toBe(true)
    for (const name of NATIVE_TEST_FORBIDDEN_VARIABLES) expect(env[name]).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('/home/him')
    expect(JSON.stringify(env)).not.toContain('/run/user')
  })

  it.each(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', ...NATIVE_TEST_HOME_ROOTS])('refuses a missing %s', (name) => {
    const env = good(); delete env[name]
    expect(refusal(env)).toBe(`${name} is missing`)
    expect(refusal({ ...good(), [name]: '' })).toBe(`${name} is missing`)
  })

  it.each([['HOME', 'home'], ['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex']])('refuses a %s that is his real one or any other folder', (name) => {
    expect(refusal({ ...good(), [name]: outside })).toBe(`${name} is not the test folder`)
    expect(refusal({ ...good(), [name]: join(root, 'home/elsewhere') })).toBe(`${name} is not the test folder`)
    expect(refusal({ ...good(), [name]: dirname(root) })).toBe(`${name} is not the test folder`)
  })

  it.each(NATIVE_TEST_HOME_ROOTS)('refuses an XDG root %s outside the test home, or the test home itself', (name) => {
    expect(refusal({ ...good(), [name]: join(base, 'real-home/.config') })).toBe(`${name} is outside the test home`)
    expect(refusal({ ...good(), [name]: join(root, 'claude/x') })).toBe(`${name} is outside the test home`)
    expect(refusal({ ...good(), [name]: join(root, 'home') })).toBe(`${name} is outside the test home`)
    expect(refusal({ ...good(), [name]: join(root, 'homework') })).toBe(`${name} is outside the test home`)
  })

  it.each(NATIVE_TEST_BMN_ROOTS)('accepts %s unset or below the test home and refuses it anywhere else', (name) => {
    expect(refusal({ ...good(), [name]: join(root, 'home/run-1/bmn') })).toBeNull()
    expect(refusal({ ...good(), [name]: join(base, 'real-home/.config/bmn') })).toBe(`${name} is outside the test home`)
  })

  it('refuses a path that is relative or not plain', () => {
    expect(refusal({ ...good(), HOME: 'home' })).toBe('HOME is not an absolute, plain path')
    expect(refusal({ ...good(), XDG_DATA_HOME: `${root}/home/a/../../../x` })).toBe('XDG_DATA_HOME is not an absolute, plain path')
    expect(refusal({ ...good(), CODEX_HOME: join(root, 'codex') + '/' })).toBe('CODEX_HOME is not an absolute, plain path')
  })

  it('refuses a link at the home, at a profile, or anywhere in an XDG root below the test-profiles folder', () => {
    rmSync(join(root, 'claude'), { recursive: true }); symlinkSync(outside, join(root, 'claude'))
    expect(refusal(good())).toBe('CLAUDE_CONFIG_DIR has a link in its path')
    rmSync(join(root, 'claude')); mkdirSync(join(root, 'claude'), { mode: 0o700 })

    symlinkSync(outside, join(root, 'home/.config'))
    expect(refusal(good())).toBe('XDG_CONFIG_HOME has a link in its path')
    rmSync(join(root, 'home/.config'))

    mkdirSync(join(root, 'home/.local'), { mode: 0o700 }); symlinkSync(outside, join(root, 'home/.local/share'))
    expect(refusal({ ...good(), XDG_DATA_HOME: join(root, 'home/.local/share/deeper') })).toBe('XDG_DATA_HOME has a link in its path')
    // A link whose target is inside the test folders is a link all the same.
    rmSync(join(root, 'home/.local/share')); symlinkSync(join(root, 'home'), join(root, 'home/.local/share'))
    expect(refusal(good())).toBe('XDG_DATA_HOME has a link in its path')
  })

  it('refuses a test-profiles folder that is a link, is missing, or sits below a linked parent', () => {
    const linked = join(base, 'linked-root'); symlinkSync(root, linked)
    expect(refusal(nativeTestEnvironment({ root: linked, caller: {} }), { root: linked })).toBe('the test-profiles folder is a link or not a folder')
    const viaParent = join(base, 'parent-link'); symlinkSync(dirname(root), viaParent)
    const below = join(viaParent, 'test-profiles')
    expect(refusal(nativeTestEnvironment({ root: below, caller: {} }), { root: below })).toBe('a parent of the test-profiles folder is a link')
    const missing = join(base, 'none/test-profiles')
    expect(refusal(nativeTestEnvironment({ root: missing, caller: {} }), { root: missing })).toMatch(/^the test-profiles folder does not exist/u)
  })

  it.each(NATIVE_TEST_FORBIDDEN_VARIABLES)('refuses an environment that carries %s', (name) => {
    expect(refusal({ ...good(), [name]: 'anything' })).toMatch(new RegExp(`^${name} is set`, 'u'))
  })

  it('refuses a home or profile that others can read, or that is missing', () => {
    chmodSync(join(root, 'codex'), 0o755)
    expect(refusal(good())).toBe(`${join(root, 'codex')} is not a private folder`)
    chmodSync(join(root, 'codex'), 0o700)
    rmSync(join(root, 'home'), { recursive: true })
    expect(refusal(good())).toBe(`${join(root, 'home')} does not exist`)
  })

  it('names the real test-profiles folder from the account record, whatever HOME says', () => {
    const before = process.env.HOME
    process.env.HOME = join(root, 'home')
    try { expect(nativeTestRoot()).not.toContain('test-profiles/home') } finally { process.env.HOME = before }
    expect(nativeTestRoot('/home/someone')).toBe('/home/someone/.local/state/bmn/test-profiles')
  })
})

describe('a test profile\'s own sign-in', () => {
  it('is present only as an ordinary file with one name; a link or a second name is not one', () => {
    expect(nativeTestSignIns({ root })).toEqual({ claude: false, codex: false })
    writeFileSync(join(root, 'claude/.credentials.json'), 'made up', { mode: 0o600 })
    writeFileSync(join(outside, 'his-sign-in'), 'made up', { mode: 0o600 })
    symlinkSync(join(outside, 'his-sign-in'), join(root, 'codex/auth.json'))
    expect(nativeTestSignIns({ root })).toEqual({ claude: true, codex: false })
    expect(() => assertNativeTestSignIn('codex', { root })).toThrow(/holds no sign-in file of its own/u)
    rmSync(join(root, 'codex/auth.json')); linkSync(join(outside, 'his-sign-in'), join(root, 'codex/auth.json'))
    expect(nativeTestSignIns({ root }).codex).toBe(false)
    expect(() => assertNativeTestSignIn('claude', { root })).not.toThrow()
  })

  it('is never opened: presence is read from the folder entry of a file nobody may read', () => {
    writeFileSync(join(root, 'codex/auth.json'), 'made up', { mode: 0o000 })
    expect(nativeTestSignIns({ root }).codex).toBe(true)
  })
})

describe('the launcher', () => {
  it('prints its usage and starts nothing without a command', () => {
    const result = spawnSync(process.execPath, [join(repo, 'scripts/test/native-test-home.mjs')], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })
})

describe('the native drivers', () => {
  const tracked = ['scripts/test/away-skills-live.mjs', 'scripts/test/away-wake-live.mjs']
  it.each(tracked)('%s imports the guard before every other module, so the check runs first', (file) => {
    const imports = readFileSync(join(repo, file), 'utf8').split('\n').filter(line => /^import\s/u.test(line))
    expect(imports[0]).toMatch(/^import \{ nativeTest \} from '\.\/native-test-guard\.mjs'/u)
  })

  it('the guard module is the check on the environment the driver was started with, and nothing else', () => {
    const lines = readFileSync(join(repo, 'scripts/test/native-test-guard.mjs'), 'utf8').split('\n').filter(line => line.trim() !== '' && !/^\s*(\/\/|\/\*\*|\*)/u.test(line))
    expect(lines).toEqual(["import { assertNativeTestEnvironment } from './native-test-home.mjs'", 'export const nativeTest = assertNativeTestEnvironment(process.env)'])
  })

  it.each(tracked)('%s refuses his real home and profiles before it launches anything', (file) => {
    const result = spawnSync(process.execPath, [join(repo, file), join(base, 'scratch')], {
      encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH, HOME: join(base, 'real-home'), CLAUDE_CONFIG_DIR: outside, CODEX_HOME: join(base, 'real-home/.codex'), XDG_RUNTIME_DIR: join(base, 'runtime') }
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REFUSED: native tests run only on the test home and profiles')
    expect(readdirSync(base).sort()).toEqual(['real-home'])
  })

  it('link or copy no sign-in: no driver in scripts/test names a sign-in file beside a link or copy call', () => {
    const offenders = []
    for (const name of readdirSync(join(repo, 'scripts/test'))) {
      if (!/\.(mjs|py|sh)$/u.test(name) || name === 'native-test-home.mjs') continue
      const lines = readFileSync(join(repo, 'scripts/test', name), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/\.credentials\.json|['"/]auth\.json/u.test(line) && /symlinkSync|linkSync|copyFileSync|cpSync|\bln\b|\bcp\b/u.test(line) && !/opencode/iu.test(line)) offenders.push(`${name}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
