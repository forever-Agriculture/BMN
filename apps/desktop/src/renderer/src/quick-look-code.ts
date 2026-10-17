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
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { tagHighlighter, tags } from '@lezer/highlight'
import type { QuickLookLanguage } from '@bmn/protocol'

/**
 * Syntax as classes, never colours: quick-look.css draws each class in a grey derived from the colour mode's own
 * text and ground (Story 67.1 AC7). A definition and a literal are full text; a name, a keyword, punctuation and a
 * comment each a step down.
 */
const greys = tagHighlighter([
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

export interface CodeViewInput {
  content: string
  language: QuickLookLanguage | null
  /** The line he came for, 1-based; marked in gold and scrolled to the middle. */
  line: number | null
  column: number | null
  /** The line shown at the top instead, as a reload keeps it. */
  topLine?: number | null
  label: string
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
    highlightSpecialChars(),
    drawSelection(),
    EditorState.readOnly.of(true),
    EditorState.tabSize.of(4),
    keymap.of(standardKeymap),
    languageExtension(input.language),
    syntaxHighlighting(greys),
    EditorView.contentAttributes.of({ 'aria-label': input.label, 'aria-readonly': 'true' }),
    extra
  ]
  // The text is split into lines once, with no extensions, to place the target line's mark.
  const doc = EditorState.create({ doc: input.content }).doc
  if (input.line !== null && input.line >= 1 && input.line <= doc.lines) {
    extensions.push(EditorView.decorations.of(Decoration.set([Decoration.line({ class: 'ql-target' }).range(doc.line(input.line).from)])))
  }
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) })
  if (input.line !== null && input.line >= 1) {
    const at = positionOf(view.state, input.line, input.column)
    view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: 'center' }) })
  } else if (input.topLine && input.topLine > 1) {
    const at = positionOf(view.state, input.topLine, 1)
    view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: 'start' }) })
  }
  return view
}

/** The first line whose top is in view, for keeping a place across a reload. */
export function topVisibleLine(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentTop + view.scrollDOM.getBoundingClientRect().top)
  return view.state.doc.lineAt(block.from).number
}
