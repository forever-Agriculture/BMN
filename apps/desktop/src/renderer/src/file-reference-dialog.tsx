// MODULE: file-reference-dialog.tsx - read-only overlay for a local file reference: path, base, line context and actions
import { useEffect, useRef, useState } from 'react'
import { exactAbsoluteFileReference, formatFileReference, type FileReferenceReadResult } from '@bmn/protocol'
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

export interface FileReferenceSendTarget {
  sessionId: string
  sessionName: string
  workspaceName: string
  harness: string
  path: string
  incarnationId: string | null
}

export function FileReferenceDialog(props: {
  request: FileReferenceRequest
  targets: FileReferenceSendTarget[]
  onClose(): void
}): React.JSX.Element {
  const { request } = props
  const [entered, setEntered] = useState(request.reference)
  const [chosenBase, setChosenBase] = useState<string | null>(null)
  const [result, setResult] = useState<FileReferenceReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const marked = useRef<HTMLElement>(null)
  const sending = useRef(false)
  const [sendTarget, setSendTarget] = useState<(FileReferenceSendTarget & { requestId: string }) | null>(null)
  const [sendPreview, setSendPreview] = useState(false)
  /** Only the latest read may show; an answer to an earlier one is dropped. */
  const readCount = useRef(0)

  const read = (reference: string, baseDirectory: string | null): void => {
    const count = ++readCount.current
    setSendTarget(null)
    setSendPreview(false)
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

  useEffect(() => {
    const lostFocus = (): void => {
      setSendTarget(null)
      setSendPreview(false)
    }
    window.addEventListener('blur', lostFocus)
    return () => window.removeEventListener('blur', lostFocus)
  }, [])

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
  const sendPayload = snapshot
    ? exactAbsoluteFileReference(snapshot.canonicalPath, snapshot.line, snapshot.column)
    : null

  const send = (): void => {
    if (!sendTarget || !snapshot || !sendPayload || !sendPreview || sending.current || busy) return
    sending.current = true
    setBusy(true)
    setError(null)
    void window.aiTerminal.pasteFileReference({
      requestId: sendTarget.requestId,
      sessionId: sendTarget.sessionId,
      expectedIncarnationId: sendTarget.incarnationId ?? '',
      sourcePath: snapshot.canonicalPath,
      line: snapshot.line,
      column: snapshot.column
    }).then((receipt) => {
      setFeedback(`${receipt.payload} pasted to ${sendTarget.sessionName} — not submitted.`)
      setSendTarget(null)
      setSendPreview(false)
    }).catch((failure: unknown) => {
      setError(failureDetail(failure, 'The destination changed; choose it again.'))
      setSendTarget(null)
      setSendPreview(false)
    }).finally(() => {
      sending.current = false
      setBusy(false)
    })
  }

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
            <strong className="file-reference-position">{preview.position}</strong> · snapshot read {new Date(snapshot.readAt).toLocaleTimeString()} · {byteSize(snapshot.byteLength)} ·
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
      {snapshot ? (
        <div className="file-reference-send">
          <label>Send to session
            <select aria-label="Send to session" disabled={busy} value={sendTarget?.sessionId ?? ''} onChange={(event) => {
              const target = props.targets.find((item) => item.sessionId === event.target.value)
              setSendTarget(target ? { ...target, requestId: crypto.randomUUID() } : null)
              setSendPreview(false)
              setFeedback('')
              setError(null)
            }}>
              <option value="">Choose a session…</option>
              {props.targets.map((target) => (
                <option key={target.sessionId} value={target.sessionId}>
                  {target.workspaceName} › {target.sessionName} · {target.harness} · {target.path}
                </option>
              ))}
            </select>
          </label>
          {sendTarget && !sendPreview ? (
            <button type="button" disabled={busy || !sendTarget.incarnationId || !sendPayload} onClick={() => setSendPreview(true)}>
              Review send…
            </button>
          ) : null}
          {sendTarget && !sendTarget.incarnationId ? <p>The selected session is not running. Start it, then choose it again.</p> : null}
          {!sendPayload ? <p>This path cannot be represented by the file-reference grammar; choose another file.</p> : null}
          {sendTarget && sendPreview && sendPayload ? (
            <div className="file-reference-send-preview" role="region" aria-label="Send reference preview">
              <p>Exact text to append to the input:</p>
              <pre>{sendPayload}</pre>
              <p>{sendTarget.workspaceName} › {sendTarget.sessionName} · {sendTarget.harness} · {sendTarget.path}</p>
              <p>Process: <span className="mono">{sendTarget.incarnationId}</span></p>
              <p>BMN appends this text without pressing Enter.</p>
              <button type="button" className="primary" disabled={busy} onClick={send}>Paste reference</button>
            </div>
          ) : null}
        </div>
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
