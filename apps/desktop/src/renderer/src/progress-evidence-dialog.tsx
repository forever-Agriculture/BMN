// MODULE: progress-evidence-dialog.tsx - read-only detail of one progress observation and the files behind it
import { useEffect, useRef, useState } from 'react'
import type { ArtifactRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import {
  ImageViewport,
  artifactIcon,
  formatBytes,
  originalStateLabel,
  useArtifactPreview
} from './artifact-presentation'
import { agedProgress, type ProgressPresentation } from './session-presentation'

interface EvidenceRow {
  artifactId: string
  /** The name the report recorded, kept even after the original is gone. */
  name: string
  artifact: ArtifactRecord | null
  ready: boolean
  /** The right-hand column: type and size when it is there, why not when it is not. */
  availability: string
}

/**
 * How one referenced file reads. A report may outlive its files, so four things can be wrong with a
 * row and each says so plainly: the original is gone, its bytes no longer match, the artifact is no
 * longer listed at all, or its type has no inline preview. None of them is an error state of the
 * *report*, which is why they are muted rather than red.
 */
export function evidenceRows(
  evidence: ProgressPresentation['evidence'],
  artifacts: readonly ArtifactRecord[]
): EvidenceRow[] {
  return evidence.map((link) => {
    const artifact = artifacts.find((record) => record.artifactId === link.artifactId) ?? null
    if (!artifact) {
      return { artifactId: link.artifactId, name: link.name, artifact: null, ready: false, availability: 'Removed from Files' }
    }
    if (artifact.state !== 'ready') {
      return {
        artifactId: link.artifactId,
        name: link.name,
        artifact,
        ready: false,
        availability: originalStateLabel(artifact.state)
      }
    }
    return {
      artifactId: link.artifactId,
      name: link.name,
      artifact,
      ready: true,
      availability: `${artifact.mediaType} · ${formatBytes(artifact.byteLength)}`
    }
  })
}

/** "Reported verified · from agent · 5 min ago", in the voice `attentionProvenance` uses for requests. */
export function progressProvenance(progress: ProgressPresentation): string {
  return `${progress.word} · from ${progress.source} · ${progress.age}`
}

/**
 * The detail behind one progress observation: who reported what, when, and which already-published
 * files they pointed at. It reads and it previews; it starts nothing, types nothing into a terminal
 * and resolves no request. It is a modal dialog rather than a region under the strip because the
 * pane's `ResizeObserver` would turn any in-flow growth into a real PTY resize.
 *
 * What is shown is a snapshot taken when the detail opened. A newer report never swaps itself in
 * underneath the owner: it announces itself in a banner and waits to be asked. The old snapshot's
 * files stay previewable by ID even after the store has dropped their links, because the artifacts
 * themselves are untouched.
 */
export function ProgressEvidenceDialog(props: {
  sessionName: string
  /** The observation the owner opened, frozen at that moment. */
  opened: ProgressPresentation
  /** The newest observation for the same session and process now, or null once there is none. */
  current: ProgressPresentation | null
  /** Why this detail must close itself instead of describing a session that is gone. */
  gone: 'session' | 'process' | null
  artifacts: readonly ArtifactRecord[]
  /** The shell's clock, so a detail left open keeps telling the truth about how old the report is. */
  now: number
  onClose(): void
  onAnnounce(message: string): void
  onFailure(message: string): void
  onNotice(message: string): void
}): React.JSX.Element {
  const [opened, setSnapshot] = useState<ProgressPresentation>(props.opened)
  // The words are frozen at open; the age is not, or a detail left open keeps saying "0 s ago".
  const snapshot = agedProgress(opened, props.now)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const firstRow = useRef<HTMLButtonElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  const onAnnounce = useRef(props.onAnnounce)
  const onClose = useRef(props.onClose)
  onAnnounce.current = props.onAnnounce
  onClose.current = props.onClose

  // Two reports can carry the same `observedAt` — a caller repeating `--observed`, a replayed script —
  // so the stored time decides as well. Missing a replacement would leave stale files on screen.
  const replaced = props.current !== null && (
    props.current.observedAt !== opened.observedAt ||
    props.current.receivedAt !== opened.receivedAt ||
    props.current.source !== opened.source
  )
  const replacement = replaced ? props.current : null
  const rows = evidenceRows(snapshot.evidence, props.artifacts)
  const selected = rows.find((row) => row.artifactId === selectedId && row.ready) ?? null
  const { preview, error: previewError, loading: previewLoading } = useArtifactPreview(selected?.artifactId ?? null)

  useEffect(() => {
    if (!props.gone) return
    onAnnounce.current(props.gone === 'session'
      ? 'Progress details closed: the session is gone.'
      : 'Progress details closed: the process restarted.')
    onClose.current()
  }, [props.gone])

  useEffect(() => {
    if (!replacement) return
    onAnnounce.current('A newer progress report replaced the one you opened.')
  }, [replacement?.observedAt, replacement?.receivedAt])

  function showNewest(): void {
    if (!replacement) return
    setSnapshot(replacement)
    setSelectedId(null)
    // Focus lands where the new content starts, so a keyboard reader is not left on a vanished row.
    requestAnimationFrame(() => (firstRow.current ?? noteRef.current)?.focus())
  }

  async function run(key: string, action: () => Promise<void>, fallback: string): Promise<void> {
    setPending((current) => new Set(current).add(key))
    try {
      await action()
    } catch (error) {
      props.onFailure(failureDetail(error, fallback))
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  function previewBody(row: EvidenceRow): React.JSX.Element {
    if (previewError) return <p className="files-preview-message files-preview-error">Preview unavailable: {previewError}</p>
    if (previewLoading || !preview) return <p className="files-preview-message">Loading preview…</p>
    if (preview.kind === 'image' && preview.content) {
      return (
        <ImageViewport
          src={`data:${preview.mediaType};base64,${preview.content}`}
          alt={row.name}
          size="inline"
          onExpand={null}
        />
      )
    }
    if (preview.kind === 'text') {
      return (
        <div className="files-preview-text">
          <pre>{preview.content ?? ''}</pre>
          {preview.truncated && <p className="files-preview-note">Preview truncated</p>}
        </div>
      )
    }
    return <p className="files-preview-message">No inline preview for this type. Open or save a copy.</p>
  }

  return (
    <Dialog label={`Progress — ${props.sessionName}`} onClose={props.onClose} className="progress-evidence-dialog">
      <p className="dialog-note">
        What {snapshot.source} reported. BMN keeps the files it attached; it does not check the work.
      </p>
      {replacement ? (
        <div className="progress-replaced" role="status">
          <span>Replaced · a newer report arrived: {progressProvenance(replacement)}</span>
          <button type="button" onClick={showNewest}>Show newest</button>
        </div>
      ) : null}
      <h3>{snapshot.label}</h3>
      <p className="provenance">
        {progressProvenance(snapshot)}
        {snapshot.stale ? <span className="stale">stale</span> : null}
      </p>
      {snapshot.detail ? <pre className="detail">{snapshot.detail}</pre> : null}
      {rows.length === 0 ? (
        <p className="dialog-note" ref={noteRef} tabIndex={-1}>No evidence attached to this report.</p>
      ) : (
        <>
          <span className="eyebrow">Evidence · {rows.length}</span>
          <ul className="progress-evidence" aria-label="Evidence">
            {rows.map((row, index) => (
              <li key={`${row.artifactId}-${index}`} className={row.ready ? undefined : 'unavailable'}>
                <span className="icon" aria-hidden="true">{artifactIcon(row.artifact?.mediaType ?? '')}</span>
                <span className="name">{row.name}</span>
                <span className="availability">{row.availability}</span>
                {row.ready ? (
                  <span className="actions">
                    <button
                      type="button"
                      ref={index === 0 ? firstRow : undefined}
                      aria-pressed={selectedId === row.artifactId}
                      onClick={() => setSelectedId(selectedId === row.artifactId ? null : row.artifactId)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      disabled={pending.has(`open:${row.artifactId}`)}
                      onClick={() => void run(`open:${row.artifactId}`, async () => {
                        await window.aiTerminal.openArtifact(row.artifactId)
                      }, 'Could not open the file')}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      disabled={pending.has(`save:${row.artifactId}`)}
                      onClick={() => void run(`save:${row.artifactId}`, async () => {
                        const result = await window.aiTerminal.saveArtifactAs(row.artifactId)
                        if (result.saved !== null) props.onNotice(`Saved a copy to ${result.saved}`)
                      }, 'Could not save a copy')}
                    >
                      Save a copy
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {rows.some((row) => !row.ready) ? (
            <p className="dialog-note">Unavailable files change nothing about the report.</p>
          ) : null}
        </>
      )}
      {selected ? <div className="files-preview-box">{previewBody(selected)}</div> : null}
    </Dialog>
  )
}
