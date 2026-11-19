// MODULE: brain-map.tsx - The whole brain as one static SVG picture: dots by kind, links as a few paths, labels that never touch, one Tab stop (Epic 128.5, design-128-5.md)
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrainMap } from '@bmn/protocol'
import { kindColour } from './brain-graph-layout'
import { measureLabel, KindKey } from './brain-graph'
import { layoutMap, mapNumbers, mapStep, nearestNote, placeMapLabels } from './brain-map-layout'

const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function BrainMapView(props: {
  map: BrainMap
  /** The note he was reading: it keeps the bloom. */
  open: string | null
  selected: string | null
  narrow: boolean
  reducedMotion?: boolean | undefined
  onSelect(id: string): void
  onOpenGraph(id: string): void
}): React.JSX.Element {
  const well = useRef<HTMLDivElement>(null)
  const key = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = well.current
    if (!element) return
    const measure = (): void => {
      const below = key.current ? key.current.offsetHeight + 16 : 0
      const width = Math.max(160, Math.floor(element.clientWidth))
      // Narrow: about as tall as it is wide (design 6).
      const height = props.narrow ? width : Math.max(160, Math.floor(element.clientHeight - below))
      setSize({ width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (key.current) observer.observe(key.current)
    return () => observer.disconnect()
  }, [props.narrow])

  const layout = useMemo(() => layoutMap(props.map, size.width || 640, size.height || 480), [props.map, size.width, size.height])
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout])
  const active = cursor ?? props.selected
  const labels = useMemo(() => placeMapLabels(layout, { open: props.open, selected: props.selected, hovered: hovered ?? cursor, rest: props.narrow ? 4 : 24, measure: measureLabel }),
    [layout, props.open, props.selected, hovered, cursor, props.narrow])

  // One path per colour (design 2): tree edges in the child's colour, the rest in the text colour, thinner above 500 links.
  const paths = useMemo(() => {
    const dense = layout.edges.length > 500
    const groups = new Map<string, { stroke: string; opacity: number; tree: boolean; d: string[] }>()
    for (const edge of layout.edges) {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      const archived = from.status === 'archived' || to.status === 'archived'
      const tree = edge.tree && !archived
      const stroke = tree ? kindColour(to.kind, to.status) : 'var(--text)'
      // Above 500 links the haze drops to 4% so the tree spokes still read (visual review; the design allows it).
      const group = groups.get(stroke) ?? { stroke, opacity: tree ? (dense ? 0.35 : 0.45) : (dense ? 0.04 : 0.1), tree, d: [] }
      group.d.push(`M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}`)
      groups.set(stroke, group)
    }
    return [...groups.values()]
  }, [layout, byId])
  const lifted = useMemo(() => {
    const id = hovered ?? active
    if (!id) return ''
    return layout.edges.filter((edge) => edge.from === id || edge.to === id).map((edge) => {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      return `M${from.x.toFixed(1)} ${from.y.toFixed(1)}L${to.x.toFixed(1)} ${to.y.toFixed(1)}`
    }).join('')
  }, [hovered, active, layout, byId])

  const pointAt = (event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const id = nearestNote(layout, pointAt(event), props.narrow)
    if (id !== hovered) setHovered(id)
  }
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>): void => {
    const current = active ?? layout.centres[0] ?? layout.nodes[0]?.id
    if (!current) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      setCursor(mapStep(layout, current, event.key))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) props.onOpenGraph(current)
      else props.onSelect(current)
    }
  }
  const still = props.reducedMotion ?? prefersReducedMotion()
  const numbers = mapNumbers(layout.counts)
  const named = byId.get(hovered ?? cursor ?? '')?.title ?? ''

  return (
    <div className="b-graph-pane b-map-pane">
      {/* The note under the pointer or the keys is always named here, even where G3 leaves no room for its label. */}
      {props.narrow ? null : <div className="b-graph-bar"><span className="b-muted b-map-numbers">{numbers}</span><span className="b-map-hover" aria-live="polite">{named}</span></div>}
    <div className={`b-graph-well b-map-well${props.narrow ? ' narrow' : ''}`} ref={well}>
      {props.map.nodes.length === 0 ? <p className="b-graph-alone">The brain is empty.</p> : null}
      <svg className={`b-graph b-map${still ? '' : ' fade'}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} tabIndex={0}
        role="application" aria-roledescription="map" aria-label={`The whole brain: ${numbers}. Arrows move, Enter shows beside, Shift Enter opens its graph.`}
        data-at-rest="yes" data-notes={layout.counts.notes} data-links={layout.counts.links} data-pitch={layout.pitch.toFixed(2)}
        onKeyDown={onKeyDown} onBlur={() => setCursor(null)} onPointerMove={onPointerMove} onPointerLeave={() => setHovered(null)}
        onClick={(event) => {
          const id = nearestNote(layout, pointAt(event as unknown as ReactPointerEvent<SVGSVGElement>), props.narrow)
          if (!id) return
          if (event.shiftKey) props.onOpenGraph(id); else props.onSelect(id)
        }}
        onDoubleClick={(event) => {
          const id = nearestNote(layout, pointAt(event as unknown as ReactPointerEvent<SVGSVGElement>), props.narrow)
          if (id) props.onOpenGraph(id)
        }}>
        <g className="b-discs">
          {layout.discs.map((disc, index) => <ellipse key={index} className="b-ring" cx={disc.x} cy={disc.y} rx={disc.rx} ry={disc.ry} />)}
        </g>
        <g className="b-edges">
          {paths.map((path) => <path key={path.stroke} className={`b-map-edges${path.tree ? ' tree' : ' other'}`} d={path.d.join('')} stroke={path.stroke} strokeOpacity={path.opacity} fill="none" />)}
          {lifted ? <path className="b-map-edges lifted" d={lifted} stroke="var(--text)" strokeOpacity={0.9} fill="none" /> : null}
        </g>
        <g className="b-nodes">
          {layout.nodes.map((node) => (
            <g key={node.id} className={`b-node${node.id === props.selected ? ' selected' : ''}${node.id === active ? ' cursor' : ''}${node.id === props.open ? ' focus' : ''}`} data-node={node.id}>
              {node.id === props.open ? <circle className="b-bloom" cx={node.x} cy={node.y} r={node.r * 2.4} fill={kindColour(node.kind, node.status)} /> : null}
              <circle cx={node.x} cy={node.y} r={node.r} fill={kindColour(node.kind, node.status)} />
              {node.id === props.selected || node.id === active ? <circle className="b-select" cx={node.x} cy={node.y} r={node.r + 3.5} /> : null}
            </g>
          ))}
        </g>
        <g className="b-labels" aria-hidden="true">
          {labels.map((label) => (
            <text key={label.id} x={label.x} y={label.y} textAnchor={label.anchor} data-label={label.id}
              className={`b-node-label${label.id === props.selected ? ' selected' : ''}${byId.get(label.id)?.status === 'archived' ? ' archived' : ''}`}>{label.text}</text>
          ))}
        </g>
      </svg>
      <div className="b-map-foot" ref={key}>
        {props.narrow ? <p className="b-muted b-map-numbers">{numbers}</p> : null}
        {props.narrow && named ? <p className="b-map-hover" aria-live="polite">{named}</p> : null}
        <KindKey nodes={props.map.nodes} />
      </div>
    </div>
    </div>
  )
}
