import { describe, expect, it } from 'vitest'
import { filterCommands, matchingPaletteFileSearch, paletteFileSearchRootLabel, paletteSelectionIndex, type PaletteCommand, type PaletteFileSearchSnapshot } from './command-palette'

describe('literal before Commands-only subsequence search', () => {
  const row = (id: string, label: string, group: PaletteCommand['group'] = 'Commands', extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, label, group, run: () => {}, ...extra })
  const commands = [row('session', 'Go to next request needing you', 'Sessions'),
    row('fuzzy-a', 'Go to next request needing you'), row('literal', 'nxt req'), row('fuzzy-b', 'Next requests'),
    row('disabled', 'nxt req', 'Commands', { disabled: true }), row('file', 'Go to next request needing you', 'Files')]
  it('puts literals first, preserving ties and excluding fuzzy non-command rows', () => {
    expect(filterCommands(commands, 'nxt req').map(row => row.id)).toEqual(['literal', 'fuzzy-a', 'fuzzy-b'])
    expect(filterCommands(commands, ' NXT   REQ ').map(row => row.id)).toEqual(['literal', 'fuzzy-a', 'fuzzy-b'])
  })
  it('preserves ordinary literal context/group matches and the existing group order', () => {
    const list = [row('session', 'Alpha', 'Sessions', { context: 'workspace north' }), row('workspace', 'north', 'Workspaces'), row('command', 'Open north'), row('file', 'north', 'Files')]
    expect(filterCommands(list, 'north').map(row => row.id)).toEqual(['session', 'workspace', 'command', 'file'])
    expect(filterCommands(list, 'workspace north').map(row => row.id)).toEqual(['session', 'workspace'])
  })
  it('requires every fuzzy word in the label, without fuzzy context or groups', () => {
    expect(filterCommands([row('label', 'Go to next request'), row('context', 'Help', 'Commands', { context: 'next request' })], 'nxt req').map(row => row.id)).toEqual(['label'])
    expect(filterCommands(commands, 'nxt zzz')).toEqual([])
    expect(filterCommands(commands, '').map(row => row.id)).toEqual(['session', 'fuzzy-a', 'literal', 'fuzzy-b', 'file'])
  })
  it('preserves selected ID when async rows reorder and falls back when it disappears', () => {
    const chosen = row('chosen', 'Chosen'), before = [row('a', 'A'), chosen], after = [row('new', 'New'), ...before, row('file', 'Late file', 'Files')]
    expect(paletteSelectionIndex(before, 'chosen')).toBe(1)
    expect(paletteSelectionIndex(after, 'chosen')).toBe(2)
    expect(paletteSelectionIndex(after.filter(row => row.id !== 'chosen'), 'chosen')).toBe(0)
    expect(paletteSelectionIndex(after, null)).toBe(0)
    expect(paletteSelectionIndex([], 'chosen')).toBe(0)
  })
})

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

it('keeps a surviving highlight identity and uses the next remaining row after removal', () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, label: id, group: 'Sessions' as const, run: () => {} }))
  expect(paletteSelectionIndex(rows, 'b', 0)).toBe(1)
  expect(paletteSelectionIndex([rows[0]!, rows[2]!], 'b', 1)).toBe(1)
  expect(paletteSelectionIndex([], 'b', 1)).toBe(0)
})


it('full review preserves the next surviving identity after simultaneous highlight and preceding-row removal', () => {
  const row = (id: string): PaletteCommand => ({ id, label: id, group: 'Sessions', run: () => {} })
  const before = ['a', 'b', 'c', 'd'].map(row), after = before.slice(2)
  expect(paletteSelectionIndex(after, 'b', 1, before.map(row => row.id))).toBe(0)
})
