// MODULE: turn-changes-presentation.test.ts - the words of turn changes: the header plate in both widths for every wording and every state of recording, a turn's time and end, sizes and ranges
import { TURN_PAUSE_REASONS, TURN_WORDINGS, type TurnSessionView, type TurnSummary } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  turnAppName, turnBinarySizes, turnEndWord, turnFileLines, turnHeading, turnHunkRange, turnLabelShown, turnLineNumber, turnMoreWords, turnPlate,
  turnRecordingWords, turnResult, turnSentence, turnSize, turnTotalsText, turnWhen
} from './turn-changes-presentation'

/** Local times, so that the words do not depend on the zone the test runs in. */
const at = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute, 2).toISOString()
const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime()

function turn(change: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turnId: 't-1', number: 4, app: 'claude', appVersion: '2.1.296', startedAt: at(13, 14, 32), endedAt: at(13, 14, 36), end: 'finished', state: 'closed',
    totalsState: 'complete', totals: { files: 4, added: 120, removed: 33 }, wording: null, ...change
  }
}
const noTotals = (wording: string, change: Partial<TurnSummary> = {}): TurnSummary => turn({ totals: null, totalsState: 'none', wording, ...change })
function view(change: Partial<TurnSessionView> = {}): TurnSessionView {
  return { sessionId: 's1', state: 'recording', app: 'claude', pausedRoot: null, pauseReason: null, latest: turn(), removalPending: false, ...change }
}
const full = (given: TurnSessionView): string => (turnPlate(given, NOW)?.full ?? []).map((part) => part.tone === 'text' ? part.text : `[${part.tone}:${part.text}]`).join('')
const short = (given: TurnSessionView): string => {
  const part = turnPlate(given, NOW)?.short
  return part === undefined ? '' : part.tone === 'text' ? part.text : `[${part.tone}:${part.text}]`
}

