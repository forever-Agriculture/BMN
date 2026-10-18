// MODULE: quick-look-config-edit.ts - a config file's draft in the editable view, as state: hidden values that move and are replaced as one piece, the paste rule, and which lines changed, were added or removed (Story 68.2)
import { invertedEffects } from '@codemirror/commands'
import { Annotation, ChangeSet, EditorState, StateEffect, StateField, Text, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from '@codemirror/state'
import type { ConfigFormat } from './quick-look-syntax'

/** A hidden value in the draft: the text its dots stand for, without its quotes. */
export interface Mask {
  id: number
  from: number
  to: number
  /** Pasted in this draft: its note reads "Pasted" until it is saved or shown (AC4). */
  pasted: boolean
  /** Typed in place of a value just now: the next characters typed at its end go on adding to it. */
  typing: boolean
  /**
   * A value stands for a whole value of the file, replaced as a quoted string; a piece is pasted text that met the
   * paste rule wherever it landed, replaced as it is, so the text around it stays.
   */
  kind: 'value' | 'piece'
}

export const MULTI_LINE_REFUSED = 'Multi-line value; edit it in the terminal'
export const LINE_BREAK_REFUSED = 'A value is one line; nothing was pasted'

/**
 * A value written as a double-quoted string with its format's escapes (AC3). JSON's escapes are a subset of what
 * YAML's and TOML's double-quoted strings take; DEL, the C1 controls, the line and paragraph separators and a byte
 * order mark are escaped too, since YAML and TOML refuse some of them bare.
 */
export function quotedValue(format: ConfigFormat, value: string): string {
  void format
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** A pasted single line of 8 or more characters with no space lands masked (AC4). */
export function pasteLandsMasked(text: string): boolean {
  return text.length >= 8 && !/\s/u.test(text)
}

/** The token a hidden value stands in: its quotes included, a trailing comma, brace or comment left out; and whether it spans lines. */
export interface ValueSpan {
  from: number
  to: number
  /** Where the value's own text is, inside any quotes. */
  innerFrom: number
  innerTo: number
  multiLine: boolean
}

/** The end of a quoted string that opens at `at`, after its closing quote; null when it runs past its line. */
function quotedEnd(format: ConfigFormat, text: string, at: number): number | null {
  const quote = text[at]!
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') return null
    if (quote === '"' && char === '\\') index += 1
    else if (char === quote) {
      // YAML writes a single quote inside a single-quoted string as two.
      if (quote === "'" && format === 'yaml' && text[index + 1] === "'") index += 1
      else return index + 1
    }
  }
  return null
}

/**
 * The value a hidden stretch stands for, found from the stretch's start by the format's own token rules: a quoted
 * string to its closing quote, or a bare value to the end of its line, a comment, or (outside YAML) a comma or a
 * closing bracket. A stretch whose value spans lines (a YAML block, a multi-line string) is taken as it is.
 */
export function valueSpan(format: ConfigFormat, text: string, from: number, to: number): ValueSpan {
  let start = from
  while (start < to && (text[start] === ' ' || text[start] === '\t')) start += 1
  const stretch = text.slice(start, to)
  const triple = text.startsWith('"""', start) || text.startsWith("'''", start)
  const opening = text[start] === '"' || text[start] === "'" ? start : (text[start - 1] === '"' || text[start - 1] === "'") ? start - 1 : -1
  if (!triple && opening !== -1) {
    const end = quotedEnd(format, text, opening)
    if (end !== null) return { from: opening, to: end, innerFrom: opening + 1, innerTo: end - 1, multiLine: false }
  }
  if (triple || opening !== -1 || /\n/u.test(stretch.trimEnd())) return { from, to, innerFrom: from, innerTo: to, multiLine: true }
  const line = text.indexOf('\n', start)
  let end = line === -1 ? text.length : line
  const comment = format === 'yaml' || format === 'toml' ? text.slice(start, end).search(/\s#/u) : text.slice(start, end).search(/\/\/|\/\*/u)
  if (comment !== -1) end = start + comment
  if (format !== 'yaml') {
    const stop = text.slice(start, end).search(/[,\]}\s]/u)
    if (stop !== -1) end = start + stop
  }
  while (end > start && /\s/u.test(text[end - 1]!)) end -= 1
  return { from: start, to: end, innerFrom: start, innerTo: end, multiLine: false }
}

