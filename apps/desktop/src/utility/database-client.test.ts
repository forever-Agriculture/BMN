import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseWorkerClient } from './database-client'

const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('database worker failure', () => {
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
