// MODULE: files-panel.tsx - the Files side panel: artifact preview/actions and addressed input drafts
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ArtifactPreview,
  ArtifactRecord,
  ArtifactState,
  InputDraftRecord,
  SessionRecord
} from '@ai-terminal/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import {
  clampPan,
  fitScale,
  zoomAt,
  type Point,
  type Size,
  type ViewportState
} from './image-viewport'
import './files-panel.css'

const ZOOM_STEP = 1.25
const WHEEL_ZOOM_STEP = 1.1
const PAN_STEP = 40
const ATTACH_KEY = 'attach'

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatBytes(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return '—'
  if (byteLength < 1024) return `${byteLength} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = byteLength / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}

function originLabel(artifact: ArtifactRecord): string {
  return artifact.source === 'owner' ? 'Attached by owner' : `Published by ${artifact.source}`
}

function originalStateLabel(state: ArtifactState): string {
  switch (state) {
    case 'ready':
      return 'Available locally'
    case 'missing':
      return 'Original unavailable'
    case 'corrupt':
      return 'Integrity check failed'
  }
}

function artifactIcon(mediaType: string): string {
  if (mediaType.startsWith('image/')) return '▣'
  if (mediaType.startsWith('text/')) return '≡'
  return '▤'
}

/** A pure zoom/pan image viewport (math lives in `image-viewport.ts`); `onExpand` is null inside the expanded overlay. */
function ImageViewport(props: {
  src: string
  alt: string
  size: 'inline' | 'expanded'
  onExpand: (() => void) | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const naturalSizeRef = useRef<Size | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startPan: Point } | null>(null)

  const [naturalSize, setNaturalSize] = useState<Size | null>(null)
  const [fitMode, setFitMode] = useState(true)
  const [view, setView] = useState<ViewportState>({ scale: 1, pan: { x: 0, y: 0 } })

  useEffect(() => {
    naturalSizeRef.current = naturalSize
  }, [naturalSize])

  useEffect(() => {
    setNaturalSize(null)
    setFitMode(true)
    setView({ scale: 1, pan: { x: 0, y: 0 } })
  }, [props.src])

  function containerSize(): Size {
    const rect = containerRef.current?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : { width: 1, height: 1 }
  }

  function applyFit(image: Size): void {
    setFitMode(true)
    setView({ scale: fitScale(image, containerSize()), pan: { x: 0, y: 0 } })
  }

  function zoomBy(factor: number, point: Point = { x: 0, y: 0 }): void {
    const image = naturalSizeRef.current
    if (!image) return
    setFitMode(false)
    setView((current) => {
      const zoomed = zoomAt(current, factor, point)
      return { scale: zoomed.scale, pan: clampPan(zoomed.pan, image, containerSize(), zoomed.scale) }
    })
  }

  function panBy(dx: number, dy: number): void {
    const image = naturalSizeRef.current
    if (!image) return
    setView((current) => ({
      ...current,
      pan: clampPan({ x: current.pan.x + dx, y: current.pan.y + dy }, image, containerSize(), current.scale)
    }))
  }

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const point = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
      zoomBy(event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP, point)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  function onImgLoad(event: React.SyntheticEvent<HTMLImageElement>): void {
    const image = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }
    setNaturalSize(image)
    applyFit(image)
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (!naturalSizeRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startPan: view.pan }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    const image = naturalSizeRef.current
    if (!drag || drag.pointerId !== event.pointerId || !image) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const pan = clampPan({ x: drag.startPan.x + dx, y: drag.startPan.y + dy }, image, containerSize(), view.scale)
    setView((current) => ({ ...current, pan }))
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!naturalSizeRef.current) return
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    } else if (event.key === '0') {
      event.preventDefault()
      applyFit(naturalSizeRef.current)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      panBy(-PAN_STEP, 0)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      panBy(PAN_STEP, 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      panBy(0, -PAN_STEP)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      panBy(0, PAN_STEP)
    }
  }

  const scaled = naturalSize ? { width: naturalSize.width * view.scale, height: naturalSize.height * view.scale } : null
  const box = containerSize()
  const pannable = scaled ? scaled.width > box.width + 0.5 || scaled.height > box.height + 0.5 : false
  const zoomPercent = naturalSize ? Math.round(view.scale * 100) : 100

  return (
    <div className={`files-image-viewport files-image-viewport--${props.size}`}>
      <div
        ref={containerRef}
        className={`files-image-surface${pannable ? ' is-pannable' : ''}`}
        tabIndex={0}
        role="group"
        aria-label={`${props.alt} preview`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <img
          src={props.src}
          alt={props.alt}
          draggable={false}
          onLoad={onImgLoad}
          className="files-image-surface-img"
          style={
            naturalSize
              ? {
                  width: `${scaled?.width ?? naturalSize.width}px`,
                  height: `${scaled?.height ?? naturalSize.height}px`,
                  transform: `translate(-50%, -50%) translate(${view.pan.x}px, ${view.pan.y}px)`
                }
              : { visibility: 'hidden' }
          }
        />
      </div>
      <div className="files-image-toolbar">
        <button type="button" aria-pressed={fitMode} disabled={!naturalSize} onClick={() => naturalSizeRef.current && applyFit(naturalSizeRef.current)}>
          Fit
        </button>
        <button
          type="button"
          aria-pressed={!fitMode && view.scale === 1}
          disabled={!naturalSize}
          onClick={() => {
            setFitMode(false)
            setView({ scale: 1, pan: { x: 0, y: 0 } })
          }}
        >
          Original size
        </button>
        <button type="button" className="icon-button" aria-label="Zoom out" disabled={!naturalSize} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <span className="files-image-zoom-pct">{zoomPercent}%</span>
        <button type="button" className="icon-button" aria-label="Zoom in" disabled={!naturalSize} onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        {props.onExpand && (
          <button type="button" className="icon-button files-image-expand" aria-label="Expand image" onClick={props.onExpand}>
            ⤢
          </button>
        )}
      </div>
    </div>
  )
}

export function FilesPanel(props: {
  session: SessionRecord | null
  sessionLabel: string
  sessionLive: boolean
  artifacts: ArtifactRecord[]
  drafts: InputDraftRecord[]
  onClose(): void
  onFailure(message: string): void
  onNotice(message: string): void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const featured = useMemo<ArtifactRecord | null>(() => {
    if (props.artifacts.length === 0) return null
    if (selectedId) {
      const found = props.artifacts.find((artifact) => artifact.artifactId === selectedId)
      if (found) return found
    }
    return props.artifacts[0] ?? null
  }, [props.artifacts, selectedId])

  const earlier = useMemo<ArtifactRecord[]>(
    () => (featured ? props.artifacts.filter((artifact) => artifact.artifactId !== featured.artifactId) : []),
    [props.artifacts, featured]
  )

  const featuredId = featured?.artifactId ?? null

  useEffect(() => {
    setExpanded(false)
    if (!featuredId) {
      setPreview(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    let cancelled = false
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)
    window.aiTerminal.previewArtifact(featuredId).then(
      (result) => {
        if (cancelled) return
        setPreview(result)
        setPreviewLoading(false)
      },
      (error: unknown) => {
        if (cancelled) return
        setPreviewError(failureDetail(error, 'Preview unavailable'))
        setPreviewLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [featuredId])

  function isPending(key: string): boolean {
    return pending.has(key)
  }

  async function run(key: string, action: () => Promise<void>, failureFallback: string): Promise<void> {
    setPending((current) => new Set(current).add(key))
    try {
      await action()
    } catch (error) {
      props.onFailure(failureDetail(error, failureFallback))
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
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
      <header className="files-panel-header">
        <h2>Files</h2>
        <span className="files-count">{props.artifacts.length}</span>
        <span className="files-session-name">{props.sessionLabel}</span>
        <button type="button" className="icon-button files-close" aria-label="Close files" onClick={props.onClose}>
          ×
        </button>
      </header>

      {props.artifacts.length === 0 ? (
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
                      if (result.saved !== null) props.onNotice(`Saved a copy to ${result.saved}`)
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
                    }, 'Could not show the file in its folder')
                  }}
                >
                  {isPending(`show:${featured.artifactId}`) ? 'Revealing…' : 'Show in Folder'}
                </button>
                <button
                  type="button"
                  disabled={!props.sessionLive || !props.session || isPending(`deliver:${featured.artifactId}`)}
                  title={props.sessionLive ? undefined : 'Deliver needs a live session'}
                  onClick={() => {
                    const artifactId = featured.artifactId
                    const session = props.session
                    if (!session) return
                    void run(`deliver:${artifactId}`, async () => {
                      await window.aiTerminal.deliverArtifact(artifactId, session.sessionId)
                      props.onNotice(`Path pasted into ${props.sessionLabel}. Nothing was submitted.`)
                    }, 'Could not deliver the file')
                  }}
                >
                  {isPending(`deliver:${featured.artifactId}`) ? 'Delivering…' : 'Deliver to session'}
                </button>
              </div>
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

      {props.drafts.length > 0 && (
        <section className="files-drafts" aria-label="Drafts">
          <p className="eyebrow">Drafts</p>
          <ul className="files-draft-list">
            {props.drafts.map((draft) => {
              const artifact = draft.artifactId ? props.artifacts.find((item) => item.artifactId === draft.artifactId) ?? null : null
              const typeKey = `draft-type:${draft.draftId}`
              const sendKey = `draft-send:${draft.draftId}`
              const discardKey = `draft-discard:${draft.draftId}`
              const busy = isPending(typeKey) || isPending(sendKey) || isPending(discardKey)
              return (
                <li key={draft.draftId} className="files-draft">
                  <p className="files-draft-meta">
                    {draft.origin} · {formatClock(draft.createdAt)} · {draft.state}
                  </p>
                  <pre className="files-draft-text">{draft.text ?? ''}</pre>
                  {artifact && <p className="files-draft-artifact">Attached: {artifact.originalName}</p>}
                  <div className="files-draft-actions">
                    <button
                      type="button"
                      disabled={!props.sessionLive || busy}
                      onClick={() => {
                        void run(typeKey, async () => {
                          await window.aiTerminal.sendDraft(draft.draftId, false)
                        }, 'Could not type the draft into the session')
                      }}
                    >
                      {isPending(typeKey) ? 'Typing…' : 'Type into session'}
                    </button>
                    <button
                      type="button"
                      disabled={!props.sessionLive || busy}
                      onClick={() => {
                        void run(sendKey, async () => {
                          await window.aiTerminal.sendDraft(draft.draftId, true)
                        }, 'Could not send the draft')
                      }}
                    >
                      {isPending(sendKey) ? 'Sending…' : 'Send with Enter'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void run(discardKey, async () => {
                          await window.aiTerminal.discardDraft(draft.draftId)
                        }, 'Could not discard the draft')
                      }}
                    >
                      {isPending(discardKey) ? 'Discarding…' : 'Discard'}
                    </button>
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
