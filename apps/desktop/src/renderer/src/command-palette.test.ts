import { describe, expect, it } from 'vitest'
import { matchingPaletteFileSearch, paletteFileSearchRootLabel, type PaletteFileSearchSnapshot } from './command-palette'

describe('palette file search result address', () => {
  it('hides results immediately when the selected session changes directory', () => {
    const snapshot: PaletteFileSearchSnapshot = {
      query: 'report', workspaceId: 'workspace', sessionId: 'session', rootLabel: '/first',
      value: {
        root: '/first', scanned: 1, capped: false, unavailable: false, cancelled: false,
        files: [{ name: 'report.ts', directory: '/first', path: '/first/report.ts' }]
      }
    }
    expect(matchingPaletteFileSearch(snapshot, {
      query: 'report', workspaceId: 'workspace', sessionId: 'session', rootLabel: '/first'
    })).toBe(snapshot.value)
    expect(matchingPaletteFileSearch(snapshot, {
      query: 'report', workspaceId: 'workspace', sessionId: 'session', rootLabel: '/second'
    })).toBeNull()
  })

  it('uses stored cwd after a retained terminal exits, invalidating completed and pending searches', () => {
    const startup = { cwd: '/old', incarnationId: 'incarnation' }
    const oldSession = {
      cwd: '/new', lastProcess: { incarnationId: 'incarnation', state: 'live' as const,
        exitCode: null, signal: null, detail: null }
    }
    expect(paletteFileSearchRootLabel(oldSession, startup)).toBe('/old')
    const exitedSession = { ...oldSession, lastProcess: { ...oldSession.lastProcess, state: 'exited' as const } }
    const nextRoot = paletteFileSearchRootLabel(exitedSession, startup)
    expect(nextRoot).toBe('/new')
    const oldResult: PaletteFileSearchSnapshot = {
      query: 'report', workspaceId: 'workspace', sessionId: 'session', rootLabel: '/old',
      value: { root: '/old', files: [{ name: 'report.ts', path: '/old/report.ts', directory: '/old' }],
        scanned: 1, capped: false, unavailable: false, cancelled: false }
    }
    expect(matchingPaletteFileSearch(oldResult, {
      query: 'report', workspaceId: 'workspace', sessionId: 'session', rootLabel: nextRoot
    })).toBeNull()
  })
})
