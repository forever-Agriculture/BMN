// MODULE: quick-look-save-bar.tsx - the Save bar of an edited file, and the one row that takes its place for a question: unsaved edits on the way out, a file changed on disk, a failed save, an invalid config (Stories 68.1, 68.2)
import { useEffect, useRef } from 'react'

/** What stands in the Save bar's place, if anything other than the bar. */
export type SaveRow =
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  /** The bytes on disk are no longer the ones read (AC6). */
  | { kind: 'conflict' }
  /** A way out with unsaved edits: Save, Discard, Keep editing (AC8). */
  | { kind: 'guard'; then: () => void; keep?: () => void }
  /** A config draft that does not parse, at Ctrl+S (Story 68.2 AC6). */
  | { kind: 'invalid'; words: string }

/** A row that asks: Esc means Keep editing while it is on screen. */
export const asksQuestion = (row: SaveRow | null): boolean => row?.kind === 'guard' || row?.kind === 'conflict' || row?.kind === 'invalid'

export function SaveBar(props: {
  path: string
  summary: string
  row: SaveRow | null
  onSave(): void
  onSaveInvalid(): void
  onDiscard(): void
  onKeep(): void
  onReview(): void
}): React.JSX.Element {
  const keep = useRef<HTMLButtonElement>(null)
  const row = props.row
  // Keep editing is in focus whenever a question is asked, so Enter or Esc leaves everything as it is.
  useEffect(() => {
    if (asksQuestion(row)) keep.current?.focus()
  }, [row])
  if (row?.kind === 'guard') {
    return (
      <div className="ql-save ql-save-ask" role="alertdialog" aria-label="Unsaved edits">
        <div className="ql-save-text"><span className="ql-save-eyebrow">Unsaved edits</span><span className="ql-save-path"><bdi>{props.path}</bdi></span></div>
        <button type="button" onClick={props.onSave}>Save</button>
        <button type="button" onClick={props.onDiscard}>Discard</button>
        <button ref={keep} type="button" className="primary" onClick={props.onKeep}>Keep editing</button>
      </div>
    )
  }
  if (row?.kind === 'conflict') {
    return (
      <div className="ql-save ql-save-ask" role="alertdialog" aria-label="Save blocked">
        <div className="ql-save-text"><span className="ql-save-eyebrow ql-refused">Changed on disk · Save blocked</span><span className="ql-save-what">Your draft is kept. Nothing was written.</span></div>
        <button type="button" onClick={props.onReview}>Review latest</button>
        <button ref={keep} type="button" className="primary" onClick={props.onKeep}>Keep editing</button>
      </div>
    )
  }
  if (row?.kind === 'invalid') {
    return (
      <div className="ql-save ql-save-ask" role="alertdialog" aria-label="Invalid file">
        <div className="ql-save-text"><span className="ql-save-eyebrow ql-refused">{row.words}</span><span className="ql-save-what">Ctrl+S saves only a file that parses.</span></div>
        <button ref={keep} type="button" className="primary" onClick={props.onKeep}>Keep editing</button>
        <button type="button" onClick={props.onSaveInvalid}>Save invalid file</button>
      </div>
    )
  }
  return (
    <div className="ql-save" role="region" aria-label="Save">
      <div className="ql-save-text">
        <span className="ql-save-eyebrow">Save writes to</span>
        <span className={`ql-save-what${row?.kind === 'failed' ? ' ql-refused' : ''}`}>{row?.kind === 'failed' ? row.message : row?.kind === 'saving' ? 'Saving…' : props.summary}</span>
        <span className="ql-save-path"><bdi>{props.path}</bdi></span>
      </div>
      <button type="button" onClick={props.onDiscard} disabled={row?.kind === 'saving'}>Discard</button>
      <button type="button" className="primary" onClick={props.onSave} disabled={row?.kind === 'saving'}>Save <kbd>Ctrl S</kbd></button>
    </div>
  )
}
