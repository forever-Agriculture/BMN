// MODULE: turn-changes-diff.test.ts - the line comparison against a brute-force longest common subsequence, against known texts and a plain layout of every row, and its stop in every long step
import { describe, expect, it } from 'vitest'
import { DiffStopped, countLines, decodeText, diffLines, splitLines, unified, type Hunk, type HunkLine, type SplitText } from './turn-changes-diff'

/** Length of the longest common subsequence, the slow and obvious way. */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] as number)
      diagonal = above
    }
  }
  return row[b.length] as number
}

let seed = 69
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const text = (count: number, alphabet: number): string =>
  Array.from({ length: count }, () => `line ${Math.floor(random() * alphabet)}`).join('\n') + (count > 0 && random() < 0.7 ? '\n' : '')
const keys = (split: SplitText): string[] => split.lines.map((line, index) => (split.open && index === split.lines.length - 1 ? `${line}\n` : line))

/** The hunks laid out the plain way: one row per line of both texts, then cut into hunks. What `unified` must give without holding those rows. */
function plainHunks(before: string, after: string, context: number): Hunk[] {
  const { a, b, removed, added } = diffLines(before, after)
  const rows: Array<{ kind: ' ' | '-' | '+'; a: number | null; b: number | null; text: string; open: boolean; i: number; j: number }> = []
  let i = 0
  let j = 0
  while (i < a.lines.length || j < b.lines.length) {
    if (i < a.lines.length && removed[i] === 1) {
      rows.push({ kind: '-', a: i + 1, b: null, text: a.lines[i] as string, open: a.open && i === a.lines.length - 1, i, j })
      i += 1
    } else if (j < b.lines.length && added[j] === 1) {
      rows.push({ kind: '+', a: null, b: j + 1, text: b.lines[j] as string, open: b.open && j === b.lines.length - 1, i, j })
      j += 1
    } else {
      rows.push({ kind: ' ', a: i + 1, b: j + 1, text: a.lines[i] as string, open: a.open && i === a.lines.length - 1, i, j })
      i += 1
      j += 1
    }
  }
  const hunks: Hunk[] = []
  let index = 0
  while (index < rows.length) {
    if (rows[index]?.kind === ' ') {
      index += 1
      continue
    }
    const start = Math.max(0, index - context)
    let end = index + 1
    for (let scan = index + 1; scan < rows.length; scan += 1) {
      if (rows[scan]?.kind !== ' ') {
        end = scan + 1
        continue
      }
      if (scan - end + 1 > context * 2) break
    }
    const stopAt = Math.min(rows.length, end + context)
    const slice = rows.slice(start, stopAt)
    const first = slice[0] as (typeof rows)[number]
    const lines: HunkLine[] = []
    let aLines = 0
    let bLines = 0
    for (const row of slice) {
      if (row.kind !== '+') aLines += 1
      if (row.kind !== '-') bLines += 1
      lines.push({ kind: row.kind, a: row.a, b: row.b, text: row.text })
      if (row.open) lines.push({ kind: '\\' })
    }
    hunks.push({ aStart: first.i + (aLines > 0 ? 1 : 0), aLines, bStart: first.j + (bLines > 0 ? 1 : 0), bLines, lines })
    index = stopAt
  }
  return hunks
}