/** The line endings a file keeps when saved: all `\n`, all `\r\n`, or a mix that cannot be kept as it is. */
export function lineEndingOf(text: string): '\n' | '\r\n' | 'mixed' {
  const crlf = text.split('\r\n').length - 1
  const cr = text.split('\r').length - 1
  const lf = text.split('\n').length - 1
  if (cr === 0) return '\n'
  return crlf === cr && crlf === lf ? '\r\n' : 'mixed'
}

/** The file's own rule for what looks like a secret, run on a draft's text. */
export type SecretFinder = (text: string) => ReadonlyArray<readonly [number, number]>

interface MaskState {
  masks: readonly Mask[]
  format: ConfigFormat
  nextId: number
  find: SecretFinder
}

const addMasks = StateEffect.define<readonly Mask[]>({
  map: (masks, mapping) => masks.flatMap((mask) => {
    const from = mapping.mapPos(mask.from, 1)
    const to = mapping.mapPos(mask.to, -1)
    return to > from ? [{ ...mask, from, to }] : []
  })
})
const dropMask = StateEffect.define<number>()
/** Shown masks lose their "Pasted" mark (AC4). */
export const shownMask = StateEffect.define<number>()
/** What a rewrite refused, for the footer to say. */
export const refusedEdit = StateEffect.define<string>()
/** A value rewritten whole: where its new text starts, in the new text, how long it is, and whether it is quoted. */
const rewritten = Annotation.define<ReadonlyArray<{ at: number; length: number; pasted: boolean; typing: boolean; kind: Mask['kind'] }>>()
/** Masks whose value his typing at their end added to. */
const extended = Annotation.define<readonly number[]>()

/** One change replaced or removed all of a stretch (touchesRange's "cover" asks for more than all). */
function covered(changes: ChangeSet, from: number, to: number): boolean {
  let all = false
  changes.iterChangedRanges((fromA, toA) => { if (toA > fromA && fromA <= from && toA >= to) all = true })
  return all
}

/** Masks follow the text; one whose text an edit replaced or removed whole is gone. */
function mapMasks(masks: readonly Mask[], tr: Transaction): Mask[] {
  if (!tr.docChanged) return [...masks]
  const grown = tr.annotation(extended) ?? []
  return masks.flatMap((mask) => {
    if (covered(tr.changes, mask.from, mask.to)) return []
    const from = tr.changes.mapPos(mask.from, 1)
    const to = tr.changes.mapPos(mask.to, grown.includes(mask.id) ? 1 : -1)
    return to > from ? [{ ...mask, from, to }] : []
  })
}

/** The masks a read file's hidden values get: each covers the value inside its quotes, so its comma, bracket or comment stays in sight. */
function valueMasks(format: ConfigFormat, text: string, ranges: ReadonlyArray<readonly [number, number]>): Array<{ from: number; to: number }> {
  return ranges.flatMap(([from, to]) => {
    const span = valueSpan(format, text, from, to)
    const [maskFrom, maskTo] = span.multiLine ? [from, to] : [span.innerFrom, span.innerTo]
    return maskTo > maskFrom ? [{ from: maskFrom, to: maskTo }] : []
  })
}

