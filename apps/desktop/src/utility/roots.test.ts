import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureApplicationRoots, resolveApplicationRoots } from './roots'

const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

describe('utility application roots', () => {
  it('honors every AITERM override without appending another directory', () => {
    const roots = resolveApplicationRoots(
      {
        AITERM_CONFIG_HOME: '/isolated/config',
        AITERM_DATA_HOME: '/isolated/data',
        AITERM_STATE_HOME: '/isolated/state',
        AITERM_RUNTIME_HOME: '/isolated/runtime'
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

  it('uses matching XDG roots and creates all resolved roots with mode 0700', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'aiterm-roots-test-'))
    createdRoots.add(testRoot)
    const roots = resolveApplicationRoots(
      {
        XDG_CONFIG_HOME: join(testRoot, 'xdg-config'),
        XDG_DATA_HOME: join(testRoot, 'xdg-data'),
        XDG_STATE_HOME: join(testRoot, 'xdg-state'),
        XDG_RUNTIME_DIR: join(testRoot, 'xdg-runtime')
      },
      { homeDirectory: '/owner', runtimeFallback: '/tmp/fallback' }
    )

    expect(roots.config).toBe(join(testRoot, 'xdg-config', 'ai-terminal'))
    await ensureApplicationRoots(roots)
    for (const root of Object.values(roots)) {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
    }
  })
})
