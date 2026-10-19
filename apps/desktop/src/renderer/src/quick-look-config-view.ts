// MODULE: quick-look-config-view.ts - a config file in CodeMirror's editable mode: hidden values drawn as the plates of 67.3 over the real draft, their notes at the line's edge, a bar or a plus for changed and added lines, history in memory, and copies that carry "[secret hidden]" (Story 68.2)
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type ChangeSet, type Extension, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  gutter,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import type { QuickLookLanguage } from '@bmn/protocol'
import { languageExtension, syntaxClasses } from './quick-look-code'
import { configMasks, draftChanges, lineMarks, maskField, refusedEdit, shownMask, type LineMarks, type Mask, type SecretFinder } from './quick-look-config-edit'
import { maskedSlice } from './quick-look-secrets'
import type { ConfigFormat } from './quick-look-syntax'

const DOTS = '•'.repeat(12)

/** The value shown for its ten seconds, by mask id, and the seconds left. */
const setShown = StateEffect.define<{ id: number; secondsLeft: number } | null>()
const shownField = StateField.define<{ id: number; secondsLeft: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setShown)) return effect.value
    // A value that is gone is not shown.
    return value && tr.state.field(maskField).masks.some((mask) => mask.id === value.id) ? value : null
  }
})

class Plate extends WidgetType {
  constructor(readonly length: number) {
    super()
  }

  override eq(other: Plate): boolean {
    return other.length === this.length
  }

  toDOM(): HTMLElement {
    const plate = document.createElement('span')
    plate.className = 'ql-secret'
    plate.textContent = DOTS
    plate.setAttribute('role', 'img')
    plate.setAttribute('aria-label', `hidden value, ${this.length} ${this.length === 1 ? 'character' : 'characters'}`)
    return plate
  }
}

function plates(state: EditorState): DecorationSet {
  const shown = state.field(shownField)
  return Decoration.set(state.field(maskField).masks.map((mask) => (mask.id === shown?.id
    ? Decoration.mark({ class: 'ql-secret-shown' }).range(mask.from, mask.to)
    : Decoration.replace({ widget: new Plate(mask.to - mask.from) }).range(mask.from, mask.to))))
}

const plateField = StateField.define<DecorationSet>({
  create: (state) => plates(state),
  update: (value, tr) => (tr.docChanged || tr.effects.length > 0 || tr.startState.field(maskField) !== tr.state.field(maskField) ? plates(tr.state) : value),
  // A value, shown or not, is one piece the caret steps over.
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => RangeSet.of(view.state.field(maskField).masks.map((mask) => Decoration.mark({}).range(mask.from, mask.to))))
  ]
})

const EYE = 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'

/** The note at the right edge of a line with a hidden value: its length, "Pasted" and an eye, or the countdown. */
function notes(onReveal: (id: number) => void): Extension {
  return ViewPlugin.fromClass(class {
    readonly layer: HTMLElement
    readonly onScroll = (): void => this.schedule()

    constructor(readonly view: EditorView) {
      this.layer = document.createElement('div')
      this.layer.className = 'ql-secret-notes'
      view.dom.appendChild(this.layer)
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((tr) => tr.effects.length > 0)) this.schedule()
    }

    schedule(): void {
      this.view.requestMeasure({ key: this, read: (view) => this.measure(view), write: (rows) => this.draw(rows) })
    }

    measure(view: EditorView): Array<{ mask: Mask; top: number; height: number; shown: number | null }> {
      const shown = view.state.field(shownField)
      const origin = view.dom.getBoundingClientRect().top
      const box = view.scrollDOM.getBoundingClientRect()
      return view.state.field(maskField).masks.flatMap((mask) => {
        if (mask.to < view.viewport.from || mask.from > view.viewport.to) return []
        const block = view.lineBlockAt(mask.from)
        const top = block.top + view.documentTop - origin
        if (top + block.height <= box.top - origin || top >= box.bottom - origin) return []
        return [{ mask, top, height: block.height, shown: shown?.id === mask.id ? shown.secondsLeft : null }]
      })
    }

    draw(rows: Array<{ mask: Mask; top: number; height: number; shown: number | null }>): void {
      this.layer.replaceChildren(...rows.map(({ mask, top, height, shown }) => {
        const row = document.createElement('div')
        row.className = `ql-secret-note${shown !== null ? ' shown' : ''}`
        row.style.top = `${top}px`
        row.style.height = `${height}px`
        const label = document.createElement('span')
        const length = mask.to - mask.from
        label.textContent = shown !== null ? `Shown · hides in ${shown} s` : mask.pasted ? `Pasted · ${length} chars` : `${length} chars`
        const eye = document.createElement('button')
        eye.type = 'button'
        eye.className = 'ql-eye'
        eye.setAttribute('aria-label', shown !== null ? 'Hide this value' : 'Show this value for 10 seconds')
        eye.setAttribute('aria-pressed', String(shown !== null))
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.setAttribute('width', '14')
        svg.setAttribute('height', '14')
        svg.setAttribute('aria-hidden', 'true')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', EYE)
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', 'currentColor')
        path.setAttribute('stroke-width', '1.3')
        svg.appendChild(path)
        eye.appendChild(svg)
        eye.addEventListener('mousedown', (event) => event.preventDefault())
        eye.addEventListener('click', () => onReveal(mask.id))
        row.append(label, eye)
        return row
      }))
    }

    destroy(): void {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      this.layer.remove()
    }
  })
}