export const maskField = StateField.define<MaskState>({
  create: () => ({ masks: [], format: 'json', nextId: 1, find: () => [] }),
  update(value, tr) {
    let masks = mapMasks(value.masks, tr)
    let nextId = value.nextId
    const add = (mask: Omit<Mask, 'id'>): void => {
      if (mask.to <= mask.from || masks.some((other) => mask.from < other.to && mask.to > other.from)) return
      masks.push({ ...mask, id: nextId })
      nextId += 1
    }
    for (const each of tr.annotation(rewritten) ?? []) {
      const [from, to] = each.kind === 'value' ? [each.at + 1, each.at + each.length - 1] : [each.at, each.at + each.length]
      add({ from, to, pasted: each.pasted, typing: each.typing, kind: each.kind })
    }
    // Pasted text is masked as a read file is: values the file's rule finds in it, then a line that meets the paste
    // rule, wherever it landed and whatever it replaced.
    if (tr.isUserEvent('input.paste')) {
      const inserted: Array<{ from: number; to: number; text: string }> = []
      tr.changes.iterChanges((_fromA, _toA, fromB, toB, text) => { if (toB > fromB) inserted.push({ from: fromB, to: toB, text: text.toString() }) })
      const text = tr.state.doc.toString()
      for (const found of valueMasks(value.format, text, value.find(text))) {
        if (inserted.some((each) => found.from < each.to && found.to > each.from)) add({ ...found, pasted: true, typing: false, kind: 'value' })
      }
      for (const each of inserted) if (pasteLandsMasked(each.text)) add({ from: each.from, to: each.to, pasted: true, typing: false, kind: 'piece' })
    }
    for (const effect of tr.effects) {
      if (effect.is(addMasks)) for (const mask of effect.value) add({ from: mask.from, to: mask.to, pasted: mask.pasted, typing: false, kind: mask.kind })
      else if (effect.is(dropMask)) masks = masks.filter((mask) => mask.id !== effect.value)
      else if (effect.is(shownMask)) masks = masks.map((mask) => (mask.id === effect.value ? { ...mask, pasted: false } : mask))
    }
    // A value typed in place stays open for more typing only while the caret stays at its end.
    if (tr.selection || tr.docChanged) {
      const head = tr.state.selection.main
      masks = masks.map((mask) => (mask.typing && !(head.empty && head.head === mask.to) ? { ...mask, typing: false } : mask))
    }
    masks.sort((a, b) => a.from - b.from)
    return { masks, format: value.format, nextId, find: value.find }
  }
})

/**
 * Every edit his keys make inside a hidden value's token replaces the whole value: typing or a paste writes it
 * double-quoted with the format's escapes, Backspace or Delete leaves an empty string, an edit that crosses its edge
 * takes all of every value it meets, and a multi-line value is not replaced at all (AC3). A pasted piece is replaced
 * as it is, leaving the text around it. Characters typed at the end of a value he has just typed go on adding to it.
 */
