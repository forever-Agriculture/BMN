// MODULE: setup-defaults-routing.test.ts - Fresh-profile automatic entry points cannot fall through to legacy installs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installAgentsIpcHandlers } from './agents-ipc'
import { createSetupProfileReadiness } from './first-run-setup'

const script = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
let root: string, saved: typeof process.env
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-routing-')); saved = { ...process.env }
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR']) delete process.env[name]
  process.env.HOME = root; process.env.PATH = `${root}/bin:/usr/bin:/bin`; process.env.BMN_SHIPPED_SKILLS = join(root, 'shipped')
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, '.claude')); mkdirSync(join(root, 'shipped'))
  writeFileSync(join(root, 'shipped/manifest.json'), '{"skills":[]}')
  for (const [app, version] of [['claude', '2.1.303'], ['codex', '0.163.0']] as const) writeFileSync(join(root, 'bin', app),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${app} ${version}"; exit 0; fi\necho unexpected >> "$HOME/native-test-started"\nexit 64\n`, { mode: 0o755 })
})
afterEach(() => { process.env = saved; rmSync(root, { recursive: true, force: true }) })
function fixture(initialize = true) {
  const profile = createSetupProfileReadiness()
  if (initialize) profile.initialize('active')
  const refresh = vi.fn(async () => ['Setup defaults: waiting for approval'])
  const options: Parameters<typeof installAgentsIpcHandlers>[1] = {
    senderIsAllowed: () => true, cliScript: () => script, environment: () => ({ ...process.env }),
    get setupDefaults() { return profile.fresh ? refresh : undefined },
    autoTestKinds: ['tools', 'skills'], autoTestsLater: () => {}, doctorAtStart: false
  }
  const handle = installAgentsIpcHandlers({ handle: () => {} }, options)
  return { handle, refresh, profile, startup: () => profile.ready.then(() => handle.installsAtStart()) }
}

it('waits for the persisted fresh profile when handlers register before host initialization', async () => {
  const f = fixture(false)
  const startup = f.startup()
  await Promise.resolve()
  expect(f.refresh).not.toHaveBeenCalled()
  expect(existsSync(join(root, '.claude/settings.json'))).toBe(false)
  f.profile.initialize('active')
  await startup
  expect(f.refresh).toHaveBeenCalledOnce()
  expect(existsSync(join(root, '.claude/settings.json'))).toBe(false)
})

it('keeps the original startup installer for a persisted existing profile', async () => {
  const f = fixture(false)
  const startup = f.startup()
  f.profile.initialize('existing')
  await startup
  expect(f.refresh).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks).toBeDefined()
})

it('sends fresh-profile startup through setup defaults before any legacy hook or skills write', async () => {
  const f = fixture()
  await f.handle.installsAtStart()
  expect(f.refresh).toHaveBeenCalledOnce()
  expect(existsSync(join(root, '.claude/settings.json'))).toBe(false)
  expect(existsSync(join(root, '.claude/skills'))).toBe(false)
})

it('starts no automatic native capability test for a fresh profile before team approval', async () => {
  const f = fixture()
  await f.handle.autoTestsAtStart()
  expect(existsSync(join(root, 'native-test-started'))).toBe(false)
  const tries = join(root, '.config/bmn/agents/state/auto-tests.json')
  expect(existsSync(tries) ? readFileSync(tries, 'utf8') : '').not.toContain('"count":1')
})