/** The draft's lines that differ from the file as read, computed once per change. */
const marksField = StateField.define<LineMarks>({
  create: (state) => {
    const { original, changes } = state.field(draftChanges)
    return lineMarks(original, changes, state.doc)
  },
  update(value, tr) {
    if (!tr.docChanged) return value
    const { original, changes } = tr.state.field(draftChanges)
    return lineMarks(original, changes, tr.state.doc)
  }
})

class ChangeMark extends GutterMarker {
  constructor(readonly kind: 'changed' | 'added') {
    super()
  }

  override eq(other: ChangeMark): boolean {
    return other.kind === this.kind
  }

  override toDOM(): Node {
    const mark = document.createElement('span')
    mark.className = `ql-change-mark ${this.kind}`
    mark.textContent = this.kind === 'added' ? '+' : ''
    mark.setAttribute('aria-label', this.kind === 'added' ? 'added line' : 'changed line')
    return mark
  }
}

const CHANGED = new ChangeMark('changed')
const ADDED = new ChangeMark('added')
const changedNumber = new (class extends GutterMarker { override elementClass = 'ql-line-changed' })()

function markRanges(doc: Text, marks: LineMarks, changed: GutterMarker, added: GutterMarker): RangeSet<GutterMarker> {
  const lines = [...[...marks.changed].map((line) => [line, changed] as const), ...[...marks.added].map((line) => [line, added] as const)]
    .filter(([line]) => line <= doc.lines).sort((a, b) => a[0] - b[0])
  return RangeSet.of(lines.map(([line, marker]) => marker.range(doc.line(line).from)))
}

const changeGutter: Extension = [
  marksField,
  // A changed or added line's number is drawn heavier.
  gutterLineClass.compute([marksField, 'doc'], (state) => markRanges(state.doc, state.field(marksField), changedNumber, changedNumber)),
  gutter({ class: 'ql-change-gutter', markers: (view) => markRanges(view.state.doc, view.state.field(marksField), CHANGED, ADDED) })
]

/** A copy, cut or drag of text that holds a hidden value carries "[secret hidden]" in its place, as the read-only view does. */
const maskedCopy = EditorView.domEventHandlers({
  copy: (event, view) => copyMasked(event, view, false),
  cut: (event, view) => copyMasked(event, view, true),
  // A selection that holds a hidden value is not dragged: dropped back in the draft it would move the words
  // "[secret hidden]" in and the value out.
  dragstart: (event, view) => {
    const chosen = view.state.selection.ranges.filter((range) => !range.empty)
    const masks = view.state.field(maskField).masks
    if (!chosen.some((range) => masks.some((mask) => range.from < mask.to && range.to > mask.from))) return false
    event.preventDefault()
    return true
  }
})

