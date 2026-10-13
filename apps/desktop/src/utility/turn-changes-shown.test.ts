// MODULE: turn-changes-shown.test.ts - one file's difference as the window may read it: masks over original lines of all three kinds, a many-line key block, "Secret value changed", both display bounds and the cut of a long line, on made-up values
import { TURN_SECRET_PLATE, TURN_SHOWN_LIMITS, type TurnShownHunk, type TurnShownLine } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { DiffStopped, unified } from './turn-changes-diff'
import { SECRET_PLATE, SHOWN_LIMITS, showDifference } from './turn-changes-shown'

const show = (path: string, before: string, after: string, limits?: { lines: number; bytes: number; lineCharacters: number }): ReturnType<typeof showDifference> =>
  showDifference(path, before, after, unified(before, after), limits ? { limits } : {})
const lines = (hunk: TurnShownHunk | undefined): TurnShownLine[] => (hunk?.lines ?? []).filter((line): line is TurnShownLine => line.kind !== '\\')
const read = (hunk: TurnShownHunk | undefined): string[] => lines(hunk).map((line) => `${line.kind}${line.a ?? ''}/${line.b ?? ''} ${line.text}`)

describe('masks laid over the original lines', () => {
  const before = 'provider: stripe\nregion: eu\nwebhook_secret: whsec-old-value\napi_key: key-one-value\ntimeout_ms: 8000\n'
  const after = 'provider: stripe\nregion: eu\nwebhook_secret: whsec-old-value\napi_key: key-two-value\nretries: 3\ntimeout_ms: 8000\n'

  it('hides a value in added, removed and context lines alike, with the numbers and counts of the original texts', () => {
    const shown = show('config/payments.yaml', before, after)
    expect(shown).toMatchObject({ state: 'text', added: 2, removed: 1, more: 0 })
    expect(read(shown.hunks[0])).toEqual([
      ' 1/1 provider: stripe',
      ' 2/2 region: eu',
      ` 3/3 webhook_secret: ${TURN_SECRET_PLATE}`,
      `-4/ api_key: ${TURN_SECRET_PLATE}`,
      `+/4 api_key: ${TURN_SECRET_PLATE}`,
      '+/5 retries: 3',
      ' 5/6 timeout_ms: 8000'
    ])
    expect(shown.hunks[0]).toMatchObject({ aStart: 1, aLines: 5, bStart: 1, bLines: 6, secret: false })
    const masked = lines(shown.hunks[0])[3] as TurnShownLine
    expect(masked.text.slice(...(masked.masks[0] as [number, number]))).toBe(TURN_SECRET_PLATE)
    // Nothing that is sent holds a value.
    expect(JSON.stringify(shown)).not.toMatch(/whsec-old-value|key-one-value|key-two-value/)
  })

  it('says of a hunk whose only difference is a masked value that a secret value changed', () => {
    const shown = show('config/payments.yaml', 'a: 1\nsigning_key: old-key-value\nb: 2\n', 'a: 1\nsigning_key: new-key-value\nb: 2\n')
    expect(shown.hunks).toHaveLength(1)
    expect(shown.hunks[0]?.secret).toBe(true)
    expect(read(shown.hunks[0]).slice(1, 3)).toEqual([`-2/ signing_key: ${TURN_SECRET_PLATE}`, `+/2 signing_key: ${TURN_SECRET_PLATE}`])
    // A hunk in which something else changed too is an ordinary hunk.
    expect(show('config/payments.yaml', 'signing_key: old-key-value\nb: 2\n', 'signing_key: new-key-value\nb: 3\n').hunks[0]?.secret).toBe(false)
    // And one with nothing masked is one too.
    expect(show('notes.txt', 'a\n', 'b\n').hunks[0]?.secret).toBe(false)
  })

  it('keeps a key block of many lines as that many masked lines', () => {
    const block = ['-----BEGIN PRIVATE KEY-----', 'MADEUPLINEONE', 'MADEUPLINETWO', '-----END PRIVATE KEY-----']
    const shown = show('deploy/key.txt', 'top\n', `top\n${block.join('\n')}\nend\n`)
    expect(read(shown.hunks[0])).toEqual([' 1/1 top', ...block.map((_line, index) => `+/${index + 2} ${TURN_SECRET_PLATE}`), '+/6 end'])
    expect(shown).toMatchObject({ added: 5, removed: 0 })
    expect(JSON.stringify(shown)).not.toContain('MADEUPLINE')
  })

  it('goes by the file\'s name: a long run is a value in a config file and plain text elsewhere', () => {
    const run = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MTIzNDU2'
    expect(read(show('a.yaml', '', `sum: ${run}\n`).hunks[0])).toEqual([`+/1 sum: ${TURN_SECRET_PLATE}`])
    expect(read(show('a.md', '', `sum: ${run}\n`).hunks[0])).toEqual([`+/1 sum: ${run}`])
    expect(read(show('.env', '', 'PORT=5173\n').hunks[0])).toEqual([`+/1 PORT=${TURN_SECRET_PLATE}`])
  })
})