describe('the lines of two texts', () => {
  it('splits and counts the lines of a text the same way', () => {
    for (const sample of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n', 'a\n\nb']) {
      const expected = sample === '' ? [] : sample.split('\n')
      const open = expected.length > 0 && expected.at(-1) !== ''
      if (!open) expected.pop()
      expect(splitLines(sample), JSON.stringify(sample)).toEqual({ lines: expected, open })
      expect(countLines(sample), JSON.stringify(sample)).toBe(expected.length)
    }
  })

  it('lays out the same hunks as one row per line would, for every context', () => {
    for (let round = 0; round < 3000; round += 1) {
      const before = text(Math.floor(random() * 60), 4 + Math.floor(random() * 30))
      const after = random() < 0.2 ? before : text(Math.floor(random() * 60), 4 + Math.floor(random() * 30))
      const context = Math.floor(random() * 4)
      expect(unified(before, after, { context }).hunks, JSON.stringify([before, after, context])).toEqual(plainHunks(before, after, context))
    }
    const long = Array.from({ length: 400 }, (_value, n) => `row ${n}`)
    const edited = long.map((line, n) => ([3, 9, 10, 17, 200, 399].includes(n) ? `${line}!` : line))
    for (const context of [0, 1, 3]) {
      expect(unified(`${long.join('\n')}\n`, `${edited.join('\n')}`, { context }).hunks).toEqual(plainHunks(`${long.join('\n')}\n`, `${edited.join('\n')}`, context))
    }
  })

  it('keeps a longest common subsequence of random texts', () => {
    for (let round = 0; round < 4000; round += 1) {
      const before = text(Math.floor(random() * 14), 1 + Math.floor(random() * 5))
      const after = text(Math.floor(random() * 14), 1 + Math.floor(random() * 5))
      const result = diffLines(before, after)
      const a = keys(result.a)
      const b = keys(result.b)
      const keptA = a.filter((_, index) => result.removed[index] === 0)
      const keptB = b.filter((_, index) => result.added[index] === 0)
      expect(keptA, JSON.stringify([before, after])).toEqual(keptB)
      expect(keptA.length, JSON.stringify([before, after])).toBe(lcs(a, b))
      expect([result.removedCount, result.addedCount]).toEqual([a.length - keptA.length, b.length - keptB.length])
    }
  })

  it('gives a unified difference that turns the first text into the second', () => {
    for (let round = 0; round < 2000; round += 1) {
      const before = text(Math.floor(random() * 40), 6)
      const after = text(Math.floor(random() * 40), 6)
      const context = Math.floor(random() * 4)
      const patch = unified(before, after, { context })
      const a = splitLines(before)
      const out: string[] = []
      let cursor = 0
      let openEnd = false
      for (const hunk of patch.hunks) {
        const startIndex = hunk.aLines > 0 ? hunk.aStart - 1 : hunk.aStart
        while (cursor < startIndex) {
          out.push(a.lines[cursor] as string)
          cursor += 1
        }
        let last: string | null = null
        for (const line of hunk.lines) {
          if (line.kind === '\\') {
            if (last === '+' || last === ' ') openEnd = true
            continue
          }
          if (line.kind === ' ' || line.kind === '-') {
            expect(a.lines[cursor]).toBe(line.text)
            cursor += 1
          }
          if (line.kind !== '-') {
            out.push(line.text)
            openEnd = false
          }
          last = line.kind
        }
        expect(hunk.lines.filter((line) => line.kind === ' ' || line.kind === '-').length).toBe(hunk.aLines)
        expect(hunk.lines.filter((line) => line.kind === ' ' || line.kind === '+').length).toBe(hunk.bLines)
      }
      const tailFromA = cursor < a.lines.length
      while (cursor < a.lines.length) {
        out.push(a.lines[cursor] as string)
        cursor += 1
      }
      if (tailFromA) openEnd = a.open
      expect(out.length === 0 ? '' : out.join('\n') + (openEnd ? '' : '\n'), JSON.stringify([before, after, context])).toBe(after)
      const counted = patch.hunks.flatMap((hunk) => hunk.lines)
      expect([counted.filter((line) => line.kind === '+').length, counted.filter((line) => line.kind === '-').length]).toEqual([patch.added, patch.removed])
    }
  })

  it('reads known texts', () => {
    const known = unified('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n')
    expect(known).toMatchObject({ added: 2, removed: 1, hunks: [{ aStart: 1, aLines: 3, bStart: 1, bLines: 4 }] })
    expect(unified('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0, hunks: [] })
    expect(unified('', 'x\ny\n')).toMatchObject({ added: 2, hunks: [{ aStart: 0, aLines: 0, bStart: 1 }] })
    const lines = (changed: number[]): string => `${Array.from({ length: 30 }, (_, n) => (changed.includes(n) ? `L${n}` : `l${n}`)).join('\n')}\n`
    expect(unified(lines([]), lines([2, 20])).hunks.map((hunk) => [hunk.aStart, hunk.aLines])).toEqual([[1, 6], [18, 7]])
  })

  it('shows a missing last line ending as a marked line that counts as no line', () => {
    const open = unified('a\nb', 'a\nb\n')
    expect([open.added, open.removed]).toEqual([1, 1])
    expect(open.hunks[0]?.lines.map((line) => line.kind)).toEqual([' ', '-', '\\', '+'])
    expect(unified('', 'n1\nn2').hunks[0]?.lines.map((line) => line.kind)).toEqual(['+', '+', '\\'])
  })

  it('takes valid UTF-8 without a NUL byte for text and everything else for binary', () => {
    expect(decodeText(Buffer.from('héllo\n'))).toBe('héllo\n')
    expect(decodeText(Buffer.from([104, 0, 105]))).toBeNull()
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull()
  })

  it('stops when told to, and inside a time limit', () => {
    const long = (prefix: string): string => `${Array.from({ length: 60000 }, (_, n) => `${prefix}${n}`).join('\n')}\n`
    expect(() => diffLines(long('a'), long('b'), () => true)).toThrow(DiffStopped)
    const began = Date.now()
    expect(() => diffLines(long('a'), long('b'), () => Date.now() - began > 150)).toThrow(DiffStopped)
    expect(Date.now() - began).toBeLessThan(250)
  })

  it('stops a text that is all new, all gone or unchanged, where no line is compared', () => {
    const many = 'line\n'.repeat(50_000)
    for (const [before, after] of [['', many], [many, ''], [many, many]] as const) {
      expect(() => diffLines(before, after, () => true)).toThrow(DiffStopped)
      expect(() => unified(before, after, { stop: () => true })).toThrow(DiffStopped)
    }
    expect(() => countLines(many, () => true)).toThrow(DiffStopped)
    expect(() => splitLines(many, () => true)).toThrow(DiffStopped)
  })

  it('asks its stop often on millions of short lines, and holds no row for a line outside a hunk', () => {
    const count = 2_000_000
    const rows = Array.from({ length: count }, (_value, n) => `r${n % 977}`)
    const before = rows.join('\n')
    const after = `${[...rows.slice(0, count / 2), 'changed', ...rows.slice(count / 2)].join('\n')}\n`
    let last = performance.now()
    let longest = 0
    const patch = unified(`${before}\n`, after, { stop: () => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
      return false
    } })
    longest = Math.max(longest, performance.now() - last)
    expect([patch.added, patch.removed, patch.hunks.length]).toEqual([1, 0, 1])
    expect(patch.hunks[0]?.lines).toHaveLength(7)
    // A cancel is heard within 100 ms: no stretch between two questions comes near it.
    expect(longest).toBeLessThan(90)
    const began = performance.now()
    expect(() => unified(`${before}\n`, after, { stop: () => performance.now() - began > 100 })).toThrow(DiffStopped)
    expect(performance.now() - began).toBeLessThan(190)
  })

  it('holds only as many lines as its caller keeps, and counts the rest', () => {
    const after = `${Array.from({ length: 50 }, (_value, n) => `n${n}`).join('\n')}\n`
    const cut = unified('', after, { keep: 7 })
    expect(cut).toMatchObject({ added: 50, removed: 0, dropped: 43, hunks: [{ aStart: 0, aLines: 0, bStart: 1, bLines: 50 }] })
    expect(cut.hunks[0]?.lines).toEqual(unified('', after).hunks[0]?.lines.slice(0, 7))
    expect(unified('', after).dropped).toBeUndefined()
    // A hunk none of whose lines is held is not given; its lines are counted.
    const base = Array.from({ length: 40 }, (_value, n) => `l${n}`)
    const edited = base.map((line, n) => (n === 2 || n === 30 ? `${line}!` : line))
    const two = unified(`${base.join('\n')}\n`, `${edited.join('\n')}\n`, { keep: 7 })
    expect(two.hunks).toHaveLength(1)
    expect(two.hunks[0]?.lines).toHaveLength(7)
    expect(two.dropped).toBe(8)
  })

  it('is quick on a long text with few changes', () => {
    const base = Array.from({ length: 200000 }, (_, n) => `row ${n}`)
    const edited = base.slice()
    edited[1000] = 'changed'
    edited.splice(150000, 2)
    edited.push('tail')
    const began = Date.now()
    const big = diffLines(`${base.join('\n')}\n`, `${edited.join('\n')}\n`)
    expect([big.addedCount, big.removedCount]).toEqual([2, 3])
    expect(Date.now() - began).toBeLessThan(1500)
  })
})
