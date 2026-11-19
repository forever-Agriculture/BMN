// MODULE: brain-graph.tsx - A note's neighbourhood as plain SVG on fixed orbits: one rAF tween, labels that never touch, one Tab stop (Epic 128 design.md frame 3)
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { BrainGraph } from '@bmn/protocol'
import { graphStep, kindColour, layoutGraph, placeLabels, tweenPoints, LABEL_SIZE, TWEEN_MOVE_MS, TWEEN_NEW_MS, type GraphPoint } from './brain-graph-layout'

let canvas: CanvasRenderingContext2D | null | undefined
/** A label's width in the page's own font; a fixed estimate where no canvas exists (tests). */
export function measureLabel(text: string): number {
  if (canvas === undefined) {
    try {
      canvas = document.createElement('canvas').getContext('2d')
      if (canvas) canvas.font = `${LABEL_SIZE}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`
    } catch { canvas = null }
  }
  return canvas ? canvas.measureText(text).width : text.length * 6.6
}

const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function BrainGraphView(props: {
  graph: BrainGraph
  selected: string | null
  reducedMotion?: boolean | undefined
  onSelect(id: string): void
  onRefocus(id: string): void
  onMore(): void
}): React.JSX.Element {
  const well = useRef<HTMLDivElement>(null)
  const key = useRef<HTMLUListElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const drawn = useRef<Map<string, GraphPoint>>(new Map())
  const [points, setPoints] = useState<Map<string, GraphPoint>>(new Map())

  useLayoutEffect(() => {
    const element = well.current
    if (!element) return
    // The kind key sits under the drawing: the rings and labels keep above it, however many lines the key wraps to.
    const measure = (): void => {
      const below = key.current ? key.current.offsetHeight + 16 : 0
      setSize({ width: Math.max(160, Math.floor(element.clientWidth)), height: Math.max(160, Math.floor(element.clientHeight - below)) })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (key.current) observer.observe(key.current)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => layoutGraph(props.graph, size.width || 640, size.height || 480), [props.graph, size.width, size.height])

  // G4: one requestAnimationFrame tween; new nodes leave their parent in 240 ms, moved ones take 300 ms; reduced motion draws one frame.
  useLayoutEffect(() => {
    const target = new Map(layout.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
    const from = drawn.current
    const still = props.reducedMotion ?? prefersReducedMotion()
    if (still || from.size === 0 && layout.nodes.length === 1) { drawn.current = target; setPoints(target); return }
    const fresh = new Set(layout.nodes.filter((node) => !from.has(node.id)).map((node) => node.id))
    // The first drawing grows out of the focus.
    const origin = from.size ? from : new Map([[props.graph.focus, layout.centre]])
    const start = performance.now()
    let frame = 0
    const step = (now: number): void => {
      const elapsed = now - start
      const moved = tweenPoints(origin, layout.nodes, elapsed / TWEEN_MOVE_MS)
      const grown = tweenPoints(origin, layout.nodes, elapsed / TWEEN_NEW_MS)
      const next = new Map([...moved].map(([id, point]) => [id, fresh.has(id) ? grown.get(id)! : point]))
      drawn.current = next
      setPoints(next)
      if (elapsed < TWEEN_MOVE_MS) frame = requestAnimationFrame(step)
      else { drawn.current = target; setPoints(target) }
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [layout, props.reducedMotion, props.graph.focus])

  const labels = useMemo(() => placeLabels(layout, { selected: props.selected, hovered, measure: measureLabel }), [layout, props.selected, hovered])
  const at = (id: string): GraphPoint => points.get(id) ?? layout.nodes.find((node) => node.id === id) ?? layout.centre
  const lifted = (id: string): boolean => id === hovered || id === props.selected
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    const current = cursor ?? props.selected ?? props.graph.focus
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      setCursor(graphStep(layout, current, event.key))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) props.onRefocus(current)
      else props.onSelect(current)
    }
  }
  const title = (id: string): string => props.graph.nodes.find((node) => node.id === id)?.title ?? ''
  const active = cursor ?? props.selected

  return (
    <div className="b-graph-well" ref={well}>
      <svg className="b-graph" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} tabIndex={0}
        role="application" aria-roledescription="graph" aria-label={`Links around ${title(props.graph.focus)}: ${props.graph.nodes.length} notes. Arrows move, Enter shows beside, Shift Enter refocuses.`}
        onKeyDown={onKeyDown} onBlur={() => setCursor(null)} data-depth={props.graph.depth} data-focus={props.graph.focus} data-at-rest={points.size === layout.nodes.length && layout.nodes.every((node) => { const p = points.get(node.id); return p && p.x === node.x && p.y === node.y }) ? 'yes' : 'no'}>
        {layout.showRings ? layout.rings.map((ring, index) => (
          <ellipse key={index} className="b-ring" cx={layout.centre.x} cy={layout.centre.y} rx={ring.a} ry={ring.b} />
        )) : null}
        <g className="b-edges">
          {props.graph.edges.map((edge) => {
            const from = at(edge.from)
            const to = at(edge.to)
            const child = props.graph.nodes.find((node) => node.id === edge.to)
            const up = lifted(edge.from) || lifted(edge.to)
            const archived = child?.status === 'archived' || props.graph.nodes.find((node) => node.id === edge.from)?.status === 'archived'
            return edge.tree && !archived
              ? <line key={`${edge.from}-${edge.to}`} className="b-edge tree" x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={kindColour(child?.kind ?? '', child?.status ?? 'active')} strokeOpacity={up ? 0.9 : 0.45} data-from={edge.from} data-to={edge.to} data-lifted={up ? 'yes' : undefined} />
              : <line key={`${edge.from}-${edge.to}`} className="b-edge other" x1={from.x} y1={from.y} x2={to.x} y2={to.y} strokeOpacity={up ? 0.9 : 1} data-from={edge.from} data-to={edge.to} data-lifted={up ? 'yes' : undefined} />
          })}
        </g>
        <g className="b-nodes">
          {layout.nodes.map((node) => {
            const point = at(node.id)
            const colour = kindColour(node.kind, node.status)
            return (
              <g key={node.id} className={`b-node${node.id === props.selected ? ' selected' : ''}${node.id === active ? ' cursor' : ''}${node.depth === 0 ? ' focus' : ''}`}
                data-node={node.id} onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered((value) => (value === node.id ? null : value))}
                onClick={(event) => (event.shiftKey ? props.onRefocus(node.id) : props.onSelect(node.id))} onDoubleClick={() => props.onRefocus(node.id)}>
                {node.depth === 0 ? <circle className="b-bloom" cx={point.x} cy={point.y} r={node.r * 2.4} fill={colour} /> : null}
                <circle cx={point.x} cy={point.y} r={node.r + 6} className="b-hit" />
                <circle cx={point.x} cy={point.y} r={node.r} fill={colour} />
                {node.id === props.selected || node.id === active ? <circle className="b-select" cx={point.x} cy={point.y} r={node.r + 3.5} /> : null}
              </g>
            )
          })}
        </g>
        <g className="b-labels" aria-hidden="true">
          {labels.map((label) => {
            const point = at(label.id)
            const node = layout.nodes.find((each) => each.id === label.id)!
            const dx = label.x - node.x
            const dy = label.y - node.y
            return (
              <text key={label.id} x={point.x + dx} y={point.y + dy} textAnchor="middle" data-label={label.id}
                className={`b-node-label${label.id === props.selected ? ' selected' : ''}${node.status === 'archived' ? ' archived' : ''}`}>{label.text}</text>
            )
          })}
        </g>
        {layout.chips.map((chip) => (
          <g key={chip.depth} className="b-more-chip" role="button" tabIndex={-1} onClick={props.onMore}>
            <rect x={chip.x - 34} y={chip.y - 10} width={68} height={20} rx={5} />
            <text x={chip.x} y={chip.y + 4} textAnchor="middle">+ {chip.more} more</text>
          </g>
        ))}
      </svg>
      {props.graph.nodes.length === 1 ? <p className="b-graph-alone">No linked notes yet</p> : null}
      <KindKey nodes={props.graph.nodes} listRef={key} />
    </div>
  )
}

/** The plain kind key under a drawing (C4): kinds present with their counts, archived notes counted apart. */
export function KindKey(props: { nodes: readonly { kind: string; status: string }[]; listRef?: React.Ref<HTMLUListElement> }): React.JSX.Element {
  const kinds = useMemo(() => {
    const counts = new Map<string, { kind: string; status: string; count: number }>()
    for (const node of props.nodes) {
      const key = node.status === 'archived' ? 'archived' : node.kind
      const entry = counts.get(key) ?? { kind: key, status: node.status === 'archived' ? 'archived' : 'active', count: 0 }
      entry.count += 1
      counts.set(key, entry)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
  }, [props.nodes])
  return (
    <ul className="b-kinds" aria-label="Kinds" ref={props.listRef}>
      {kinds.map((entry) => (
        <li key={entry.kind}><span className="b-mark" style={{ background: kindColour(entry.kind, entry.status) }} aria-hidden="true" />{entry.kind} <span className="b-count">{entry.count}</span></li>
      ))}
    </ul>
  )
}
