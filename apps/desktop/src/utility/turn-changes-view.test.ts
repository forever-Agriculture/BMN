// MODULE: turn-changes-view.test.ts - a stored turn and a comparison's rows as the window lists them: every file state, what its note says, and the three fixed sentences for what cannot be shown
import { describe, expect, it } from 'vitest'
import type { TurnRow } from './database-turn-store'
import type { TurnFileRow } from './turn-changes-compare'
import { turnFileView, turnSummary, turnUnavailable } from './turn-changes-view'

const ROW: TurnRow = {
  turnId: 't-1', number: 3, sessionId: 's1', incarnationId: 'i-1', foreground: '1:200:20:1:2', app: 'codex', appVersion: '0.162.1',
  conversation: 'conversation-1', appTurnId: 'app-turn', namedFolder: '/synthetic/repo/sub', workTree: '/synthetic/repo', state: 'closed', endKind: 'finished',
  startedAt: '2026-10-13T11:05:02.000Z', endedAt: '2026-10-13T11:09:42.000Z', totalsState: 'partial', totals: { files: 11, added: 96, removed: 40 },
  wording: 'Partial: 3 files', labels: ['Two scans of /synthetic/repo'], before: 'c-1', after: 'c-2'
}

describe('a turn as the list shows it', () => {
  it('keeps its number, app, times, end, totals and wording, and nothing that names a folder, a capture or a conversation', () => {
    expect(turnSummary(ROW)).toEqual({
      turnId: 't-1', number: 3, app: 'codex', appVersion: '0.162.1', startedAt: ROW.startedAt, endedAt: ROW.endedAt, end: 'finished', state: 'closed',
      totalsState: 'partial', totals: { files: 11, added: 96, removed: 40 }, wording: 'Partial: 3 files'
    })
    expect(JSON.stringify(turnSummary(ROW))).not.toMatch(/synthetic|c-1|conversation|app-turn/)
    expect(turnSummary({ ...ROW, state: 'open', endKind: null, endedAt: null, totals: null, totalsState: 'none', wording: null }))
      .toMatchObject({ state: 'open', end: null, endedAt: null, totals: null, wording: null })
  })
})

describe('a file of a turn', () => {
  const file = (row: Partial<TurnFileRow> & Pick<TurnFileRow, 'state'>): TurnFileRow => ({ path: 'src/a.ts', ...row } as TurnFileRow)

  it.each([
    ['added', file({ state: 'added', added: 52, removed: 0 }), { added: 52, removed: 0, note: null, opens: true }],
    ['changed', file({ state: 'changed', added: 41, removed: 18 }), { added: 41, removed: 18, note: null, opens: true }],
    ['removed', file({ state: 'removed', added: 0, removed: 20 }), { added: 0, removed: 20, note: null, opens: true }],
    ['binary', file({ state: 'binary', sizeBefore: 18_637, sizeAfter: 22_221 }), { added: null, removed: null, note: null, opens: true }],
    ['mode only', file({ state: 'mode only', executable: true }), { added: null, removed: null, note: 'now executable', opens: false }],
    ['mode only', file({ state: 'mode only', executable: false }), { added: null, removed: null, note: 'no longer executable', opens: false }],
    ['changed kind', file({ state: 'changed kind', from: 'file', to: 'link' }), { added: null, removed: null, note: 'file to link', opens: false }],
    ['not read', file({ state: 'not read', why: 'too large, 14.2 MiB' }), { added: null, removed: null, note: 'too large, 14.2 MiB', opens: false }],
    ['entered what is covered', file({ state: 'entered what is covered' }), { added: null, removed: null, note: null, opens: false }],
    ['left what is covered', file({ state: 'left what is covered' }), { added: null, removed: null, note: null, opens: false }]
  ] as const)('%s', (state, row, shown) => {
    expect(turnFileView(row)).toEqual({ path: 'src/a.ts', state, ...shown })
  })

  it('says of a submodule or a nested repository only which commit it was moved from and to', () => {
    const from = 'a'.repeat(40)
    const to = 'b'.repeat(40)
    expect(turnFileView(file({ state: 'changed', kind: 'submodule', from, to } as Partial<TurnFileRow> & Pick<TurnFileRow, 'state'>)))
      .toEqual({ path: 'src/a.ts', state: 'changed', added: null, removed: null, note: `commit ${'a'.repeat(12)} to ${'b'.repeat(12)}`, opens: false })
  })
})

describe('why something cannot be shown', () => {
  it('is one of four fixed sentences, whatever the reason says', () => {
    expect(turnUnavailable('Difference unavailable: limit reached')).toBe('Difference unavailable: limit reached')
    expect(turnUnavailable('not read')).toBe('This file was not read')
    expect(turnUnavailable('cancelled')).toBe('BMN was scanning for a prompt; open it again')
    expect(turnUnavailable('ENOENT: /synthetic/store/MARKER')).toBe('The stored scans of this turn cannot be read')
    expect(turnUnavailable('')).toBe('The stored scans of this turn cannot be read')
  })
})
