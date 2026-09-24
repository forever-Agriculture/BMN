import { describe, expect, it } from 'vitest'
import type { RepositoryIdentity } from '@bmn/protocol'
import { createIdentityLookup, identityChanged, type IdentityLookupState } from './repository-identity'

function repository(directory: string, branch: string): RepositoryIdentity {
  return { state: 'repository', directory, root: directory, observedAt: '2026-09-24T10:00:00.000Z',
    head: { state: 'branch', name: branch }, linkedWorktree: false }
}

describe('repository identity requests', () => {
  it('drops a late answer for the previous directory and an older refresh', async () => {
    const pending: Array<(identity: RepositoryIdentity) => void> = []
    const published: IdentityLookupState[] = []
    const lookup = createIdentityLookup(
      () => new Promise((resolve) => pending.push(resolve)),
      (state) => published.push(state)
    )
    const old = lookup.start('/tmp/old')
    const changed = lookup.start('/tmp/new')
    pending[0]!(repository('/tmp/old', 'old'))
    expect(await old).toBeUndefined()
    pending[1]!(repository('/tmp/new', 'main'))
    expect(await changed).toMatchObject({ directory: '/tmp/new' })
    expect(published.at(-1)?.identity).toMatchObject({ directory: '/tmp/new' })

    const firstRefresh = lookup.start('/tmp/new')
    const secondRefresh = lookup.start('/tmp/new')
    pending[3]!(repository('/tmp/new', 'new'))
    await secondRefresh
    pending[2]!(repository('/tmp/new', 'old'))
    expect(await firstRefresh).toBeUndefined()
    expect(published.at(-1)?.identity).toMatchObject({ head: { name: 'new' } })
  })

  it('requires another review only when a known identity changes to another known identity', () => {
    const main = repository('/tmp/project', 'main')
    const feature = repository('/tmp/project', 'feature')
    expect(identityChanged(main, main)).toBe(false)
    expect(identityChanged(main, feature)).toBe(true)
    expect(identityChanged(main, { state: 'unavailable', directory: main.directory,
      observedAt: main.observedAt, reason: 'Git missing' })).toBe(false)
    expect(identityChanged({ state: 'not-repository', directory: main.directory,
      observedAt: main.observedAt }, main)).toBe(true)
  })
})