describe('the display bounds', () => {
  const many = (count: number): string => Array.from({ length: count }, (_value, index) => `line ${index + 1}\n`).join('')

  it('shows at most so many lines and counts the rest', () => {
    const shown = show('a.txt', '', many(12), { lines: 5, bytes: 1_000_000, lineCharacters: 2_000 })
    expect(lines(shown.hunks[0])).toHaveLength(5)
    expect(shown).toMatchObject({ added: 12, more: 7 })
  })

  it('counts the lines the comparison did not hold among those not shown', () => {
    const after = many(30)
    const shown = showDifference('a.txt', '', after, unified('', after, { keep: 11 }), { limits: { lines: 10, bytes: 1_000_000, lineCharacters: 2_000 } })
    expect(lines(shown.hunks[0])).toHaveLength(10)
    expect(shown).toMatchObject({ added: 30, more: 20 })
  })

  it('is stopped while it looks for secret values, before a line is laid out', () => {
    const after = 'name: value\n'.repeat(20_000)
    const difference = unified('', after)
    let asked = 0
    expect(() => showDifference('a.yaml', '', after, difference, { stop: () => (asked += 1) > 2 })).toThrow(DiffStopped)
    expect(asked).toBe(3)
  })

  it('shows at most so many bytes and counts the rest, over several hunks', () => {
    const before = many(40)
    const after = before.replace('line 3\n', 'line three\n').replace('line 30\n', 'line thirty\n')
    const whole = show('a.txt', before, after)
    expect(whole.hunks).toHaveLength(2)
    expect(whole.more).toBe(0)
    const total = whole.hunks.reduce((sum, hunk) => sum + lines(hunk).length, 0)
    const cut = show('a.txt', before, after, { lines: 5_000, bytes: 40, lineCharacters: 2_000 })
    const kept = cut.hunks.reduce((sum, hunk) => sum + lines(hunk).length, 0)
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(total)
    expect(cut.more).toBe(total - kept)
    expect(cut.hunks.at(-1)?.secret).toBe(false)
  })

  it('cuts a long line with a mark, and a value that crosses the cut stays hidden', () => {
    const long = `${'x'.repeat(30)} token=${'s'.repeat(40)}`
    const shown = show('a.txt', '', `${long}\nshort\n`, { lines: 10, bytes: 100_000, lineCharacters: 40 })
    const [first, second] = lines(shown.hunks[0])
    expect(first).toMatchObject({ cut: true, text: `${'x'.repeat(30)} token=${TURN_SECRET_PLATE}` })
    expect(second).toMatchObject({ cut: false, text: 'short', masks: [] })
    expect(JSON.stringify(shown)).not.toContain('sss')
  })

  it('never cuts through a character of two code units', () => {
    const shown = show('a.txt', '', `${'x'.repeat(9)}😀tail\n`, { lines: 10, bytes: 100_000, lineCharacters: 10 })
    expect(lines(shown.hunks[0])[0]).toMatchObject({ cut: true, text: 'x'.repeat(9) })
  })

  it('passes the mark for a last line without an ending, uncounted', () => {
    const shown = show('a.txt', 'a\n', 'a\nb')
    expect(shown.hunks[0]?.lines.at(-1)).toEqual({ kind: '\\' })
    expect(shown).toMatchObject({ added: 1, more: 0 })
  })

  it('keeps the worker thread\'s bounds and plate equal to the ones the window reads', () => {
    expect(SHOWN_LIMITS).toEqual(TURN_SHOWN_LIMITS)
    expect(SECRET_PLATE).toBe(TURN_SECRET_PLATE)
  })
})
