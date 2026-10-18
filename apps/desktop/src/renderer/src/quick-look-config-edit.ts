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

interface MaskState {
  masks: readonly Mask[]
  format: ConfigFormat
  nextId: number
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
/** A value rewritten whole: where its new quoted text starts, in the new text, and how long it is. */
const rewritten = Annotation.define<ReadonlyArray<{ at: number; length: number; pasted: boolean; typing: boolean }>>()
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

export const maskField = StateField.define<MaskState>({
  create: () => ({ masks: [], format: 'json', nextId: 1 }),
  update(value, tr) {
    let masks = mapMasks(value.masks, tr)
    let nextId = value.nextId
    const add = (mask: Omit<Mask, 'id'>): void => {
      if (mask.to <= mask.from) return
      masks.push({ ...mask, id: nextId })
      nextId += 1
    }
    for (const each of tr.annotation(rewritten) ?? []) add({ from: each.at + 1, to: each.at + each.length - 1, pasted: each.pasted, typing: each.typing })
    // A pasted line that meets the rule, pasted anywhere but on a hidden value, lands masked.
    if (tr.isUserEvent('input.paste') && !tr.annotation(rewritten)) {
      tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
        if (pasteLandsMasked(inserted.toString())) add({ from: fromB, to: toB, pasted: true, typing: false })
      })
    }
    for (const effect of tr.effects) {
      if (effect.is(addMasks)) for (const mask of effect.value) add({ from: mask.from, to: mask.to, pasted: mask.pasted, typing: false })
      else if (effect.is(dropMask)) masks = masks.filter((mask) => mask.id !== effect.value)
      else if (effect.is(shownMask)) masks = masks.map((mask) => (mask.id === effect.value ? { ...mask, pasted: false } : mask))
    }
    // A value typed in place stays open for more typing only while the caret stays at its end.
    if (tr.selection || tr.docChanged) {
      const head = tr.state.selection.main
      masks = masks.map((mask) => (mask.typing && !(head.empty && head.head === mask.to) ? { ...mask, typing: false } : mask))
    }
    masks.sort((a, b) => a.from - b.from)
    return { masks, format: value.format, nextId }
  }
})

/**
 * Every edit his keys make inside a hidden value's token replaces the whole value: typing or a paste writes it
 * double-quoted with the format's escapes, Backspace or Delete leaves an empty string, an edit that crosses its edge
 * takes all of it, and a multi-line value is not replaced at all (AC3). Characters typed at the end of a value he
 * has just typed in place go on adding to it.
 */
