// MODULE: quick-look-code.ts - the read-only CodeMirror view Quick look shows a file in: greys only, the target line in gold
import { standardKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { type Language, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import type { QuickLookLanguage, SecretRange } from '@bmn/protocol'
import type { FindMatch } from './quick-look-find'
import { maskedSlice } from './quick-look-secrets'

/**
 * Syntax as classes, never colours: quick-look.css draws each class from the colour mode's own text and ground (Story
 * 67.1 AC7). A definition is full text, a literal the one straw tint (owner 2026-10-18, Fable's "ink and one tint"),
 * a name, a keyword, punctuation and a comment each a grey step down; no weight or slant in code.
 */
export const greys = tagHighlighter([
  { tag: [tags.definition(tags.variableName), tags.function(tags.definition(tags.variableName)), tags.definition(tags.propertyName),
    tags.definition(tags.typeName), tags.className, tags.heading, tags.macroName], class: 'ql-syn-def' },
  { tag: [tags.string, tags.special(tags.string), tags.number, tags.bool, tags.null, tags.regexp, tags.atom, tags.escape,
    tags.inserted, tags.deleted, tags.url, tags.character, tags.unit], class: 'ql-syn-literal' },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword,
    tags.self, tags.processingInstruction], class: 'ql-syn-keyword' },
  { tag: [tags.punctuation, tags.bracket, tags.operator, tags.separator, tags.derefOperator, tags.angleBracket], class: 'ql-syn-punct' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta], class: 'ql-syn-comment' },
  { tag: [tags.strong], class: 'ql-syn-strong' },
  { tag: [tags.emphasis], class: 'ql-syn-emphasis' }
])

/** YAML's plain values (`done`, `in-progress`) are its literals; Markdown's body text, the same tag, stays plain. */
const yamlValues = tagHighlighter([{ tag: tags.content, class: 'ql-syn-literal' }])

/** Syntax classes for a language: every language's, and YAML's plain values as literals. */
export function syntaxClasses(language: QuickLookLanguage | null): Extension {
  return language === 'yaml' ? [syntaxHighlighting(greys), syntaxHighlighting(yamlValues)] : syntaxHighlighting(greys)
}

/** The colour set for each language Quick look colours; any other text is plain. */
export function languageExtension(language: QuickLookLanguage | null): Extension {
  switch (language) {
    case 'typescript': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'javascript': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'json':
    case 'jsonc': return json()
    case 'yaml': return yaml()
    case 'toml': return StreamLanguage.define(toml)
    case 'markdown': return markdown()
    case 'css': return css()
    case 'html': return html({ autoCloseTags: false })
    case 'python': return python()
    case 'rust': return rust()
    case 'go': return go()
    case 'sql': return sql()
    case 'shell': return StreamLanguage.define(shell)
    case 'dockerfile': return StreamLanguage.define(dockerFile)
    case 'diff': return StreamLanguage.define(diff)
    default: return []
  }
}

/** The parser of a language Quick look colours, for a Markdown page's code blocks; null for plain text. */
function languageOf(language: QuickLookLanguage | null): Language | null {
  const support = languageExtension(language)
  return support && typeof support === 'object' && 'language' in support ? (support as { language: Language }).language
    : support instanceof StreamLanguage ? support : null
}

/** A code block's coloured stretches, as places in the file (its text begins at `from`), with the same grey classes. */
export function codeTokens(text: string, language: QuickLookLanguage | null, from: number): { from: number; to: number; className: string }[] {
  const parser = languageOf(language)?.parser
  if (!parser || !text) return []
  const tokens: { from: number; to: number; className: string }[] = []
  highlightTree(parser.parse(text), greys, (start, end, className) => tokens.push({ from: from + start, to: from + end, className }))
  return tokens
}

export interface CodeViewInput {
  content: string
  language: QuickLookLanguage | null
  /** The line he came for, 1-based; marked in gold and scrolled to the middle. */
  line: number | null
  column: number | null
  /** The line kept at the top, as a reload or a remembered place keeps it; the target line is then not centred. */
  topLine?: number | null
  label: string
  /** The values hidden from the first frame, so a secret is never drawn before its plate. */
  secrets?: SecretView
  onRevealSecret?: (index: number) => void
}

/** Find's matches, each on a plate, the current one on a stronger plate (Story 67.2 AC1). */
const setFindMarks = StateEffect.define<{ matches: readonly FindMatch[]; current: number }>()
const matchMark = Decoration.mark({ class: 'ql-match' })
const currentMatchMark = Decoration.mark({ class: 'ql-match ql-match-current' })

const findMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setFindMarks)) continue
      const length = transaction.state.doc.length
      return Decoration.set(effect.value.matches.filter((match) => match.to <= length)
        .map((match, index) => (index === effect.value.current ? currentMatchMark : matchMark).range(match.from, match.to)))
    }
    return marks
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** Marks find's matches; with `reveal`, selects the current one and scrolls it to the middle. */
export function showFindMatches(view: EditorView, matches: readonly FindMatch[], current: number, reveal: boolean): void {
  const match = matches[current]
  view.dispatch({
    effects: [setFindMarks.of({ matches, current }), ...(reveal && match ? [EditorView.scrollIntoView(match.from, { y: 'center' })] : [])],
    ...(reveal && match ? { selection: EditorSelection.range(match.from, match.to) } : {})
  })
}

/** What the view hides: the stretches, the one shown now, and how many seconds it has left (Story 67.3). */
export interface SecretView {
  ranges: readonly SecretRange[]
  revealed: number | null
  secondsLeft: number
}

const NO_SECRETS: SecretView = { ranges: [], revealed: null, secondsLeft: 0 }
const setSecrets = StateEffect.define<SecretView>()
/** One fixed width for every hidden value, so the plate says nothing about its length; the note at the edge does. */
const DOTS = '\u2022'.repeat(12)

class HiddenValue extends WidgetType {
  constructor(readonly length: number) {
    super()
  }

  override eq(other: HiddenValue): boolean {
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

function secretMarks(secrets: SecretView, length: number): DecorationSet {
  return Decoration.set(secrets.ranges.flatMap(([start, end], index) => {
    if (end <= start || end > length) return []
    return [index === secrets.revealed
      ? Decoration.mark({ class: 'ql-secret-shown' }).range(start, end)
      : Decoration.replace({ widget: new HiddenValue(end - start) }).range(start, end)]
  }))
}

const secretState = StateField.define<{ secrets: SecretView; marks: DecorationSet }>({
  create: () => ({ secrets: NO_SECRETS, marks: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSecrets)) return { secrets: effect.value, marks: secretMarks(effect.value, transaction.state.doc.length) }
    }
    return value
  },
  // The caret steps over a hidden value as over one character, so it never sits inside one.
  provide: (field) => [EditorView.decorations.from(field, (value) => value.marks), EditorView.atomicRanges.of((view) => view.state.field(field).marks)]
})

/** Shows which values are hidden and which one is shown, with its seconds left. */
export function showSecrets(view: EditorView, secrets: SecretView): void {
  view.dispatch({ effects: setSecrets.of(secrets) })
}

const EYE = 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'

interface SecretNote {
  index: number
  top: number
  height: number
  length: number
  shown: boolean
}

/**
 * The note at the right edge of a line that holds a hidden value: its length and an eye, or "Shown · hides in 8 s".
 * Drawn in a layer over the view, not in the line, so it stays at the edge while long lines scroll sideways.
 */
