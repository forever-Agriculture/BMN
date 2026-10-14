// MODULE: agents-opencode-go.test.ts - Story 70.4: whether OpenCode lists Luna on OpenCode Go, and the Go sign-in BMN copies into its OpenCode folder, against a stand-in OpenCode and, opt-in, the real one
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyOpenCodeGoSignIn, openCodeFolderProblem, openCodeGoSignedIn, openCodeListsLuna } from '../../bin/agents-opencode.mjs'

const FAKE_OPENCODE = fileURLToPath(new URL('./test-fixtures/agents/fake-opencode.mjs', import.meta.url))
/** Made-up keys: no service ever gave these out. */
const GO_KEY = 'sk-synthetic-go-key-70-4'
const OTHER_KEY = 'sk-synthetic-other-key-70-4'
const OWNER_SIGN_INS = [
  { id: 'cred_madeup_go', integrationID: 'opencode-go', label: 'OpenCode Go', active: true, value: { type: 'key', key: GO_KEY } },
  { id: 'cred_madeup_other', integrationID: 'anthropic', label: 'Anthropic', active: true, value: { type: 'key', key: OTHER_KEY } }
]

let home: string
let stubs: string
let base: string
let env: Record<string, string>

/** How the stand-in OpenCode behaves; see fake-opencode.mjs. Every call is logged. */
const opencode = (mode: Record<string, unknown> = {}): void => writeFileSync(join(stubs, 'opencode-mode.json'), JSON.stringify({ logsCalls: true, ...mode }))
const calls = (): Array<{ args: string[]; cwd: string; home: string; data: string | null; proxy: string | null; content: string | null; project: string | null }> =>
  existsSync(join(stubs, 'opencode-calls.log')) ? readFileSync(join(stubs, 'opencode-calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
const ownerFile = (): string => join(home, '.local/share/opencode/fake-sign-ins.json')
const folderSignIns = (): unknown => JSON.parse(readFileSync(join(base, 'data/opencode/fake-sign-ins.json'), 'utf8'))

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-opencode-go-')))
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  writeFileSync(join(stubs, 'opencode'), readFileSync(FAKE_OPENCODE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`))
  chmodSync(join(stubs, 'opencode'), 0o755)
  opencode()
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  base = join(home, '.config/bmn/agents/state/opencode')
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
  writeFileSync(ownerFile(), JSON.stringify(OWNER_SIGN_INS))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('whether OpenCode lists Luna on OpenCode Go (70.4 AC1)', () => {
  it('asks in an empty folder of its own, with a key that is not one and every request sent to a closed port, and removes the folder', async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('bmn-opencode-list-'))
    await expect(openCodeListsLuna({ environment: env })).resolves.toEqual({ listed: true })
    const call = calls()[0]!
    expect(call.args).toEqual(['models', '--standalone'])
    // Nothing of the owner's: not his home, not his data, not his project.
    expect(call.home.startsWith(join(tmpdir(), 'bmn-opencode-list-'))).toBe(true)
    expect(call.home.startsWith(home)).toBe(false)
    expect(call.cwd).toBe(call.home)
    expect(call.proxy).toBe('http://127.0.0.1:9')
    expect(call.project).toBe('1')
    expect(JSON.parse(call.content ?? '{}')).toEqual({ provider: { 'opencode-go': { options: { apiKey: 'bmn-listing-only-not-a-key' } } } })
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('bmn-opencode-list-'))).toEqual(before)
  })

  it('says no where OpenCode lists other Go models only, cannot list, or is not there', async () => {
    opencode({ noLuna: true })
    await expect(openCodeListsLuna({ environment: env })).resolves.toEqual({ listed: false })
    opencode({ modelsFails: true })
    await expect(openCodeListsLuna({ environment: env })).resolves.toEqual({ listed: false, reason: 'opencode models ended with 1' })
    await expect(openCodeListsLuna({ environment: { ...env, PATH: '/usr/bin:/bin' } })).resolves.toEqual({ listed: false, reason: 'OpenCode is not on this computer' })
  })
})

describe('the Go sign-in BMN copies into its OpenCode folder (70.4, the owner\'s card)', () => {
  it('takes OpenCode Go\'s sign-in alone from his OpenCode, says no key, and copies once', async () => {
    const owner = readFileSync(ownerFile(), 'utf8')
    await expect(openCodeGoSignedIn({ environment: env, base })).resolves.toEqual({ signedIn: false })
    const copied = await copyOpenCodeGoSignIn({ environment: env, base })
    expect(copied).toEqual({ ok: true, copied: true, message: 'BMN copied your OpenCode Go sign-in into its own OpenCode folder' })
    expect(folderSignIns()).toEqual([OWNER_SIGN_INS[0]])
    expect(readFileSync(ownerFile(), 'utf8')).toBe(owner)
    // The export ran in his folders from BMN's empty home, the import in BMN's folder; neither carries a key on its command line.
    const ran = calls()
    const exported = ran.filter((call) => call.args[1] === 'export')
    expect(exported.map((call) => call.home)).toEqual([join(base, 'home'), home, join(base, 'home')])
    expect(exported.every((call) => call.cwd === join(base, 'home') && call.project === '1')).toBe(true)
    expect(ran.find((call) => call.args[1] === 'import')).toMatchObject({ args: ['auth', 'import', '--standalone'], home: join(base, 'home'), data: join(base, 'data') })
    expect(JSON.stringify(ran)).not.toContain(GO_KEY)
    expect(openCodeFolderProblem(base)).toBeNull()
    await expect(openCodeGoSignedIn({ environment: env, base })).resolves.toEqual({ signedIn: true })
    // Once: a folder that holds it is left as it is.
    await expect(copyOpenCodeGoSignIn({ environment: env, base })).resolves.toEqual({ ok: true, copied: false, message: 'BMN\'s OpenCode folder already holds your OpenCode Go sign-in' })
    expect(folderSignIns()).toEqual([OWNER_SIGN_INS[0]])
  })

  it('copies nothing where he holds no Go sign-in, or one that is switched off', async () => {
    writeFileSync(ownerFile(), JSON.stringify([OWNER_SIGN_INS[1], { ...OWNER_SIGN_INS[0], active: false }]))
    await expect(copyOpenCodeGoSignIn({ environment: env, base })).resolves.toEqual({
      ok: false, copied: false, message: 'OpenCode holds no OpenCode Go sign-in on this computer: sign in with `opencode auth login`, then copy it again'
    })
    expect(existsSync(join(base, 'data/opencode/fake-sign-ins.json'))).toBe(false)
  })

  it.each([
    ['his sign-ins cannot be listed', { ownerExportFails: true }, 'OpenCode could not list your sign-ins (opencode auth export ended with 1), so nothing was copied'],
    ['his come in a form BMN does not read', { ownerExportOther: true }, 'OpenCode printed your sign-ins in a form BMN does not read, so nothing was copied'],
    ['BMN\'s folder cannot be asked', { exportFails: true }, 'opencode auth export ended with 1 in BMN\'s OpenCode folder, so nothing was copied'],
    ['BMN\'s folder answers in a form BMN does not read', { exportOther: true }, 'OpenCode printed its sign-ins in a form BMN does not read, so nothing was copied'],
    ['the import fails', { importFails: true }, 'OpenCode did not take the sign-in into BMN\'s folder (opencode auth import ended with 1)'],
    ['the import takes nothing', { importDrops: true }, 'BMN\'s OpenCode folder holds no OpenCode Go sign-in after the copy']
  ])('says so, with no key, where %s', async (_case, mode, message) => {
    opencode(mode)
    const result = await copyOpenCodeGoSignIn({ environment: env, base })
    expect(result).toEqual({ ok: false, copied: false, message })
    expect(JSON.stringify(result)).not.toContain(GO_KEY)
  })

  it('says OpenCode is missing, and copies nothing', async () => {
    await expect(copyOpenCodeGoSignIn({ environment: { ...env, PATH: '/usr/bin:/bin' }, base })).resolves.toEqual({ ok: false, copied: false, message: 'OpenCode is not on this computer, so nothing was copied' })
    await expect(openCodeGoSignedIn({ environment: { ...env, PATH: '/usr/bin:/bin' }, base })).resolves.toEqual({ signedIn: null, reason: 'OpenCode is not on this computer' })
  })
})

/** The real OpenCode on this computer, for the opt-in run below (BMN_OPENCODE_REAL=1). */
const REAL_OPENCODE = process.env.BMN_OPENCODE_REAL === '1' ? spawnSync('which', ['opencode'], { encoding: 'utf8' }).stdout.trim() : ''

describe.runIf(REAL_OPENCODE !== '')('the installed OpenCode, on throwaway folders (70.4, BMN_OPENCODE_REAL=1)', () => {
  it('lists Luna on Go with a key that is not one, and copies only the Go sign-in without running his plugin or MCP server or changing his data', async () => {
    const real = { HOME: home, PATH: `${join(REAL_OPENCODE, '..')}:/usr/bin:/bin` }
    const owner = { ...real, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache') }
    const side = join(home, 'side.jsonl')
    // An owner-like OpenCode: a plugin and an MCP server that write a line when they run, and two made-up sign-ins.
    mkdirSync(join(owner.XDG_CONFIG_HOME, 'opencode/plugin'), { recursive: true })
    writeFileSync(join(owner.XDG_CONFIG_HOME, 'opencode/plugin/marker.ts'),
      `import { appendFileSync } from "node:fs"\nexport default { id: "made-up.marker", async setup() { appendFileSync(${JSON.stringify(side)}, "plugin\\n") } }\n`)
    writeFileSync(join(home, 'mcp.mjs'), `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(side)}, "mcp\\n")\nsetTimeout(() => process.exit(0), 3000)\n`)
    writeFileSync(join(owner.XDG_CONFIG_HOME, 'opencode/opencode.json'), JSON.stringify({ mcp: { marker: { type: 'local', command: [process.execPath, join(home, 'mcp.mjs')], enabled: true } } }))
    mkdirSync(join(home, 'project'))
    const ownerEnv = { ...owner, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
    execFileSync('opencode', ['auth', 'import', '--standalone'], { cwd: join(home, 'project'), env: ownerEnv, input: JSON.stringify(OWNER_SIGN_INS), timeout: 60_000 })
    const database = join(owner.XDG_DATA_HOME, 'opencode/opencode.db')
    const held = readFileSync(database)
    rmSync(side, { force: true })

    await expect(openCodeListsLuna({ environment: real })).resolves.toEqual({ listed: true })
    await expect(copyOpenCodeGoSignIn({ environment: owner, base })).resolves.toMatchObject({ ok: true, copied: true })
    await expect(copyOpenCodeGoSignIn({ environment: owner, base })).resolves.toMatchObject({ ok: true, copied: false })

    expect(existsSync(side) ? readFileSync(side, 'utf8') : '').toBe('')
    expect(readFileSync(database).equals(held)).toBe(true)
    expect(openCodeFolderProblem(base)).toBeNull()
    const inFolder = JSON.parse(execFileSync('opencode', ['auth', 'export', '--standalone'], {
      cwd: join(base, 'home'), timeout: 60_000, encoding: 'utf8',
      env: { HOME: join(base, 'home'), PATH: real.PATH, XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }
    })) as Array<{ integrationID: string; value: { key: string } }>
    expect(inFolder.map((entry) => entry.integrationID)).toEqual(['opencode-go'])
    expect(inFolder[0]?.value.key).toBe(GO_KEY)
    // The control: the markers do run where OpenCode lists models in his own folders, which is why BMN never asks there.
    spawnSync('opencode', ['models', '--standalone'], { cwd: join(home, 'project'), env: ownerEnv, timeout: 60_000 })
    expect(readFileSync(side, 'utf8').trim().split('\n').sort()).toEqual(['mcp', 'plugin'])
  }, 180_000)
})
