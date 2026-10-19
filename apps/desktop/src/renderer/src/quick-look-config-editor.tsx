// MODULE: quick-look-config-editor.tsx - the edit mode of a config file in the Quick look sheet: the draft, its ten-second reveal, the syntax line 300 ms after typing stops, and a draft carried onto the file as it is now (Story 68.2)
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorSelection, Text, type ChangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { quickLookFileType, quickLookName } from '@bmn/protocol'
import { draftChanges, lineSummary, maskField, rebaseConfigDraft, type Mask } from './quick-look-config-edit'
import { topVisibleLine } from './quick-look-code'
import { createConfigEditor, draftDirty, draftMarks, freezeConfig, maskOnCaretLine, maskedDraft, showConfigValue } from './quick-look-config-view'
import { REVEAL_SECONDS, quickLookSecretRanges } from './quick-look-secrets'
import { checkSyntax, syntaxWords, type ConfigFormat, type SyntaxVerdict } from './quick-look-syntax'

/** Syntax is checked this long after the last key (AC5). */
const SYNTAX_WAIT_MS = 300

/** Where the reader was when edit mode opened: its caret and the line at its top (1-based); null when unknown. */
export interface EditStart {
  caret: number | null
  top: number | null
}

/** The reader's caret when it is on screen, else null: a caret scrolled out of view would pull the draft back to it. */
export function shownCaret(view: EditorView | null): number | null {
  if (!view) return null
  const head = view.state.selection.main.head
  const at = view.coordsAtPos(head)
  const box = view.scrollDOM.getBoundingClientRect()
  return at && at.top >= box.top && at.bottom <= box.bottom ? head : null
}

/** Puts the caret and the line at the top where the reader had them, clamped to the text (owner 2026-10-19: E jumped to the top). */
function keepPlace(view: EditorView, start: EditStart): void {
  const doc = view.state.doc
  const top = start.top !== null && start.top >= 1 ? doc.line(Math.min(start.top, doc.lines)).from : null
  // With no caret on screen it goes to the top line, so the first arrow key does not jump back to the file's start.
  const caret = start.caret === null ? top : Math.min(Math.max(0, start.caret), doc.length)
  if (caret === null && top === null) return
  view.dispatch({
    ...(caret === null ? {} : { selection: EditorSelection.cursor(caret) }),
    ...(top === null ? {} : { effects: EditorView.scrollIntoView(top, { y: 'start', yMargin: 0 }) })
  })
}

export interface ConfigEditorHandle {
  /** The text to save, with the file's line endings. */
  text(): string
  /** The draft with every hidden value as "[secret hidden]", for the test hook. */
  masked(): string
  /** The syntax line for the draft as it is now. */
  verdict(): SyntaxVerdict
  focus(): void
  /** Ctrl+R: shows or hides the hidden value on the caret's line; false when there is none. */
  revealAtCaret(): boolean
  hide(): void
  /** Carries the draft onto the file's text as it is now; false when both changed the same lines. */
  carry(latest: string): boolean
}

export interface ConfigDraftState {
  dirty: boolean
  summary: string
  syntax: string | null
  valid: boolean | null
}

