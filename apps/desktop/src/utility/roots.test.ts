import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureApplicationRoots, resolveApplicationRoots } from './roots'

const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

async function testEnvironment(): Promise<{
  root: string
  environment: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-roots-test-'))
  createdRoots.add(root)
  return {
    root,
    environment: {
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_STATE_HOME: join(root, 'xdg-state'),
      XDG_RUNTIME_DIR: join(root, 'xdg-runtime')
    }
  }
}

describe('utility application roots', () => {
  it('honors every BMN override without appending another directory', () => {
    const roots = resolveApplicationRoots(
      {
        BMN_CONFIG_HOME: '/isolated/config',
        BMN_DATA_HOME: '/isolated/data',
        BMN_STATE_HOME: '/isolated/state',
        BMN_RUNTIME_HOME: '/isolated/runtime'
      },
      { homeDirectory: '/owner', runtimeFallback: '/tmp/fallback' }
    )

    expect(roots).toEqual({
      config: '/isolated/config',
      data: '/isolated/data',
      state: '/isolated/state',
      runtime: '/isolated/runtime'
    })
  })

  it('keeps legacy root overrides working while preferring the BMN names', () => {
    const roots = resolveApplicationRoots(
      {
        AITERM_DATA_HOME: '/legacy/data-override',
        BMN_CONFIG_HOME: '/current/config-override',
        AITERM_CONFIG_HOME: '/legacy/config-override'
      },
      { homeDirectory: '/owner', runtimeFallback: '/tmp/fallback' }
    )

    expect(roots.config).toBe('/current/config-override')
    expect(roots.data).toBe('/legacy/data-override')
  })

  it('uses BMN XDG roots for a fresh install and creates them with mode 0700', async () => {
    const { root, environment } = await testEnvironment()
    const roots = resolveApplicationRoots(environment, {
      homeDirectory: '/owner',
      runtimeFallback: '/tmp/fallback'
    })

    expect(roots).toEqual({
      config: join(root, 'xdg-config', 'bmn'),
      data: join(root, 'xdg-data', 'bmn'),
      state: join(root, 'xdg-state', 'bmn'),
      runtime: join(root, 'xdg-runtime', 'bmn')
    })
    await ensureApplicationRoots(roots)
    for (const applicationRoot of Object.values(roots)) {
      expect((await stat(applicationRoot)).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps existing persistent data in its legacy directories without moving it', async () => {
    const { root, environment } = await testEnvironment()
    const legacyRoots = {
      config: join(root, 'xdg-config', 'ai-terminal'),
      data: join(root, 'xdg-data', 'ai-terminal'),
      state: join(root, 'xdg-state', 'ai-terminal')
    }
    await Promise.all(Object.values(legacyRoots).map((legacyRoot) => mkdir(legacyRoot, { recursive: true })))
    await writeFile(join(legacyRoots.data, 'state.sqlite3'), '')

    const roots = resolveApplicationRoots(environment, {
      homeDirectory: '/owner',
      runtimeFallback: '/tmp/fallback'
    })

    expect(roots).toEqual({
      ...legacyRoots,
      runtime: join(root, 'xdg-runtime', 'bmn')
    })
  })

  it('keeps legacy data when desktop tooling has created BMN directories without a database', async () => {
    const { root, environment } = await testEnvironment()
    const legacyData = join(root, 'xdg-data', 'ai-terminal')
    await Promise.all([
      mkdir(legacyData, { recursive: true }),
      mkdir(join(root, 'xdg-state', 'ai-terminal'), { recursive: true }),
      mkdir(join(root, 'xdg-data', 'bmn'), { recursive: true }),
      mkdir(join(root, 'xdg-state', 'bmn', 'source-update'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(legacyData, 'state.sqlite3'), ''),
      writeFile(join(root, 'xdg-data', 'bmn', 'launch-bmn'), '')
    ])

    expect(resolveApplicationRoots(environment, {
      homeDirectory: '/owner',
      runtimeFallback: '/tmp/fallback'
    })).toEqual({
      config: join(root, 'xdg-config', 'ai-terminal'),
      data: legacyData,
      state: join(root, 'xdg-state', 'ai-terminal'),
      runtime: join(root, 'xdg-runtime', 'bmn')
    })
  })

  it('prefers the BMN roots when both current and legacy databases exist', async () => {
    const { root, environment } = await testEnvironment()
    await Promise.all([
      mkdir(join(root, 'xdg-data', 'ai-terminal'), { recursive: true }),
      mkdir(join(root, 'xdg-data', 'bmn'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(root, 'xdg-data', 'ai-terminal', 'state.sqlite3'), ''),
      writeFile(join(root, 'xdg-data', 'bmn', 'state.sqlite3'), '')
    ])

    expect(resolveApplicationRoots(environment, {
      homeDirectory: '/owner',
      runtimeFallback: '/tmp/fallback'
    }).data).toBe(join(root, 'xdg-data', 'bmn'))
  })
})