function copyMasked(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  if (!event.clipboardData || view.state.field(maskField).masks.length === 0) return false
  const { state } = view
  const chosen = state.selection.ranges.filter((range) => !range.empty)
  // With nothing selected the editor copies each caret's whole line, and a cut takes it with its line break.
  const lines = chosen.length > 0 ? [] : [...new Set(state.selection.ranges.map((range) => state.doc.lineAt(range.head).number))].sort((a, b) => a - b).map((number) => state.doc.line(number))
  const copied = chosen.length > 0 ? chosen.map((range) => maskedDraft(state, range.from, range.to)) : lines.map((line) => maskedDraft(state, line.from, line.to))
  event.clipboardData.setData('text/plain', copied.join('\n'))
  event.preventDefault()
  if (cut && !state.readOnly) {
    const changes = chosen.length > 0 ? chosen.map((range) => ({ from: range.from, to: range.to })) : lines.map((line) => ({ from: line.from, to: Math.min(state.doc.length, line.to + 1) }))
    view.dispatch({ changes, userEvent: 'delete.cut' })
  }
  return true
}

/** The draft between two places with every hidden value as "[secret hidden]", the shown one too. */
export function maskedDraft(state: EditorState, from = 0, to = state.doc.length): string {
  const ranges = state.field(maskField).masks.map((mask): [number, number] => [mask.from, mask.to])
  return maskedSlice(state.doc.toString(), ranges, from, to)
}

interface ConfigEditorInput {
  /** The file's text with one `\n` per line ending. */
  content: string
  format: ConfigFormat
  language: QuickLookLanguage | null
  ranges: ReadonlyArray<readonly [number, number]>
  /** The file's rule for what looks like a secret, for text pasted into the draft. */
  find: SecretFinder
  label: string
  /** A draft carried onto the file as it is now: that file's text, his edits since it and its masks. */
  carried?: { original: Text; changes: ChangeSet; masks: readonly Mask[] }
  onUpdate(update: ViewUpdate): void
  onRefused(words: string): void
  onReveal(id: number): void
}

/** The file as an editable draft; nothing it does reaches the disk. */
export function createConfigEditor(parent: HTMLElement, input: ConfigEditorInput): EditorView {
  const extensions: Extension[] = [
    configMasks(input.format, input.ranges, input.find, input.carried?.masks ?? []),
    frozen.of(EditorState.readOnly.of(false)),
    input.carried ? draftChanges.init(() => ({ original: input.carried!.original, changes: input.carried!.changes })) : draftChanges,
    lineNumbers(),
    highlightActiveLineGutter(),
    changeGutter,
    highlightSpecialChars(),
    drawSelection(),
    highlightActiveLine(),
    history(),
    EditorState.tabSize.of(4),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    languageExtension(input.language),
    syntaxClasses(input.language),
    shownField,
    plateField,
    notes((id) => input.onReveal(id)),
    maskedCopy,
    EditorView.contentAttributes.of({ 'aria-label': input.label }),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) for (const effect of tr.effects) if (effect.is(refusedEdit)) input.onRefused(effect.value)
      input.onUpdate(update)
    })
  ]
  return new EditorView({ parent, state: EditorState.create({ doc: input.content, extensions }) })
}

/** Shows one value for ten seconds, or none; a shown value loses its "Pasted" mark. */
/** The draft takes no edits while a Save of it is under way. */
const frozen = new Compartment()

export function freezeConfig(view: EditorView, on: boolean): void {
  view.dispatch({ effects: frozen.reconfigure(EditorState.readOnly.of(on)) })
}

export function showConfigValue(view: EditorView, shown: { id: number; secondsLeft: number } | null): void {
  view.dispatch({ effects: [setShown.of(shown), ...(shown ? [shownMask.of(shown.id)] : [])] })
}

/** The hidden value on the caret's line, for Ctrl+R. */
export function maskOnCaretLine(view: EditorView): number | null {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return view.state.field(maskField).masks.find((mask) => mask.from <= line.to && mask.to >= line.from)?.id ?? null
}

export function draftMarks(state: EditorState): LineMarks {
  return state.field(marksField)
}

export function draftDirty(state: EditorState): boolean {
  const marks = state.field(marksField)
  return marks.changed.size > 0 || marks.added.size > 0 || marks.removed > 0
}