export const ConfigEditor = forwardRef<ConfigEditorHandle, {
  path: string
  canonicalPath: string
  /** The file's text with one `\n` per line ending. */
  content: string
  format: ConfigFormat
  lineEnding: '\n' | '\r\n'
  focus: boolean
  /** Where the reader was; the draft opens there. */
  start: EditStart
  /** The line at the top, reported as the draft scrolls, so leaving edit mode keeps the place. */
  onTop(line: number): void
  /** A Save of the draft is under way: it takes no edits until the answer. */
  frozen: boolean
  onDraft(state: ConfigDraftState): void
  onNote(words: string): void
  /** A value is shown for its ten seconds, or no longer. */
  onShown(shown: boolean): void
  onFocus(): void
}>(function ConfigEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const shown = useRef<{ id: number; until: number } | null>(null)
  const ticker = useRef(0)
  const syntaxTimer = useRef(0)
  const callbacks = useRef({ onDraft: props.onDraft, onNote: props.onNote, onShown: props.onShown, onTop: props.onTop })
  callbacks.current = { onDraft: props.onDraft, onNote: props.onNote, onShown: props.onShown, onTop: props.onTop }
  const topFrame = useRef(0)
  const reportTop = (current: EditorView): void => {
    cancelAnimationFrame(topFrame.current)
    topFrame.current = requestAnimationFrame(() => { if (view.current === current && current.dom.isConnected) callbacks.current.onTop(topVisibleLine(current)) })
  }

  const report = (current: EditorView, syntax: SyntaxVerdict | null): void => {
    callbacks.current.onDraft({
      dirty: draftDirty(current.state),
      summary: lineSummary(draftMarks(current.state)),
      syntax: syntax ? syntaxWords(props.format, syntax) : null,
      valid: syntax ? syntax.status === 'valid' : null
    })
  }

  const hide = (): void => {
    window.clearInterval(ticker.current)
    if (shown.current) callbacks.current.onShown(false)
    shown.current = null
    if (view.current) showConfigValue(view.current, null)
  }

  const reveal = (id: number): void => {
    const current = view.current
    if (!current) return
    if (shown.current?.id === id) {
      hide()
      return
    }
    window.clearInterval(ticker.current)
    shown.current = { id, until: Date.now() + REVEAL_SECONDS * 1000 }
    callbacks.current.onShown(true)
    const tick = (): void => {
      const left = shown.current ? Math.ceil((shown.current.until - Date.now()) / 1000) : 0
      if (left <= 0 || !view.current) hide()
      else showConfigValue(view.current, { id, secondsLeft: Math.min(REVEAL_SECONDS, left) })
    }
    tick()
    ticker.current = window.setInterval(tick, 250)
  }

  /** Builds the view on a text, with a carried draft's history of edits when there is one. */
  const mount = (content: string, carried?: { original: Text; changes: ChangeSet; masks: readonly Mask[] }): EditorView | null => {
    if (!host.current) return null
    view.current?.destroy()
    const type = quickLookFileType(props.path)
    // A carried draft keeps its masks, and whatever the other program wrote is masked as any value is.
    const ranges = quickLookSecretRanges(props.path, props.canonicalPath, content)
    const created = createConfigEditor(host.current, {
      content, format: props.format, language: type.language, ranges, label: `${quickLookName(props.path)}, editing`,
      find: (text) => quickLookSecretRanges(props.path, props.canonicalPath, text),
      ...(carried ? { carried } : {}),
      onUpdate: (update) => {
        if (!update.docChanged) return
        if (update.transactions.some((tr) => tr.isUserEvent('input.paste'))) callbacks.current.onNote('Paste, masked')
        report(update.view, null)
        window.clearTimeout(syntaxTimer.current)
        syntaxTimer.current = window.setTimeout(() => {
          if (view.current === update.view) report(update.view, checkSyntax(props.format, update.view.state.doc.toString()))
        }, SYNTAX_WAIT_MS)
      },
      onRefused: (words) => callbacks.current.onNote(words),
      onReveal: reveal
    })
    view.current = created
    created.scrollDOM.addEventListener('scroll', () => reportTop(created), { passive: true })
    report(created, checkSyntax(props.format, created.state.doc.toString()))
    return created
  }

  useEffect(() => {
    const created = mount(props.content)
    if (created) keepPlace(created, props.start)
    if (props.focus) created?.focus()
    return () => {
      cancelAnimationFrame(topFrame.current)
      window.clearInterval(ticker.current)
      window.clearTimeout(syntaxTimer.current)
      view.current?.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    if (props.focus) view.current?.focus()
  }, [props.focus])

  useEffect(() => {
    if (view.current) freezeConfig(view.current, props.frozen)
  }, [props.frozen])

  useImperativeHandle(ref, () => ({
    // The editor splits a paste at any line break; the saved text ends every line as the file does.
    text: () => view.current?.state.doc.sliceString(0, undefined, props.lineEnding) ?? '',
    masked: () => (view.current ? maskedDraft(view.current.state) : ''),
    verdict: () => checkSyntax(props.format, view.current?.state.doc.toString() ?? ''),
    focus: () => view.current?.focus(),
    revealAtCaret: () => {
      const id = view.current ? maskOnCaretLine(view.current) : null
      if (id === null) return false
      reveal(id)
      return true
    },
    hide,
    carry: (latest) => {
      const current = view.current
      if (!current) return false
      const { original, changes } = current.state.field(draftChanges)
      const carried = rebaseConfigDraft(original, changes, current.state.field(maskField).masks, Text.of(latest.split('\n')))
      if (!carried) return false
      hide()
      const next = mount(carried.text.toString(), {
        original: Text.of(latest.split('\n')), changes: carried.changes, masks: carried.masks
      })
      next?.focus()
      return true
    }
  }), [props.format, props.lineEnding])

  return <div className="ql-code ql-editing" ref={host} onFocus={props.onFocus} />
})