describe('the header plate of the latest turn', () => {
  it('reads the totals in a wide pane and the file count in a narrower one, with no gold', () => {
    expect(full(view())).toBe('4 files +120[muted: −33]')
    expect(short(view())).toBe('4 files')
    expect(turnPlate(view(), NOW)?.title).toBe('Turn changes: the latest turn, 14:32. 4 files +120 −33')
    expect(full(view({ latest: turn({ totals: { files: 1, added: 0, removed: 0 } }) }))).toBe('1 file +0[muted: −0]')
    expect(short(view({ latest: turn({ totals: { files: 0, added: 0, removed: 0 } }) }))).toBe('0 files')
  })

  it('marks totals that are partial or not complete in gold, and says the wording in its tooltip', () => {
    const partial = view({ latest: turn({ totalsState: 'partial', totals: { files: 11, added: 96, removed: 40 }, wording: TURN_WORDINGS.partial(3) }) })
    expect(full(partial)).toBe('11 files +96[muted: −40][caveat: partial]')
    expect(short(partial)).toBe('[caveat:Partial]')
    expect(turnPlate(partial, NOW)?.title).toBe('Turn changes: the latest turn, 14:32. 11 files +96 −40. Partial: 3 files')

    const unverified = view({ latest: turn({ totalsState: 'not-complete', totals: { files: 6, added: 58, removed: 7 }, wording: TURN_WORDINGS.orderingUnverified('Claude Code', '2.1.300') }) })
    expect(full(unverified)).toBe('6 files +58[muted: −7][caveat: not complete]')
    expect(short(unverified)).toBe('[caveat:Not complete]')
    expect(turnPlate(unverified, NOW)?.title).toContain('Ordering unverified on Claude Code 2.1.300; early writes may be missed')
  })

  it.each([
    [TURN_WORDINGS.beforeUnavailable(), 'Before snapshot unavailable'],
    [TURN_WORDINGS.finalScanUnavailable(), 'End not observed'],
    [TURN_WORDINGS.overlapped(), 'Comparison unavailable'],
    [TURN_WORDINGS.incomplete('100 MiB read'), 'Incomplete'],
    [TURN_WORDINGS.notSupported('a sparse checkout'), 'Not supported here'],
    [TURN_WORDINGS.limitReached(), 'Difference unavailable'],
    [TURN_WORDINGS.switchedOff(), 'Recording was switched off']
  ])('reads a turn without totals as its wording\'s first words, and as "No totals" in a narrower pane: %s', (wording, head) => {
    const given = view({ latest: noTotals(wording) })
    expect(full(given)).toBe(`[caveat:${head}]`)
    expect(short(given)).toBe('[caveat:No totals]')
    expect(turnPlate(given, NOW)?.title).toBe(`Turn changes: the latest turn, 14:32. ${wording}`)
  })

  it('says a turn is running instead of showing the numbers of the one before', () => {
    const running = view({ latest: turn({ state: 'open', end: null, endedAt: null, totals: null, totalsState: 'none' }) })
    expect(full(running)).toBe('[muted:Turn running]')
    expect(short(running)).toBe('[muted:Running]')
  })

  it('puts the state of recording first and shrinks the earlier turn to its file count, so an old number is not read as the latest', () => {
    expect(full(view({ state: 'off', app: null }))).toBe('Recording off[muted: · 4 files]')
    expect(short(view({ state: 'off', app: null }))).toBe('Recording off')
    expect(full(view({ state: 'paused', pausedRoot: '/synthetic/repo', pauseReason: 'failed' }))).toBe('Paused[muted: · 4 files]')
    expect(short(view({ state: 'paused', pausedRoot: '/synthetic/repo', pauseReason: 'failed' }))).toBe('Paused')
    expect(full(view({ state: 'not-supported', app: 'opencode' }))).toBe('Not supported for OpenCode[muted: · 4 files]')
    expect(short(view({ state: 'not-supported', app: 'opencode' }))).toBe('Not supported')
    // No gold beside a state, whatever the earlier turn was.
    const earlier = view({ state: 'off', latest: noTotals(TURN_WORDINGS.beforeUnavailable()) })
    expect(full(earlier)).toBe('Recording off')
    expect(turnPlate(earlier, NOW)?.title).toBe('Turn changes: Recording off. The latest kept turn, 14:32: Before snapshot unavailable')
    expect(turnPlate(view({ state: 'paused', pauseReason: 'failed' }), NOW)?.title)
      .toBe(`Turn changes: Paused: ${TURN_PAUSE_REASONS.failed}. The latest kept turn, 14:32: 4 files +120 −33`)
  })

  it('is not there without a kept turn, except to say that recording is paused', () => {
    expect(turnPlate(view({ latest: null }), NOW)).toBeNull()
    expect(turnPlate(view({ latest: null, state: 'off' }), NOW)).toBeNull()
    expect(turnPlate(view({ latest: null, state: 'not-supported', app: 'opencode' }), NOW)).toBeNull()
    expect(full(view({ latest: null, state: 'paused', pauseReason: 'mixed' }))).toBe('Paused')
    expect(turnPlate(view({ latest: null, state: 'paused', pauseReason: 'mixed' }), NOW)?.title).toBe(`Turn changes: Paused: ${TURN_PAUSE_REASONS.mixed}`)
  })
})

describe('the state of recording', () => {
  it('is one of four lines', () => {
    expect(turnRecordingWords(view())).toBe('Recording on')
    expect(turnRecordingWords(view({ state: 'off' }))).toBe('Recording off')
    expect(turnRecordingWords(null)).toBe('Recording off')
    expect(turnRecordingWords(view({ state: 'paused' }))).toBe('Paused')
    expect(turnRecordingWords(view({ state: 'not-supported', app: 'opencode' }))).toBe('Not supported for OpenCode')
    expect(turnRecordingWords(view({ state: 'not-supported', app: 'my-agent' }))).toBe('Not supported for my-agent')
  })
})

