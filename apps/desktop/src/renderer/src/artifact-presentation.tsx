// MODULE: artifact-presentation.tsx - how a stored original is named, sized, iconed, previewed and viewed
import { useEffect, useRef, useState } from 'react'
import type { ArtifactPreview, ArtifactState } from '@bmn/protocol'
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

export function formatBytes(byteLength: number): string {
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

export function originalStateLabel(state: ArtifactState): string {
  switch (state) {
    case 'ready':
      return 'Available locally'
    case 'missing':
      return 'Original unavailable'
    case 'corrupt':
      return 'Integrity check failed'
  }
}

export function artifactIcon(mediaType: string): string {
  if (mediaType.startsWith('image/')) return '▣'
  if (mediaType.startsWith('text/')) return '≡'
  return '▤'
}

/** A pure zoom/pan image viewport (math lives in `image-viewport.ts`); `onExpand` is null inside the expanded overlay. */
export function ImageViewport(props: {
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

export interface ArtifactPreviewState {
  preview: ArtifactPreview | null
  error: string | null
  loading: boolean
}

/**
 * Reads one stored original's preview through the existing bridge, and nothing else: no bytes are
 * copied anywhere, and a null id simply shows nothing. Both the Files panel and the progress
 * evidence dialog use it, so an unreadable or unsupported original is explained the same way twice.
 */
export function useArtifactPreview(artifactId: string | null): ArtifactPreviewState {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!artifactId) {
      setPreview(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setPreview(null)
    setError(null)
    setLoading(true)
    window.aiTerminal.previewArtifact(artifactId).then(
      (result) => {
        if (cancelled) return
        setPreview(result)
        setLoading(false)
      },
      (failure: unknown) => {
        if (cancelled) return
        setError(failureDetail(failure, 'Preview unavailable'))
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [artifactId])

  return { preview, error, loading }
}
