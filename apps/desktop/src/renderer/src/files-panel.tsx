// MODULE: files-panel.tsx - the Files side panel: artifact preview/actions and addressed input drafts (no handoff since Story 75.5)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type ArtifactRecord,
  type InputDraftRecord,
  type SessionRecord,
  type WorkspaceRecord
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import {
  ImageViewport,
  artifactIcon,
  formatBytes,
  originalStateLabel,
  useArtifactPreview
} from './artifact-presentation'
import './files-panel.css'

const ATTACH_KEY = 'attach'

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function originLabel(artifact: ArtifactRecord): string {
  return artifact.source === 'owner' ? 'Attached by owner' : `Published by ${artifact.source}`
}

export function FilesPanel(props: {
  session: SessionRecord | null
  sessionLabel: string
  sessionLive: boolean
  sessionIncarnationId: string | null
  artifacts: ArtifactRecord[]
  drafts: InputDraftRecord[]
  sessions: SessionRecord[]
  workspaces: WorkspaceRecord[]
  onRefreshDrafts(): Promise<void>
  onClose(): void
  onFailure(message: string): void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [outcomes, setOutcomes] = useState<Record<string, { text: string; failed: boolean }>>({})
  const [announcement, setAnnouncement] = useState('')
  const [expanded, setExpanded] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    // Files opens over the terminal; do not leave keyboard focus on a covered pane button.
    closeButton.current?.focus({ preventScroll: true })
  }, [])

  const sessionArtifacts = useMemo(
    () => props.artifacts.filter((artifact) => artifact.sessionId === props.session?.sessionId),
    [props.artifacts, props.session?.sessionId]
  )
  const sessionDescription = (sessionId: string | null): string => {
    const record = sessionId ? props.sessions.find((session) => session.sessionId === sessionId) : undefined
    if (!record) return 'Removed session'
    const workspace = props.workspaces.find((item) => item.workspaceId === record.workspaceId)
    const state = record.sessionId === props.session?.sessionId
      ? props.sessionLive ? 'live' : 'stopped'
      : record.lastProcess?.state === 'live' ? 'live' : 'stopped'
    return `${workspace?.name ?? 'Removed workspace'} › ${record.name} (saved name) · ${record.cwd} · ${state}`
  }

  const drafts = props.drafts.filter((draft) => draft.origin !== 'handoff' && draft.sessionId === props.session?.sessionId)

  const featured = useMemo<ArtifactRecord | null>(() => {
    if (sessionArtifacts.length === 0) return null
    if (selectedId) {
      const found = sessionArtifacts.find((artifact) => artifact.artifactId === selectedId)
      if (found) return found
    }
    return sessionArtifacts[0] ?? null
  }, [sessionArtifacts, selectedId])

  const earlier = useMemo<ArtifactRecord[]>(
    () => (featured ? sessionArtifacts.filter((artifact) => artifact.artifactId !== featured.artifactId) : []),
    [sessionArtifacts, featured]
  )

  const featuredId = featured?.artifactId ?? null

  useEffect(() => {
    setSelectedId(null)
  }, [props.session?.sessionId])

  const { preview, error: previewError, loading: previewLoading } = useArtifactPreview(featuredId)

  useEffect(() => {
    setExpanded(false)
  }, [featuredId])

  function isPending(key: string): boolean {
    return pending.has(key)
  }

  async function run(key: string, action: () => Promise<void>, failureFallback: string): Promise<void> {
    if (pendingRef.current.has(key)) return
    pendingRef.current.add(key)
    setPending((current) => new Set(current).add(key))
    setOutcomes((current) => ({ ...current, [key]: { text: 'Working…', failed: false } }))
    try {
      await action()
    } catch (error) {
      const text = failureDetail(error, failureFallback)
      setOutcomes((current) => ({ ...current, [key]: { text, failed: true } }))
      props.onFailure(text)
    } finally {
      pendingRef.current.delete(key)
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  function outcome(key: string, text: string, savedKey = key): void {
    setOutcomes((current) => {
      const next = { ...current, [savedKey]: { text, failed: false } }
      if (savedKey !== key) delete next[key]
      return next
    })
    // Keep one mounted announcement even when saving closes the form or the same result repeats.
    setAnnouncement('')
    requestAnimationFrame(() => setAnnouncement(text))
  }

  function actionOutcome(key: string): React.JSX.Element | null {
    const result = outcomes[key]
    return result ? <p className={result.failed ? 'inline-error files-action-outcome' : 'files-action-outcome'}>{result.text}</p> : null
  }

  function renderPreviewBody(artifact: ArtifactRecord): React.JSX.Element {
    if (previewError) return <p className="files-preview-message files-preview-error">Preview unavailable: {previewError}</p>
    if (previewLoading || !preview) return <p className="files-preview-message">Loading preview…</p>
    if (preview.kind === 'image' && preview.content) {
      return (
        <ImageViewport
          src={`data:${preview.mediaType};base64,${preview.content}`}
          alt={artifact.originalName}
          size="inline"
          onExpand={() => setExpanded(true)}
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

  const attachDisabled = !props.session || isPending(ATTACH_KEY)

  return (
    <aside className="files-panel" aria-label="Files">
      <div className="live-announcer files-action-announcer" role="status" aria-atomic="true">{announcement}</div>
      <header className="files-panel-header">
        <h2>Files</h2>
        <span className="files-count">{sessionArtifacts.length}</span>
        <span className="files-session-name">{props.sessionLabel}</span>
        <button ref={closeButton} type="button" className="icon-button files-close" aria-label="Close files" onClick={props.onClose}>
          ×
        </button>
      </header>

      {sessionArtifacts.length === 0 ? (
        <div className="files-empty">
          <p>No artifacts yet.</p>
          <button
            type="button"
            disabled={attachDisabled}
            onClick={() => {
              const session = props.session
              if (!session) return
              void run(ATTACH_KEY, async () => {
                await window.aiTerminal.attachFiles(session.sessionId)
              }, 'Could not attach files')
            }}
          >
            {isPending(ATTACH_KEY) ? 'Attaching…' : 'Attach files'}
          </button>
        </div>
      ) : (
        featured && (
          <>
            <section className="files-featured" aria-label="Featured artifact">
              <div className="files-preview-box">{renderPreviewBody(featured)}</div>
              <p className="files-featured-name">{featured.originalName}</p>
              <p className="files-featured-meta">
                {originLabel(featured)} · {formatClock(featured.createdAt)}
              </p>
              <div className="files-featured-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={isPending(`open:${featured.artifactId}`)}
                  onClick={() => {
                    const artifactId = featured.artifactId
                    void run(`open:${artifactId}`, async () => {
                      await window.aiTerminal.openArtifact(artifactId)
                      outcome(`open:${artifactId}`, 'Open requested')
                    }, 'Could not open the file')
                  }}
                >
                  {isPending(`open:${featured.artifactId}`) ? 'Opening…' : 'Open'}
                </button>
                <button
                  type="button"
                  disabled={isPending(`save:${featured.artifactId}`)}
                  onClick={() => {
                    const artifactId = featured.artifactId
                    void run(`save:${artifactId}`, async () => {
                      const result = await window.aiTerminal.saveArtifactAs(artifactId)
                      outcome(`save:${artifactId}`, result.saved === null ? 'Save cancelled. No copy made.' : `Saved a copy to ${result.saved}`)
                    }, 'Could not save a copy')
                  }}
                >
                  {isPending(`save:${featured.artifactId}`) ? 'Saving…' : 'Save As'}
                </button>
                <button
                  type="button"
                  disabled={isPending(`show:${featured.artifactId}`)}
                  onClick={() => {
                    const artifactId = featured.artifactId
                    void run(`show:${artifactId}`, async () => {
                      await window.aiTerminal.showArtifact(artifactId)
                      outcome(`show:${artifactId}`, 'Show in Folder requested')
                    }, 'Could not show the file in its folder')
                  }}
                >
                  {isPending(`show:${featured.artifactId}`) ? 'Revealing…' : 'Show in Folder'}
                </button>
                <button
                  type="button"
                  disabled={!props.sessionLive || !props.sessionIncarnationId || !props.session || isPending(`deliver:${featured.artifactId}`)}
                  title={props.sessionLive ? undefined : 'Deliver needs a live session'}
                  onClick={() => {
                    const artifactId = featured.artifactId
                    const session = props.session
                    if (!session) return
                    void run(`deliver:${artifactId}`, async () => {
                      const result = await window.aiTerminal.deliverArtifact(artifactId, session.sessionId, props.sessionIncarnationId!)
                      outcome(`deliver:${artifactId}`, `Recorded paste at ${formatClock(result.pastedAt)}: ${result.path} into ${sessionDescription(session.sessionId)}. This file is pasted once while this process stays open. Not submitted; press Enter separately.`)
                    }, 'Could not deliver the file')
                  }}
                >
                  {isPending(`deliver:${featured.artifactId}`) ? 'Delivering…' : 'Deliver to session'}
                </button>
              </div>
              <p className="deliver-note">Deliver destination: {sessionDescription(props.session?.sessionId ?? null)}. {!props.sessionLive ? 'Deliver needs a live destination.' : 'Appends the path without Enter.'}</p>
              {(['open', 'save', 'show', 'deliver'] as const).map((action) => <div key={action}>{actionOutcome(`${action}:${featured.artifactId}`)}</div>)}
              <div className="files-meta-rows">
                <div className="files-meta-row">
                  <span className="files-meta-label">Type</span>
                  <span className="files-meta-value">{featured.mediaType}</span>
                </div>
                <div className="files-meta-row">
                  <span className="files-meta-label">Size</span>
                  <span className="files-meta-value">{formatBytes(featured.byteLength)}</span>
                </div>
                <div className="files-meta-row">
                  <span className="files-meta-label">Original</span>
                  <span className="files-meta-value">{originalStateLabel(featured.state)}</span>
                </div>
                <div className="files-meta-row">
                  <span className="files-meta-label">Direction</span>
                  <span className="files-meta-value">{featured.direction}</span>
                </div>
              </div>
            </section>

            {earlier.length > 0 && (
              <section className="files-earlier" aria-label="Earlier artifacts">
                <p className="eyebrow">Earlier</p>
                <ul className="files-earlier-list">
                  {earlier.map((artifact) => (
                    <li key={artifact.artifactId}>
                      <button type="button" className="files-earlier-row" onClick={() => setSelectedId(artifact.artifactId)}>
                        <span className="files-earlier-icon" aria-hidden="true">
                          {artifactIcon(artifact.mediaType)}
                        </span>
                        <span className="files-earlier-info">
                          <span className="files-earlier-name">{artifact.originalName}</span>
                          <span className="files-earlier-detail">
                            {artifact.mediaType} · {formatBytes(artifact.byteLength)} · {formatClock(artifact.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}

      {drafts.length > 0 && (
        <section className="files-drafts" aria-label="Drafts">
          <p className="eyebrow">Drafts</p>
          <ul className="files-draft-list">
            {drafts.map((draft) => {
              const artifact = draft.artifactId ? props.artifacts.find((item) => item.artifactId === draft.artifactId) ?? null : null
              const typeKey = `draft-type:${draft.draftId}`
              const sendKey = `draft-send:${draft.draftId}`
              const discardKey = `draft-discard:${draft.draftId}`
              const retryKey = `draft-retry:${draft.draftId}`
              const busy = isPending(typeKey) || isPending(sendKey) || isPending(discardKey) || isPending(retryKey)
              return (
                <li key={draft.draftId} className="files-draft">
                  <p className="files-draft-meta">{draft.origin} · {formatClock(draft.createdAt)} · {draft.state}</p>
                  <pre className="files-draft-text">{draft.text ?? ''}</pre>
                  {artifact && <p className="files-draft-artifact">Attached: {artifact.originalName}</p>}
                  {draft.state === 'uncertain' ? <p>Input may already have reached this session. Check its terminal before creating a retry.</p> : null}
                  <div className="files-draft-actions">
                    <button type="button" disabled={draft.state !== 'draft' || !props.sessionLive || busy} onClick={() => {
                      void run(typeKey, async () => {
                        await window.aiTerminal.sendDraft(draft.draftId, false, {
                          ...(props.sessionIncarnationId ? { expectedIncarnationId: props.sessionIncarnationId } : {}),
                          expectedUpdatedAt: draft.updatedAt
                        })
                      }, 'Could not type the draft into the session')
                    }}>{isPending(typeKey) ? 'Typing…' : 'Type into session'}</button>
                    <button type="button" disabled={draft.state !== 'draft' || !props.sessionLive || busy} onClick={() => {
                      void run(sendKey, async () => {
                        await window.aiTerminal.sendDraft(draft.draftId, true, {
                          ...(props.sessionIncarnationId ? { expectedIncarnationId: props.sessionIncarnationId } : {}),
                          expectedUpdatedAt: draft.updatedAt
                        })
                      }, 'Could not send the draft')
                    }}>{isPending(sendKey) ? 'Sending…' : 'Send with Enter'}</button>
                    {draft.state === 'uncertain' ? <button type="button" disabled={busy} onClick={() => {
                      void run(retryKey, async () => {
                        await window.aiTerminal.retryDraft(draft.draftId)
                        await props.onRefreshDrafts()
                      }, 'Could not create a retry draft')
                    }}>{isPending(retryKey) ? 'Creating retry…' : 'Create retry draft'}</button> : null}
                    <button type="button" disabled={busy} onClick={() => {
                      void run(discardKey, async () => {
                        await window.aiTerminal.discardDraft(draft.draftId)
                      }, 'Could not discard the draft')
                    }}>{isPending(discardKey) ? 'Discarding…' : 'Discard'}</button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {expanded && featured && preview && preview.kind === 'image' && preview.content && (
        <Dialog label={`Preview ${featured.originalName}`} className="image-preview-dialog" onClose={() => setExpanded(false)}>
          <ImageViewport
            src={`data:${preview.mediaType};base64,${preview.content}`}
            alt={featured.originalName}
            size="expanded"
            onExpand={null}
          />
        </Dialog>
      )}
    </aside>
  )
}
