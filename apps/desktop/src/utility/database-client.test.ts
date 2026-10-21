// MODULE: database-client.test.ts - Real database-worker persistence and failure checks
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseWorkerClient } from './database-client'
import { DEFAULT_WORKSPACE_ID } from './store-schema'
import { captureRelevantLaunchEnvironment } from './conversation-binding'

const compiler = createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild') as {
  buildSync(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string }): void
}

const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('database worker failure', () => {
  it('79.3 keeps setup output policy through the real worker and a worker restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-setup-worker-'))
    roots.add(root)
    const repo = resolve(import.meta.dirname, '../../../..')
    symlinkSync(join(repo, 'apps/desktop/node_modules'), join(root, 'node_modules'), 'dir')
    const workerPath = join(root, 'database-worker.cjs')
    compiler.buildSync({ entryPoints: [join(repo, 'apps/desktop/src/utility/database-worker.ts')],
      outfile: workerPath, bundle: true, platform: 'node', format: 'cjs' })
    const path = join(root, 'state.sqlite')
    let client = new DatabaseWorkerClient(workerPath, path)
    const setup = { app: 'codex', action: 'login' } as const
    try {
      await client.initialize()
      await client.initializeSetup(false, root)
      const claims = await Promise.all([client.claimSetupDefaults(), client.claimSetupDefaults()])
      expect(claims.filter(claim => claim.initialize)).toHaveLength(1)
      expect(claims[0].setupId).toBe(claims[1].setupId)
      await client.createStarting({
        sessionId: 'synthetic-setup', incarnationId: 'synthetic-incarnation', workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Codex sign in', cwd: root, executable: '/usr/bin/codex', argv: ['login'],
        backgroundChoice: null, terminalGraphics: null, processStartIdentity: 'synthetic:1',
        startedAt: '2026-10-20T00:00:00.000Z', setup,
        binding: {
          sessionId: 'synthetic-setup', agentCli: 'codex', status: 'unsupported', captureRoute: 'unsupported',
          launchContext: { cwd: root, executable: '/usr/bin/codex', argv: ['login'], environment: captureRelevantLaunchEnvironment({}) },
          detail: 'Setup has no conversation capture', capturedAt: '2026-10-20T00:00:00.000Z'
        }
      })
      expect((await client.listSessions(DEFAULT_WORKSPACE_ID))[0]?.setup).toEqual(setup)
      await client.close()
      client = new DatabaseWorkerClient(workerPath, path)
      await client.initialize()
      expect(await client.claimSetupDefaults()).toEqual({ setupId: claims[0].setupId, initialize: false })
      expect((await client.listSessions(DEFAULT_WORKSPACE_ID))[0]).toMatchObject({ setup, lastProcess: { state: 'interrupted' } })
      expect(await client.updateSession({ sessionId: 'synthetic-setup', expectedRevision: 1, name: 'Renamed' }))
        .toMatchObject({ setup })
    } finally { await client.close() }
  })

  it('rejects future requests after the worker exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-database-client-'))
    roots.add(root)
    const workerPath = join(root, 'idle-worker.cjs')
    writeFileSync(workerPath, 'setInterval(() => undefined, 1000)\n')
    const client = new DatabaseWorkerClient(workerPath, join(root, 'state.sqlite3'))
    await client['worker'].terminate()

    const outcome = await Promise.race([
      client.listWorkspaces().then(
        () => ({ state: 'resolved' as const }),
        (error: unknown) => ({ state: 'rejected' as const, error })
      ),
      new Promise<{ state: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ state: 'pending' }), 100)
      )
    ])

    expect(outcome).toMatchObject({ state: 'rejected', error: expect.any(Error) })
  })
})
