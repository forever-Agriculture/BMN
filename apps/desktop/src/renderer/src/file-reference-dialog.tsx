// MODULE: file-reference-dialog.tsx - read-only overlay for a local file reference: path, base, line context and actions
import { useEffect, useRef, useState } from 'react'
import { formatFileReference, type FileReferenceReadResult } from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Dialog } from './dialog'
import { baseDescription, byteSize, previewLines } from './file-reference-presentation'

/** Captured when the action starts: the session and its launch directory never follow later focus. */
export interface FileReferenceRequest {
  sessionId: string
  sessionName: string
  workspaceName: string
  /** Shown before the first read; the utility reports the directory it actually used. */
  launchDirectory: string
  reference: string
  /** A terminal link opens at once; typed or prefilled text waits for Open. */
  openNow: boolean
}

export function FileReferenceDialog(props: { request: FileReferenceRequest; onClose(): void }): React.JSX.Element {
  const { request } = props
  const [entered, setEntered] = useState(request.reference)
  const [chosenBase, setChosenBase] = useState<string | null>(null)
  const [result, setResult] = useState<FileReferenceReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const marked = useRef<HTMLElement>(null)
  /** Only the latest read may show; an answer to an earlier one is dropped. */
  const readCount = useRef(0)

  const read = (reference: string, baseDirectory: string | null): void => {
    const count = ++readCount.current
    setBusy(true)
    setError(null)
    setFeedback('')
    window.aiTerminal.readFileReference({ sessionId: request.sessionId, reference, baseDirectory })
      .then((next) => {
        if (count === readCount.current) setResult(next)
      })
      .catch((failure: unknown) => {
        if (count !== readCount.current) return
        setResult(null)
        setError(failureDetail(failure, 'The file reference could not be opened.'))
      })
      .finally(() => {
        if (count === readCount.current) setBusy(false)
      })
  }

  useEffect(() => {
    if (request.openNow) read(request.reference, null)
  }, [])

  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' })
  }, [result])

  const chooseBase = (): void => {
    void window.aiTerminal.chooseFileReferenceBase().then((folder) => {
      if (!folder) return
      setChosenBase(folder)
      read(entered, folder)
    }).catch((failure: unknown) => setError(failureDetail(failure, 'The folder picker is unavailable.')))
  }

  const snapshot = result?.status === 'ready' ? result : null
  const shownBase = result
    ? baseDescription(result.base)
    : baseDescription(chosenBase
      ? { kind: 'chosen-directory', path: chosenBase }
      : { kind: 'launch-directory', path: request.launchDirectory })
  const filePath = result ? result.canonicalPath ?? result.resolvedPath : null
  const throughSymlink = result?.canonicalPath && result.canonicalPath !== result.resolvedPath ? result.resolvedPath : null
  const preview = snapshot ? previewLines(snapshot) : null

  return (
    <Dialog label="File reference" className="file-reference-dialog" onClose={props.onClose}>
      <form className="file-reference-entry" onSubmit={(event) => {
        event.preventDefault()
        read(entered, chosenBase)
      }}>
        <label>Reference
          <input
            aria-label="File reference"
            className="mono"
            placeholder="src/parser.ts:42:7"
            spellCheck={false}
            value={entered}
            onChange={(event) => setEntered(event.target.value)}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>Open</button>
      </form>
      <dl className="file-reference-meta">
        <dt>Session</dt>
        <dd>{request.sessionName} · {request.workspaceName}</dd>
        <dt>{shownBase.label}</dt>
        <dd>
          {shownBase.path ? <span className="mono">{shownBase.path}</span> : <span>no base folder needed</span>}
          <span className="file-reference-base-actions">
            <button type="button" className="ghost" onClick={chooseBase}>Choose folder…</button>
            {chosenBase ? (
              <button type="button" className="ghost" onClick={() => {
                setChosenBase(null)
                read(entered, null)
              }}>Use launch directory</button>
            ) : null}
          </span>
        </dd>
        {filePath ? (
          <>
            <dt>File</dt>
            <dd className="mono file-reference-path">{filePath}</dd>
          </>
        ) : null}
        {throughSymlink ? (
          <>
            <dt>Through symlink</dt>
            <dd className="mono file-reference-path">{throughSymlink}</dd>
          </>
        ) : null}
      </dl>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {result?.status === 'unavailable' ? <p className="inline-error" role="alert">{result.message}</p> : null}
      {snapshot && preview ? (
        <>
          <p className="file-reference-status" role="status">
            {preview.position} · snapshot read {new Date(snapshot.readAt).toLocaleTimeString()} · {byteSize(snapshot.byteLength)} ·
            read-only; Refresh reads it again
          </p>
          {preview.lineCount === 0 ? <p className="file-reference-status">The file is empty.</p> : (
            <div className="file-reference-preview" role="region" aria-label="Read-only file contents" tabIndex={0}>
              <pre className="file-reference-gutter" aria-hidden="true">{preview.gutter}</pre>
              <pre className="file-reference-code">
                {preview.before}
                {preview.target !== null ? (
                  <mark ref={marked} className="file-reference-line">{preview.target || ' '}</mark>
                ) : null}
                {preview.after}
              </pre>
            </div>
          )}
        </>
      ) : null}
      <div className="dialog-actions file-reference-actions">
        <span className="file-reference-feedback" aria-live="polite">{feedback}</span>
        <button type="button" disabled={!result || busy} onClick={() => result && read(result.reference, chosenBase)}>Refresh</button>
        <button type="button" disabled={!snapshot} onClick={() => {
          if (!snapshot) return
          const text = formatFileReference(snapshot.canonicalPath, snapshot.line, snapshot.column)
          void window.aiTerminal.writeClipboardText(text)
            .then(() => setFeedback('Reference copied.'))
            .catch((failure: unknown) => setError(failureDetail(failure, 'Copy failed.')))
        }}>Copy reference</button>
        <button type="button" disabled={!snapshot} onClick={() => {
          if (!snapshot) return
          void window.aiTerminal.showFileReference(snapshot.canonicalPath)
            .then(() => setFeedback('Shown in the file manager.'))
            .catch((failure: unknown) => setError(failureDetail(failure, 'Show in folder failed.')))
        }}>Show in folder</button>
        <button type="button" className="ghost" onClick={props.onClose}>Close</button>
      </div>
    </Dialog>
  )
}