describe('a turn\'s words', () => {
  it('says the time alone for a turn of today and the day with it for an earlier one', () => {
    expect(turnWhen(at(13, 9, 5), NOW)).toBe('09:05')
    expect(turnWhen(at(12, 18, 4), NOW)).toBe('12 Oct 18:04')
    expect(turnWhen('not a time', NOW)).toBe('--:--')
  })

  it('names each end, and none for a turn whose wording already says recording was switched off', () => {
    expect(turnEndWord(turn())).toBe('Finished')
    expect(turnEndWord(turn({ end: 'error' }))).toBe('Error')
    expect(turnEndWord(turn({ end: 'interrupted' }))).toBe('Interrupted')
    expect(turnEndWord(turn({ end: 'not-observed' }))).toBe('End not observed')
    expect(turnEndWord(turn({ end: 'switched-off' }))).toBe('')
    expect(turnEndWord(turn({ state: 'open', end: null }))).toBe('Running')
  })

  it('heads an opened turn with its time, its app with the version it ran on, and its end', () => {
    expect(turnHeading(turn({ app: 'codex', appVersion: '0.162.1', startedAt: at(13, 14, 5) }), NOW)).toBe('14:05 · Codex 0.162.1 · Finished')
    expect(turnHeading(turn({ appVersion: null, end: 'switched-off' }), NOW)).toBe('14:32 · Claude Code')
    expect(turnAppName('claude')).toBe('Claude Code')
  })

  it('gives totals with their mark, or the wording that says why there are none', () => {
    expect(turnResult(turn())).toEqual({ totals: { files: '4 files', added: '+120', removed: '−33' }, mark: null, wording: null })
    expect(turnResult(turn({ totalsState: 'partial', wording: 'Partial: 3 files' }))).toMatchObject({ mark: 'partial', wording: 'Partial: 3 files' })
    expect(turnResult(turn({ totalsState: 'not-complete', wording: 'Ordering unverified on Codex 0.170.0; early writes may be missed' }))).toMatchObject({ mark: 'not complete' })
    expect(turnResult(noTotals('Incomplete: 100 MiB read'))).toEqual({ totals: null, mark: null, wording: 'Incomplete: 100 MiB read' })
    expect(turnTotalsText({ files: 1_204, added: 3_110, removed: 2_102 })).toBe('1,204 files +3,110 −2,102')
    expect(turnSentence(turn({ state: 'open', end: null }))).toBe('Running')
  })
})

describe('a difference\'s words', () => {
  it('writes a hunk\'s place, a line\'s number and what was not shown', () => {
    expect(turnHunkRange({ aStart: 12, aLines: 7, bStart: 12, bLines: 8 })).toBe('@@ −12,7 +12,8 @@')
    expect(turnLineNumber(4_317)).toBe('4,317')
    expect(turnLineNumber(null)).toBe('')
    expect(turnMoreWords(0)).toBeNull()
    expect(turnMoreWords(212)).toBe('212 more lines not shown')
    expect(turnMoreWords(1)).toBe('1 more line not shown')
    expect(turnMoreWords(null)).toBe('More lines not shown')
  })

  it('writes a binary file\'s two sizes in the units the wordings use', () => {
    expect(turnBinarySizes(18_637, 22_221)).toBe('18.2 KiB before, 21.7 KiB after')
    expect(turnBinarySizes(null, 512)).toBe('not there before, 512 B after')
    expect(turnSize(14.2 * 1024 * 1024)).toBe('14.2 MiB')
  })

  it('writes the lines a file gained and lost, and nothing where nothing was counted', () => {
    expect(turnFileLines({ added: 52, removed: 0 })).toEqual({ added: '+52', removed: '' })
    expect(turnFileLines({ added: 3_110, removed: 2_102 })).toEqual({ added: '+3,110', removed: '−2,102' })
    expect(turnFileLines({ added: null, removed: null })).toBeNull()
  })

  it('shows the label of the two scans with the work tree as the sentence names it and one day\'s moments as times', () => {
    const rest = 'Files in a scan were read at different moments, and other programs\' changes may be included'
    const kept = `Two scans of /home/made-up/code/shop-api, the first from 2026-10-14 14:05:02 to 2026-10-14 14:05:02, the second from 2026-10-14 14:09:41 to 2026-10-14 14:09:42. ${rest}`
    expect(turnLabelShown(kept, '/home/made-up/code/shop-api', '~/code/shop-api'))
      .toBe(`Two scans of ~/code/shop-api, the first from 14:05:02 to 14:05:02, the second from 14:09:41 to 14:09:42. ${rest}`)
    // A turn across midnight keeps its days; a work tree that is not known here keeps its path.
    const night = kept.replace('2026-10-14 14:05:02 to 2026-10-14 14:05:02', '2026-10-13 23:59:58 to 2026-10-13 23:59:59')
    expect(turnLabelShown(night, '/home/made-up/code/shop-api', '~/code/shop-api')).toBe(night.replace('/home/made-up/code/shop-api', '~/code/shop-api'))
    expect(turnLabelShown(night, null, null)).toBe(night)
    expect(turnLabelShown(night, '/home/made-up/code/shop', '~/code/shop')).toBe(night)
    // Every other label is shown as it is kept, a date in it included.
    expect(turnLabelShown('Anything written after the second scan ended is not included', '/home/made-up/code/shop-api', '~/code/shop-api'))
      .toBe('Anything written after the second scan ended is not included')
    expect(turnLabelShown('Covered: 2026-10-14 14:05:02', '/x', '~/x')).toBe('Covered: 2026-10-14 14:05:02')
  })
})
