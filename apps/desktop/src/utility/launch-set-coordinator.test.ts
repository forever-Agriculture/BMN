import { describe, expect, it, vi } from 'vitest'
import type { LaunchSetRecord, WorkspaceRecord } from '@bmn/protocol'
import { LaunchSetCoordinator } from './launch-set-coordinator'
import { HostControlError, PersistedSessionStartError } from './session-manager'
import { ERROR_CODES } from '@bmn/protocol'

function set(): LaunchSetRecord {
  return {
    setId: 'set-1', workspaceId: 'workspace-1', name: 'Morning', revision: 1,
    createdAt: '2026-09-24T10:00:00.000Z',
    entries: ['A', 'B', 'C'].map((name) => ({
      entryId: `entry-${name}`, name, executable: '/bin/true', argv: [name], backgroundChoice: null
    }))
  }
}

const workspace = {
  workspaceId: 'workspace-1', name: 'Project', defaultCwd: '/tmp', marker: 'none', position: 0,
  archivedAt: null, revision: 1
} satisfies WorkspaceRecord

const request = {
  workspaceId: 'workspace-1', setId: 'set-1', expectedRevision: 1,
  directory: '/tmp', idempotencyKey: 'action-1', cols: 80, rows: 24
}

describe('launch set coordinator', () => {
  it('validates every entry before any spawn and rejects a stale revision', async () => {
    const create = vi.fn(async () => ({ sessionId: 'never', incarnationId: 'never' }))
    const validate = vi.fn(async (params: { argv: readonly string[] }) => {
      if (params.argv[0] === 'C') throw new Error('invalid third command')
    })
    const definitions = set()
    const coordinator = new LaunchSetCoordinator({
      getSet: async () => definitions,
      listWorkspaces: async () => [workspace], validate, create
    })
    await expect(coordinator.start(request)).rejects.toThrow('invalid third command')
    expect(validate).toHaveBeenCalledTimes(3)
    expect(create).not.toHaveBeenCalled()
    await expect(coordinator.start({ ...request, idempotencyKey: 'action-2', expectedRevision: 2 }))
      .rejects.toThrow('changed')
    expect(create).not.toHaveBeenCalled()
  })

  it('joins repeated calls under one key, freezes entries and stops after the first failure', async () => {
    const definitions = set()
    const calls: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const coordinator = new LaunchSetCoordinator({
      getSet: async () => definitions,
      listWorkspaces: async () => [workspace],
      validate: async (params) => { calls.push(`validate:${params.argv[0]}`) },
      create: async (params) => {
        calls.push(`create:${params.argv[0]}`)
        if (params.argv[0] === 'A') await first
        if (params.argv[0] === 'B') throw new PersistedSessionStartError(
          'session-b', new HostControlError(ERROR_CODES.ioError, 'second process failed')
        )
        return { sessionId: 'session-a', incarnationId: 'run-a' }
      }
    })
    const started = coordinator.start(request)
    const retry = coordinator.start({ ...request, directory: '/different' })
    expect(retry).toBe(started)
    await vi.waitFor(() => expect(calls).toContain('create:A'))
    definitions.entries[1]!.argv[0] = 'mutated after acceptance'
    releaseFirst!()
    const result = await started
    expect(result.entries).toMatchObject([
      { entryId: 'entry-A', outcome: 'started', sessionId: 'session-a' },
      { entryId: 'entry-B', outcome: 'failed', sessionId: 'session-b', error: 'second process failed' },
      { entryId: 'entry-C', outcome: 'not-started' }
    ])
    expect(calls).toEqual([
      'validate:A', 'validate:B', 'validate:C', 'create:A', 'create:B'
    ])
    expect(await coordinator.start(request)).toBe(result)
  })
})
