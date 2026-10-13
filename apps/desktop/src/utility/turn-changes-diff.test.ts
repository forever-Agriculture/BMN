// MODULE: turn-changes-diff.test.ts - the line comparison against a brute-force longest common subsequence, against known texts, and its stop
import { describe, expect, it } from 'vitest'
import { DiffStopped, decodeText, diffLines, splitLines, unified, type SplitText } from './turn-changes-diff'

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

describe('the lines of two texts', () => {
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