function secretNotes(onReveal: (index: number) => void): Extension {
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
      if (update.viewportChanged || update.geometryChanged || update.transactions.some((each) => each.effects.some((effect) => effect.is(setSecrets)))) {
        this.schedule()
      }
    }

    schedule(): void {
      this.view.requestMeasure({ key: this, read: (view) => this.measure(view), write: (notes) => this.draw(notes) })
    }

    measure(view: EditorView): { notes: SecretNote[]; secondsLeft: number } {
      const { secrets } = view.state.field(secretState)
      const origin = view.dom.getBoundingClientRect().top
      const box = view.scrollDOM.getBoundingClientRect()
      const notes: SecretNote[] = []
      secrets.ranges.forEach(([start, end], index) => {
        if (end < view.viewport.from || start > view.viewport.to) return
        const block = view.lineBlockAt(start)
        const top = block.top + view.documentTop - origin
        if (top + block.height <= box.top - origin || top >= box.bottom - origin) return
        notes.push({ index, top, height: block.height, length: end - start, shown: index === secrets.revealed })
      })
      return { notes, secondsLeft: secrets.secondsLeft }
    }

    draw({ notes, secondsLeft }: { notes: SecretNote[]; secondsLeft: number }): void {
      this.layer.replaceChildren(...notes.map((note) => {
        const row = document.createElement('div')
        row.className = `ql-secret-note${note.shown ? ' shown' : ''}`
        row.style.top = `${note.top}px`
        row.style.height = `${note.height}px`
        const label = document.createElement('span')
        label.textContent = note.shown ? `Shown · hides in ${secondsLeft} s` : `${note.length} chars`
        const eye = document.createElement('button')
        eye.type = 'button'
        eye.className = 'ql-eye'
        eye.setAttribute('aria-label', note.shown ? 'Hide this value' : 'Show this value for 10 seconds')
        eye.setAttribute('aria-pressed', String(note.shown))
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
        eye.addEventListener('click', () => onReveal(note.index))
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

/**
 * A copy or cut of a selection that holds a hidden value puts "[secret hidden]" in its place; with no selection,
 * the caret's line is copied, as the view does by itself. A selection dragged out of the view carries the same text.
 */
const maskedCopy = EditorView.domEventHandlers({
  copy: (event, view) => copyMasked(event, view),
  cut: (event, view) => copyMasked(event, view),
  dragstart: (event, view) => dragMasked(event, view)
})

function dragMasked(event: DragEvent, view: EditorView): boolean {
  const { secrets } = view.state.field(secretState)
  const chosen = view.state.selection.ranges.filter((range) => !range.empty)
  if (secrets.ranges.length === 0 || chosen.length === 0 || !event.dataTransfer) return false
  const text = view.state.doc.toString()
  event.dataTransfer.clearData()
  event.dataTransfer.setData('text/plain', chosen.map((range) => maskedSlice(text, secrets.ranges, range.from, range.to, secrets.revealed)).join(view.state.lineBreak))
  event.dataTransfer.effectAllowed = 'copy'
  return true
}

function copyMasked(event: ClipboardEvent, view: EditorView): boolean {
  const { secrets } = view.state.field(secretState)
  if (secrets.ranges.length === 0 || !event.clipboardData) return false
  const text = view.state.doc.toString()
  const chosen = view.state.selection.ranges.filter((range) => !range.empty)
  const parts = chosen.length > 0
    ? chosen.map((range) => maskedSlice(text, secrets.ranges, range.from, range.to, secrets.revealed))
    : view.state.selection.ranges.map((range) => {
      const line = view.state.doc.lineAt(range.head)
      return `${maskedSlice(text, secrets.ranges, line.from, line.to, secrets.revealed)}`
    })
  event.clipboardData.setData('text/plain', parts.join(view.state.lineBreak) + (chosen.length > 0 ? '' : view.state.lineBreak))
  event.preventDefault()
  return true
}

/** The line the caret is on. */
export function caretLine(view: EditorView): number {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

/** Moves the caret to a line and column and puts that line in the middle. */
export function goToPosition(view: EditorView, line: number, column: number | null): void {
  const at = positionOf(view.state, line, column)
  view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: 'center' }) })
}

/** The document position of a 1-based line and column, clamped into the document. */
export function positionOf(state: EditorState, line: number, column: number | null): number {
  const target = state.doc.line(Math.min(Math.max(1, line), state.doc.lines))
  return Math.min(target.from + Math.max(0, (column ?? 1) - 1), target.to)
}

/**
 * A view that reads only: the file can be focused, walked with the arrows and selected, never changed. Long lines
 * scroll sideways; nothing wraps. No worker is started and nothing is evaluated: CodeMirror draws only the lines in
 * view, so a 2 MiB file stays light.
 */
export function createCodeView(parent: HTMLElement, input: CodeViewInput, extra: Extension = []): EditorView {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    highlightActiveLine(),
    EditorState.readOnly.of(true),
    EditorState.tabSize.of(4),
    keymap.of(standardKeymap),
    languageExtension(input.language),
    syntaxClasses(input.language),
    findMarks,
    secretState.init(() => {
      const secrets = input.secrets ?? NO_SECRETS
      return { secrets, marks: secretMarks(secrets, input.content.length) }
    }),
    secretNotes((index) => input.onRevealSecret?.(index)),
    maskedCopy,
    EditorView.contentAttributes.of({ 'aria-label': input.label, 'aria-readonly': 'true' }),
    extra
  ]
  // The text is split into lines once, with no extensions, to place the target line's mark.
  const doc = EditorState.create({ doc: input.content }).doc
  if (input.line !== null && input.line >= 1 && input.line <= doc.lines) {
    extensions.push(EditorView.decorations.of(Decoration.set([Decoration.line({ class: 'ql-target' }).range(doc.line(input.line).from)])))
  }
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) })
  const target = input.line !== null && input.line >= 1 ? positionOf(view.state, input.line, input.column) : null
  if (input.topLine && input.topLine >= 1) {
    // A reload or a remembered place keeps the line that was at the top; the target line stays marked.
    const top = positionOf(view.state, input.topLine, 1)
    view.dispatch({ selection: EditorSelection.cursor(target ?? top), effects: EditorView.scrollIntoView(top, { y: 'start', yMargin: 0 }) })
  } else if (target !== null) {
    view.dispatch({ selection: EditorSelection.cursor(target), effects: EditorView.scrollIntoView(target, { y: 'center' }) })
  }
  return view
}

/** The first line whose top is in view, for keeping a place across a reload. */
export function topVisibleLine(view: EditorView): number {
  // The scroller's top edge, measured from the document's top: both in window coordinates, so scrolling is included.
  const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop))
  return view.state.doc.lineAt(block.from).number
}
