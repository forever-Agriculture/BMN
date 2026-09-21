// MODULE: decset-modes.test.ts - reading the program's private modes out of its own output
import { TRACKED_DECSET_MODES } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { DecsetModeTracker } from './decset-modes'

function feed(...chunks: string[]): DecsetModeTracker {
  const tracker = new DecsetModeTracker()
  const encoder = new TextEncoder()
  for (const chunk of chunks) tracker.read(encoder.encode(chunk))
  return tracker
}

describe('reading private modes from a program’s output', () => {
  it('starts with nothing, because a program that changed no mode leaves a fresh view right', () => {
    expect(feed('hello\r\n').modes()).toEqual([])
  })

  /** A TUI hides the cursor and stops wrapping; a rebuilt view that shows both is the bug. */
  it('follows a mode a fresh view has on and the program turned off', () => {
    expect(feed('\u001b[?25l\u001b[?7l').modes()).toEqual([7, 25])
    expect(feed('\u001b[?25l\u001b[?25h').modes()).toEqual([])
  })

  it('takes the modes a program sets, including several in one sequence', () => {
    expect(feed('\u001b[?2004h\u001b[?1000;1006h').modes()).toEqual([1000, 1006, 2004])
  })

  it('drops a mode the program turns off again', () => {
    expect(feed('\u001b[?1049h\u001b[?2004h\u001b[?1049l').modes()).toEqual([2004])
  })

  /** The host reads whatever the PTY hands it; a sequence may be split at any byte. */
  it('reads a sequence split across chunks', () => {
    expect(feed('\u001b', '[', '?', '10', '49', 'h').modes()).toEqual([1049])
    expect(feed('text\u001b[?20', '04h more').modes()).toEqual([2004])
  })

  it('reports the modes in one fixed order, whatever order they were set in', () => {
    const forwards = feed('\u001b[?1049h\u001b[?1006h\u001b[?1h').modes()
    const backwards = feed('\u001b[?1h\u001b[?1006h\u001b[?1049h').modes()
    expect(forwards).toEqual(backwards)
    expect(forwards).toEqual([1, 1006, 1049])
  })

  /** A terminal runs one mouse protocol at a time, so a switch replaces, never adds. */
  it('keeps one mouse protocol, the one the program switched to', () => {
    expect(feed('\u001b[?1003h\u001b[?1000h').modes()).toEqual([1000])
    expect(feed('\u001b[?1000h\u001b[?1003h').modes()).toEqual([1003])
  })

  /** xterm turns mouse reporting off whichever protocol is named in the reset. */
  it('turns mouse reporting off when any of its modes is reset', () => {
    expect(feed('\u001b[?1000h\u001b[?1003l').modes()).toEqual([])
    expect(feed('\u001b[?1002h\u001b[?1002l').modes()).toEqual([])
  })

  it('keeps one mouse encoding the same way, without touching the protocol', () => {
    expect(feed('\u001b[?1000h\u001b[?1005h\u001b[?1006h').modes()).toEqual([1000, 1006])
    expect(feed('\u001b[?1000h\u001b[?1006h\u001b[?1005l').modes()).toEqual([1000])
  })

  it('ignores private modes outside the tracked set', () => {
    expect(TRACKED_DECSET_MODES).not.toContain(47)
    expect(feed('\u001b[?47h\u001b[?12h\u001b[?2004h').modes()).toEqual([2004])
  })

  /** `CSI 4 h` is insert mode, not a private mode: a reader that confused the two would carry a lie. */
  it('ignores a non-private set that happens to end in h', () => {
    expect(feed('\u001b[4h\u001b[1000h').modes()).toEqual([])
  })

  it('skips an unrelated sequence and keeps reading after it', () => {
    expect(feed('\u001b[2J\u001b[38;2;10;20;30m\u001b[?1004h').modes()).toEqual([1004])
  })

  it('abandons a parameter list too long to be real, then recovers', () => {
    const absurd = `\u001b[?${'1;'.repeat(60)}1000h\u001b[?2004h`
    expect(feed(absurd).modes()).toEqual([2004])
  })

  it('treats a second escape as the start of a new sequence', () => {
    expect(feed('\u001b\u001b[?2004h').modes()).toEqual([2004])
    expect(feed('\u001b[?2004\u001b[?1006h').modes()).toEqual([1006])
  })

  /** A process that ended has no modes: nothing of its state may reach the next one's view. */
  it('forgets everything when the process exits, including what it turned off', () => {
    const tracker = feed('\u001b[?1049h\u001b[?2004h\u001b[?25l')
    tracker.clear()
    expect(tracker.modes()).toEqual([])
    tracker.read(new TextEncoder().encode('\u001b[?1006h'))
    expect(tracker.modes()).toEqual([1006])
  })
})
