import { describe, expect, it } from 'vitest'
import type { RepositoryIdentity, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { createCheckoutLookup, currentPeerInput, inspectCheckoutPeers, newlyDiscoveredCheckoutRisk } from './checkout-peers'

const at = '2026-09-29T10:00:00.000Z'
function repository(directory: string, root: string): RepositoryIdentity {
  return { state: 'repository', directory, root, observedAt: at,
    head: { state: 'branch', name: 'main' }, linkedWorktree: false }
}
function session(sessionId: string, workspaceId: string, cwd: string, archivedAt: string | null = null): SessionRecord {
  return { sessionId, workspaceId, cwd, name: `Session ${sessionId}`, executable: '/bin/bash', argv: [],
    position: 0, backgroundChoice: null, terminalGraphics: null, revision: 1, createdAt: at,
    archivedAt, lastProcess: null }
}
function workspace(workspaceId: string, archivedAt: string | null = null): WorkspaceRecord {
  return { workspaceId, name: `Workspace ${workspaceId}`, defaultCwd: null,
    position: 0, marker: 'none', archivedAt, revision: 1 }
}

describe('checkout peers from saved launch directories', () => {
  it('names live sessions across workspaces and deduplicates directories regardless of command', async () => {
    const calls: string[] = []
    const identities = new Map([
      ['/repo/new', repository('/repo/new', '/physical/repo')],
      ['/repo/other', repository('/repo/other', '/physical/repo')]
    ])
    const report = await inspectCheckoutPeers({
      directory: '/repo/new', sessions: [
        session('a', 'one', '/repo/other'), session('b', 'two', '/repo/other'),
        session('stopped', 'one', '/repo/other'), session('archived', 'one', '/repo/other', at),
        session('old-workspace', 'old', '/repo/other')
      ], workspaces: [workspace('one'), workspace('two'), workspace('old', at)],
      liveSessionIds: new Set(['a', 'b', 'archived', 'old-workspace'])
    }, async (path) => { calls.push(path); return identities.get(path)! })
    expect(calls).toEqual(['/repo/new', '/repo/other'])
    expect(report).toEqual({ outsideGit: false, incomplete: false, peers: [
      { sessionId: 'a', sessionName: 'Session a', workspaceName: 'Workspace one' },
      { sessionId: 'b', sessionName: 'Session b', workspaceName: 'Workspace two' }
    ] })
  })

  it('separates linked worktrees and nested repositories but matches physical symlink aliases', async () => {
    const roots = new Map([
      ['/alias/new', '/physical/repo'], ['/repo/peer', '/physical/repo'],
      ['/repo/linked', '/physical/linked'], ['/repo/nested', '/physical/repo/nested']
    ])
    const report = await inspectCheckoutPeers({
      directory: '/alias/new', sessions: [
        session('alias', 'one', '/repo/peer'), session('linked', 'one', '/repo/linked'),
        session('nested', 'one', '/repo/nested')
      ], workspaces: [workspace('one')], liveSessionIds: new Set(['alias', 'linked', 'nested'])
    }, async (path) => repository(path, roots.get(path)!))
    expect(report.peers.map((peer) => peer.sessionId)).toEqual(['alias'])
    expect(report.incomplete).toBe(false)
  })

  it('shows no checkout notice outside Git, and incomplete results for unreadable relevant paths', async () => {
    const input = { directory: '/plain', sessions: [session('live', 'one', '/missing')],
      workspaces: [workspace('one')], liveSessionIds: new Set(['live']) }
    const outside = await inspectCheckoutPeers(input, async (path) => path === '/plain'
      ? { state: 'not-repository', directory: path, observedAt: at }
      : { state: 'unavailable', directory: path, observedAt: at, reason: 'unreadable' })
    expect(outside).toEqual({ outsideGit: true, incomplete: false, peers: [] })
    const incomplete = await inspectCheckoutPeers({ ...input, directory: '/repo' }, async (path) =>
      path === '/repo' ? repository(path, path)
        : { state: 'unavailable', directory: path, observedAt: at, reason: 'unreadable' })
    expect(incomplete).toEqual({ outsideGit: false, incomplete: true, peers: [] })
  })

  it('bounds concurrent reads and marks uninspected peers incomplete', async () => {
    let active = 0
    let peak = 0
    const sessions = Array.from({ length: 40 }, (_, index) => session(String(index), 'one', `/peer/${index}`))
    const report = await inspectCheckoutPeers({ directory: '/selected', sessions,
      workspaces: [workspace('one')], liveSessionIds: new Set(sessions.map((item) => item.sessionId)) },
    async (path) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return repository(path, path)
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(report.incomplete).toBe(true)
    expect(report.peers).toEqual([])
  })

  it('drops a late response after a different preview and requires review for newly found peers', async () => {
    let release!: (identity: RepositoryIdentity) => void
    const states: Array<{ key: string; loading: boolean }> = []
    const lookup = createCheckoutLookup((path) => path === '/old'
      ? new Promise((resolve) => { release = resolve }) : Promise.resolve(repository(path, path)),
    (state) => states.push(state))
    const base = { sessions: [], workspaces: [], liveSessionIds: new Set<string>() }
    const old = lookup.start({ ...base, directory: '/old' }, 'old')
    const current = await lookup.start({ ...base, directory: '/new' }, 'new')
    release(repository('/old', '/old'))
    expect(await old).toBeUndefined()
    expect(current).toEqual({ outsideGit: false, incomplete: false, peers: [] })
    expect(states.at(-1)?.key).toBe('new')
    expect(newlyDiscoveredCheckoutRisk(current!, { ...current!, peers: [
      { sessionId: 'new-peer', sessionName: 'Session', workspaceName: 'Workspace' }
    ] })).toBe(true)
    expect(newlyDiscoveredCheckoutRisk(current!, { ...current!, incomplete: true })).toBe(true)
  })

  it('stops scheduling peer reads after cancellation and caps reads across superseded previews', async () => {
    let release!: (identity: RepositoryIdentity) => void
    const calls: string[] = []
    const peers = Array.from({ length: 8 }, (_, index) => session(String(index), 'one', `/peer/${index}`))
    const lookup = createCheckoutLookup((path) => {
      calls.push(path)
      return path === '/selected' ? new Promise((resolve) => { release = resolve })
        : Promise.resolve(repository(path, '/repo'))
    }, () => undefined)
    const obsolete = lookup.start({ directory: '/selected', sessions: peers,
      workspaces: [workspace('one')], liveSessionIds: new Set(peers.map((peer) => peer.sessionId)) }, 'old')
    lookup.cancel()
    release(repository('/selected', '/repo'))
    expect(await obsolete).toBeUndefined()
    expect(calls).toEqual(['/selected'])

    let active = 0
    let peak = 0
    const bounded = createCheckoutLookup(async (path) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return repository(path, path)
    }, () => undefined)
    const base = { sessions: [], workspaces: [], liveSessionIds: new Set<string>() }
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      bounded.start({ ...base, directory: `/selected/${index}` }, String(index))))
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('gets fresh live records from every workspace at Start and marks a failed read incomplete', async () => {
    const existing = session('existing', 'one', '/repo')
    const added = { ...session('added', 'two', '/repo'), lastProcess: {
      incarnationId: 'run', state: 'live' as const, exitCode: null, signal: null, detail: null
    } }
    const input = await currentPeerInput('/repo', {
      listWorkspaces: async () => [workspace('one'), workspace('two')],
      listSessions: async (id) => id === 'one' ? [existing] : [added]
    })
    expect(input.liveSessionIds).toEqual(new Set(['added']))
    const report = await inspectCheckoutPeers(input, async (path) => repository(path, '/repo'))
    expect(report.peers.map((peer) => peer.sessionId)).toEqual(['added'])
    const failed = await currentPeerInput('/repo', {
      listWorkspaces: async () => [workspace('one'), workspace('two')],
      listSessions: async (id) => id === 'one' ? [added] : Promise.reject(new Error('unavailable'))
    })
    expect(failed.incomplete).toBe(true)
  })
})