const wholeValues = EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'))) return tr
  const { masks, format } = tr.startState.field(maskField)
  if (masks.length === 0) return tr
  const text = tr.startState.doc.toString()
  const spans = masks.map((mask) => {
    const span: ValueSpan = mask.kind === 'piece'
      ? { from: mask.from, to: mask.to, innerFrom: mask.from, innerTo: mask.to, multiLine: false }
      : valueSpan(format, text, mask.from, mask.to)
    return { mask, span, from: Math.min(span.from, mask.from), to: Math.max(span.to, mask.to) }
  })
  const pasted = tr.isUserEvent('input.paste')
  const changes: ChangeSpec[] = []
  const done: Array<{ at: number; length: number; pasted: boolean; typing: boolean; kind: Mask['kind']; caret: 'inside' | 'end' }> = []
  const grown: number[] = []
  let touched = false
  let refusal: string | null = null
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.toString()
    const growing = fromA === toA && !/[\r\n]/u.test(insert) ? spans.find((each) => each.mask.typing && fromA === each.mask.to) : undefined
    if (growing) {
      touched = true
      changes.push({ from: fromA, insert: growing.mask.kind === 'value' ? quotedValue(format, insert).slice(1, -1) : insert })
      grown.push(growing.mask.id)
      return
    }
    // Every token the change meets: strictly within its quotes for an insertion, anywhere in it for a replacement or a deletion.
    const hits = spans.filter((each) => (fromA === toA ? fromA > each.from && fromA < each.to : fromA < each.to && toA > each.from))
    if (hits.length === 0) {
      changes.push({ from: fromA, to: toA, insert })
      return
    }
    touched = true
    if (hits.some((each) => each.span.multiLine)) {
      refusal = MULTI_LINE_REFUSED
      return
    }
    const hit = hits.length === 1 && fromA >= hits[0]!.from && toA <= hits[0]!.to ? hits[0]! : null
    if (!hit) {
      // An edit that crosses a token's edge takes every token it meets whole and keeps its own text around them.
      changes.push({ from: Math.min(fromA, ...hits.map((each) => each.span.from)), to: Math.max(toA, ...hits.map((each) => each.span.to)), insert })
      return
    }
    if (/[\r\n]/u.test(insert)) {
      refusal = LINE_BREAK_REFUSED
      return
    }
    const caret = insert.length > 0 ? 'end' : 'inside'
    const typing = !pasted && insert.length > 0
    if (hit.mask.kind === 'piece') {
      changes.push({ from: hit.span.from, to: hit.span.to, insert })
      done.push({ at: hit.span.from, length: insert.length, pasted, typing, kind: 'piece', caret })
      return
    }
    const quoted = quotedValue(format, insert)
    changes.push({ from: hit.span.from, to: hit.span.to, insert: quoted })
    done.push({ at: hit.span.from, length: quoted.length, pasted, typing, kind: 'value', caret })
  })
  if (!touched) return tr
  if (refusal) return { effects: refusedEdit.of(refusal) }
  const set = ChangeSet.of(changes, tr.startState.doc.length)
  const placed = done.map((each) => ({ ...each, at: set.mapPos(each.at, -1) }))
  const last = placed.at(-1)
  const quote = last?.kind === 'value' ? 1 : 0
  return {
    changes: set,
    annotations: [
      rewritten.of(placed.map(({ at, length, pasted: wasPasted, typing, kind }) => ({ at, length, pasted: wasPasted, typing, kind }))),
      extended.of(grown),
      ...(tr.annotation(Transaction.userEvent) ? [Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!)] : [])
    ],
    // The caret goes to the end of the new value, inside its quotes; an emptied value keeps it between them; typing
    // at a value's end keeps it there.
    ...(last ? { selection: { anchor: last.caret === 'end' ? last.at + last.length - quote : last.at + quote } }
      : grown.length > 0 ? { selection: { anchor: set.mapPos(tr.startState.selection.main.head, 1) } } : {}),
    scrollIntoView: true
  }
})

/** Masks an undo or redo took away come back with it: no value shows because its edit was undone. */
const masksInHistory = invertedEffects.of((tr) => {
  const before = tr.startState.field(maskField).masks
  const after = new Set(tr.state.field(maskField).masks.map((mask) => mask.id))
  const gone = before.filter((mask) => !after.has(mask.id))
  const added = tr.state.field(maskField).masks.filter((mask) => !before.some((old) => old.id === mask.id))
  return [...(gone.length > 0 ? [addMasks.of(gone)] : []), ...added.map((mask) => dropMask.of(mask.id))]
})

/** The draft's masks, starting from the file's hidden values, and the rules that keep each one whole. */
export function configMasks(
  format: ConfigFormat,
  ranges: ReadonlyArray<readonly [number, number]>,
  find: SecretFinder = () => [],
  /** A carried draft's masks, kept as they were. */
  kept: ReadonlyArray<Pick<Mask, 'from' | 'to' | 'pasted' | 'kind'>> = []
): Extension {
  return [
    maskField.init((state) => {
      const fresh = valueMasks(format, state.doc.toString(), ranges).filter((mask) => !kept.some((other) => mask.from < other.to && mask.to > other.from))
      const masks = [...kept.map(({ from, to, pasted, kind }) => ({ from, to, pasted, kind })), ...fresh.map((mask) => ({ ...mask, pasted: false, kind: 'value' as const }))]
        .sort((a, b) => a.from - b.from)
        .map((mask, index): Mask => ({ ...mask, id: index + 1, typing: false }))
      return { masks, format, nextId: masks.length + 1, find }
    }),
    wholeValues,
    masksInHistory
  ]
}