const wholeValues = EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'))) return tr
  const { masks, format } = tr.startState.field(maskField)
  if (masks.length === 0) return tr
  const text = tr.startState.doc.toString()
  const spans = masks.map((mask) => {
    const span = valueSpan(format, text, mask.from, mask.to)
    return { mask, span, from: Math.min(span.from, mask.from), to: Math.max(span.to, mask.to) }
  })
  const pasted = tr.isUserEvent('input.paste')
  const changes: ChangeSpec[] = []
  const done: Array<{ at: number; length: number; pasted: boolean; typing: boolean; caret: 'inside' | 'end' }> = []
  const grown: number[] = []
  let touched = false
  let refusal: string | null = null
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.toString()
    // Inside a token: strictly within its quotes for an insertion, anywhere in it for a replacement or a deletion.
    const hit = spans.find((each) => (fromA === toA ? fromA > each.from && fromA < each.to : fromA < each.to && toA > each.from))
    if (!hit) {
      changes.push({ from: fromA, to: toA, insert })
      return
    }
    touched = true
    const { mask, span } = hit
    if (mask.typing && fromA === toA && fromA === mask.to && !/[\r\n]/u.test(insert)) {
      const escaped = quotedValue(format, insert).slice(1, -1)
      changes.push({ from: fromA, insert: escaped })
      grown.push(mask.id)
      return
    }
    if (span.multiLine) {
      refusal = MULTI_LINE_REFUSED
      return
    }
    if (/[\r\n]/u.test(insert)) {
      refusal = LINE_BREAK_REFUSED
      return
    }
    // An edit that crosses the token's edge takes the whole token with it and keeps its own text around it.
    if (fromA < hit.from || toA > hit.to) {
      changes.push({ from: Math.min(fromA, span.from), to: Math.max(toA, span.to), insert })
      return
    }
    const quoted = quotedValue(format, insert)
    changes.push({ from: span.from, to: span.to, insert: quoted })
    done.push({ at: span.from, length: quoted.length, pasted, typing: !pasted && insert.length > 0, caret: insert.length > 0 ? 'end' : 'inside' })
  })
  if (!touched) return tr
  if (refusal) return { effects: refusedEdit.of(refusal) }
  const set = ChangeSet.of(changes, tr.startState.doc.length)
  const placed = done.map((each) => ({ ...each, at: set.mapPos(each.at, -1) }))
  const last = placed.at(-1)
  return {
    changes: set,
    annotations: [
      rewritten.of(placed.map(({ at, length, pasted: wasPasted, typing }) => ({ at, length, pasted: wasPasted, typing }))),
      extended.of(grown),
      ...(tr.annotation(Transaction.userEvent) ? [Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!)] : [])
    ],
    // The caret goes to the end of the new value, inside its quotes; an emptied value keeps it between them; typing
    // at a value's end keeps it there.
    ...(last ? { selection: { anchor: last.caret === 'end' ? last.at + last.length - 1 : last.at + 1 } }
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
export function configMasks(format: ConfigFormat, ranges: ReadonlyArray<readonly [number, number]>): Extension {
  return [
    maskField.init((state) => {
      const text = state.doc.toString()
      // Each mask covers the value inside its quotes, so its comma, bracket or comment stays in sight while he edits.
      const masks = ranges.flatMap(([from, to], index) => {
        const span = valueSpan(format, text, from, to)
        const [maskFrom, maskTo] = span.multiLine ? [from, to] : [span.innerFrom, span.innerTo]
        return maskTo > maskFrom ? [{ id: index + 1, from: maskFrom, to: maskTo, pasted: false, typing: false }] : []
      })
      return { masks, format, nextId: ranges.length + 1 }
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

/** The lines another program changed, as one change from the text as read to the text on disk now. */
function changedBlock(original: Text, latest: Text): ChangeSet {
  let top = 1
  while (top <= original.lines && top <= latest.lines && original.line(top).text === latest.line(top).text) top += 1
  if (top > original.lines && top > latest.lines) return ChangeSet.empty(original.length)
  let bottom = 0
  while (bottom < original.lines - top + 1 && bottom < latest.lines - top + 1 &&
    original.line(original.lines - bottom).text === latest.line(latest.lines - bottom).text) bottom += 1
  const from = top <= original.lines ? original.line(top).from : original.length
  const to = original.lines - bottom >= top ? original.line(original.lines - bottom).to : from
  const insertFrom = top <= latest.lines ? latest.line(top).from : latest.length
  const insertTo = latest.lines - bottom >= top ? latest.line(latest.lines - bottom).to : insertFrom
  return ChangeSet.of({ from, to, insert: latest.sliceString(insertFrom, insertTo) }, original.length)
}

/**
 * His draft carried onto the file as another program left it, after a blocked save: his edits go where they were
 * when the other program changed other lines; when both changed the same lines, nothing is carried (null).
 */
export function rebaseConfigDraft(original: Text, changes: ChangeSet, masks: readonly Mask[], latest: Text): { text: Text; changes: ChangeSet; masks: Mask[] } | null {
  const theirs = changedBlock(original, latest)
  let clash = false
  theirs.iterChangedRanges((fromA, toA) => {
    changes.iterChangedRanges((ownFrom, ownTo) => {
      // Lines both touched, taken whole: an edit at the end of the line before theirs still clashes.
      const lineFrom = original.lineAt(fromA).from
      const lineTo = original.lineAt(toA).to
      if (ownFrom <= lineTo && ownTo >= lineFrom) clash = true
    })
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