/** The edits since the file was read, kept as one change set from the text as read. */
export const draftChanges = StateField.define<{ original: Text; changes: ChangeSet }>({
  create: (state) => ({ original: state.doc, changes: ChangeSet.empty(state.doc.length) }),
  update: (value, tr) => (tr.docChanged ? { original: value.original, changes: value.changes.compose(tr.changes) } : value)
})

export interface LineMarks {
  /** Line numbers of the draft, 1-based. */
  changed: ReadonlySet<number>
  added: ReadonlySet<number>
  removed: number
}

/**
 * Which lines of the draft differ from the file as read: each changed stretch, taken as whole lines, pairs its old
 * and new lines after their common start and end; the pairs are changed lines, the rest added or removed (AC2).
 */
export function lineMarks(original: Text, changes: ChangeSet, draft: Text): LineMarks {
  const changed = new Set<number>()
  const added = new Set<number>()
  let removed = 0
  const stretches: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const a = { from: original.lineAt(fromA).number, to: original.lineAt(toA).number }
    const b = { from: draft.lineAt(fromB).number, to: draft.lineAt(toB).number }
    const last = stretches.at(-1)
    // Stretches on one line are one stretch.
    if (last && a.from <= last.toA) {
      last.toA = Math.max(last.toA, a.to)
      last.toB = Math.max(last.toB, b.to)
    } else stretches.push({ fromA: a.from, toA: a.to, fromB: b.from, toB: b.to })
  })
  for (const stretch of stretches) {
    const old = Array.from({ length: stretch.toA - stretch.fromA + 1 }, (_, index) => original.line(stretch.fromA + index).text)
    const now = Array.from({ length: stretch.toB - stretch.fromB + 1 }, (_, index) => draft.line(stretch.fromB + index).text)
    let start = 0
    while (start < old.length && start < now.length && old[start] === now[start]) start += 1
    let end = 0
    while (end < old.length - start && end < now.length - start && old[old.length - 1 - end] === now[now.length - 1 - end]) end += 1
    const oldCount = old.length - start - end
    const newCount = now.length - start - end
    const pairs = Math.min(oldCount, newCount)
    for (let index = 0; index < newCount; index += 1) (index < pairs ? changed : added).add(stretch.fromB + start + index)
    removed += Math.max(0, oldCount - newCount)
  }
  return { changed, added, removed }
}

/** What the Save bar says changed: "2 lines changed · 1 added · 1 removed". */
export function lineSummary(marks: LineMarks): string {
  const parts: string[] = []
  if (marks.changed.size > 0) parts.push(`${marks.changed.size} ${marks.changed.size === 1 ? 'line' : 'lines'} changed`)
  if (marks.added.size > 0) parts.push(`${marks.added.size} added`)
  if (marks.removed > 0) parts.push(`${marks.removed} removed`)
  return parts.length > 0 ? parts.join(' · ') : 'No lines changed'
}

/** Above this many line pairs in the stretch both texts differ in, the stretch is one change: a clash is then only more likely. */
const LINE_DIFF_LIMIT = 4_000_000

/**
 * The lines another program changed, from the text as read to the text on disk now: each run of changed lines is its
 * own change, found by the longest run of lines the two texts share, so edits above and below his line stay apart.
 */
function changedLines(original: Text, latest: Text): { changes: ChangeSet; runs: ReadonlyArray<readonly [number, number, number, number]> } {
  const old = Array.from({ length: original.lines }, (_, index) => original.line(index + 1).text)
  const now = Array.from({ length: latest.lines }, (_, index) => latest.line(index + 1).text)
  let top = 0
  while (top < old.length && top < now.length && old[top] === now[top]) top += 1
  let bottom = 0
  while (bottom < old.length - top && bottom < now.length - top && old[old.length - 1 - bottom] === now[now.length - 1 - bottom]) bottom += 1
  const n = old.length - top - bottom
  const m = now.length - top - bottom
  // Runs of [old from, old to, new from, new to) lines, 0-based.
  const runs: Array<[number, number, number, number]> = []
  if (n === 0 && m === 0) return { changes: ChangeSet.empty(original.length), runs }
  if (n === 0 || m === 0 || n * m > LINE_DIFF_LIMIT) runs.push([top, top + n, top, top + m])
  else {
    // shared[i][j]: lines shared by old[top+i..] and now[top+j..].
    const shared = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        shared[i]![j] = old[top + i] === now[top + j] ? shared[i + 1]![j + 1]! + 1 : Math.max(shared[i + 1]![j]!, shared[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    let run: [number, number, number, number] | null = null
    while (i < n || j < m) {
      if (i < n && j < m && old[top + i] === now[top + j]) {
        if (run) runs.push(run)
        run = null
        i += 1
        j += 1
        continue
      }
      run ??= [top + i, top + i, top + j, top + j]
      if (j < m && (i === n || shared[i]![j + 1]! >= shared[i + 1]![j]!)) run[3] = top + ++j
      else run[1] = top + ++i
    }
    if (run) runs.push(run)
  }
  const joined = (from: number, to: number): string => now.slice(from, to).join('\n')
  const changes = ChangeSet.of(runs.map(([oldFrom, oldTo, newFrom, newTo]) => {
    if (oldFrom === oldTo) {
      // New lines only: before the line they precede, or after the last line.
      return oldFrom < old.length
        ? { from: original.line(oldFrom + 1).from, insert: `${joined(newFrom, newTo)}\n` }
        : { from: original.length, insert: `\n${joined(newFrom, newTo)}` }
    }
    if (newFrom === newTo) {
      // Lines removed, with one line break.
      if (oldTo < old.length) return { from: original.line(oldFrom + 1).from, to: original.line(oldTo + 1).from }
      return { from: oldFrom > 0 ? original.line(oldFrom).to : 0, to: original.length }
    }
    return { from: original.line(oldFrom + 1).from, to: original.line(oldTo).to, insert: joined(newFrom, newTo) }
  }), original.length)
  return { changes, runs }
}

/**
 * His draft carried onto the file as another program left it, after a blocked save: his edits go where they were
 * when the other program changed other lines; when both changed the same lines, nothing is carried (null).
 */
export function rebaseConfigDraft(original: Text, changes: ChangeSet, masks: readonly Mask[], latest: Text): { text: Text; changes: ChangeSet; masks: Mask[] } | null {
  const { changes: theirs, runs } = changedLines(original, latest)
  let clash = false
  changes.iterChangedRanges((ownFrom, ownTo) => {
    // The lines he touched, taken whole and 0-based; theirs clash when they change one of them, or add lines beside one.
    const ownTop = original.lineAt(ownFrom).number - 1
    const ownBottom = original.lineAt(ownTo).number - 1
    for (const [oldFrom, oldTo] of runs) {
      if (oldFrom === oldTo ? ownTop <= oldFrom && ownBottom >= oldFrom - 1 : ownTop < oldTo && ownBottom >= oldFrom) clash = true
    }
  })
  if (clash) return null
  const mine = changes.map(theirs)
  const theirsAfterMine = theirs.map(changes, true)
  const text = mine.apply(latest)
  const moved = masks.flatMap((mask) => {
    const from = theirsAfterMine.mapPos(mask.from, 1)
    const to = theirsAfterMine.mapPos(mask.to, -1)
    return to > from ? [{ ...mask, from, to }] : []
  })
  return { text, changes: mine, masks: moved }
}
