// MODULE: brain-graph-layout.ts - A note's neighbourhood placed on fixed orbits, with labels that never touch (Epic 128 design.md "Graph in numbers", G1 G3 G4, D7)
import type { BrainGraph, BrainGraphNode } from '@bmn/protocol'

export interface GraphPoint { x: number; y: number }
export interface PlacedNode extends BrainGraphNode, GraphPoint { r: number; angle: number }
export interface PlacedLabel { id: string; text: string; x: number; y: number; width: number; below: boolean }
export interface GraphLayout {
  width: number
  height: number
  centre: GraphPoint
  /** Ring half-axes by depth (index 0 is depth 1), drawn as hairline ellipses at 15 nodes or fewer. */
  rings: { a: number; b: number }[]
  showRings: boolean
  nodes: PlacedNode[]
  /** "+ N more" at 90 degrees on each full ring. */
  chips: { depth: number; more: number; x: number; y: number }[]
}

/** Rings as shares of the half-axes, by the deepest drawn depth. */
const RING_SHARES: Record<1 | 2 | 3, readonly number[]> = { 1: [0.55], 2: [0.45, 0.85], 3: [0.4, 0.72, 1] }
const RADII = { normal: [9, 6, 3.5, 2.2], small: [12, 8, 6, 5] } as const
export const SMALL_GRAPH = 15
export const LABEL_CHARS = 24
export const LABEL_SIZE = 12

/** Kinds share hues (design.md C4); the order a ring lists them in follows this, then the title. */
const KIND_ORDER = ['fact', 'project', 'map', 'reference', 'lesson', 'preference', 'feedback', 'user', 'check']
function kindRank(kind: string): number { const at = KIND_ORDER.indexOf(kind); return at === -1 ? KIND_ORDER.length : at }
const byKindTitle = (a: BrainGraphNode, b: BrainGraphNode): number => kindRank(a.kind) - kindRank(b.kind) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)

/** The CSS colour of a kind in the brain view (C4); archived notes are faint whatever their kind. */
export function kindColour(kind: string, status: string): string {
  if (status === 'archived') return 'var(--faint)'
  switch (kind) {
    case 'fact': case 'project': return 'var(--kind-fact)'
    case 'map': case 'reference': return 'var(--kind-map)'
    case 'lesson': return 'var(--kind-lesson)'
    case 'preference': case 'feedback': case 'user': return 'var(--kind-preference)'
    case 'check': return 'var(--kind-check)'
    default: return 'var(--muted)'
  }
}

export function labelText(title: string): string {
  const chars = [...title]
  return chars.length > LABEL_CHARS ? chars.slice(0, LABEL_CHARS - 1).join('') + '…' : title
}

const degrees = (value: number): number => (value * Math.PI) / 180

/**
 * Places the nodes: the focus in the centre; depth-1 notes share 360 degrees by weight 1 + min(descendants, 8),
 * ordered by kind then title, the first at -90 degrees (at 0 for one or two); children spread evenly across their
 * parent's share; neighbours on a ring alternate x0.93 and x1.07.
 */
export function layoutGraph(graph: BrainGraph, width: number, height: number): GraphLayout {
  const centre = { x: width / 2, y: height / 2 }
  const a = Math.max(40, Math.min(520, width / 2 - 64))
  const b = Math.max(40, Math.min(380, height / 2 - 48))
  const deepest = Math.max(1, ...graph.nodes.map((node) => node.depth)) as 1 | 2 | 3
  const shares = RING_SHARES[Math.min(3, deepest) as 1 | 2 | 3]
  const rings = shares.map((share) => ({ a: a * share, b: b * share }))
  const small = graph.nodes.length <= SMALL_GRAPH
  const radii = small ? RADII.small : RADII.normal
  const children = new Map<string, BrainGraphNode[]>()
  for (const node of graph.nodes) if (node.parent) children.set(node.parent, [...(children.get(node.parent) ?? []), node])
  for (const list of children.values()) list.sort(byKindTitle)
  const descendants = (id: string): number => (children.get(id) ?? []).reduce((sum, child) => sum + 1 + descendants(child.id), 0)
  const angle = new Map<string, number>([[graph.focus, 0]])
  const first = children.get(graph.focus) ?? []
  const weights = first.map((node) => 1 + Math.min(descendants(node.id), 8))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const spread = (id: string, from: number, to: number): void => {
    const list = children.get(id) ?? []
    const step = (to - from) / Math.max(1, list.length)
    list.forEach((child, index) => {
      angle.set(child.id, from + step * (index + 0.5))
      spread(child.id, from + step * index, from + step * (index + 1))
    })
  }
  if (first.length) {
    const start = first.length <= 2 ? 0 : -90
    // The first node's share is centred on the start angle.
    let at = start - (360 * weights[0]!) / total / 2
    first.forEach((node, index) => {
      const share = (360 * weights[index]!) / total
      angle.set(node.id, at + share / 2)
      spread(node.id, at, at + share)
      at += share
    })
  }
  const byRing = new Map<number, BrainGraphNode[]>()
  for (const node of graph.nodes) if (node.depth > 0) byRing.set(node.depth, [...(byRing.get(node.depth) ?? []), node])
  const factor = new Map<string, number>()
  for (const list of byRing.values()) {
    list.sort((p, q) => (angle.get(p.id) ?? 0) - (angle.get(q.id) ?? 0))
    // Alternation only spreads a crowded ring; a ring of one or two keeps its ellipse.
    list.forEach((node, index) => factor.set(node.id, index % 2 === 0 ? 0.93 : 1.07))
  }
  const nodes = graph.nodes.map((node): PlacedNode => {
    const r = radii[Math.min(3, node.depth)]!
    if (node.depth === 0) return { ...node, x: centre.x, y: centre.y, r, angle: 0 }
    const ring = rings[Math.min(rings.length, node.depth) - 1]!
    const theta = degrees(angle.get(node.id) ?? 0)
    const scale = factor.get(node.id) ?? 1
    return { ...node, x: centre.x + Math.cos(theta) * ring.a * scale, y: centre.y + Math.sin(theta) * ring.b * scale, r, angle: angle.get(node.id) ?? 0 }
  })
  const chips = graph.more.flatMap((more, index) => {
    const ring = rings[index]
    return more > 0 && ring ? [{ depth: index + 1, more, x: centre.x, y: centre.y + ring.b }] : []
  })
  return { width, height, centre, rings, showRings: small, nodes, chips }
}

interface Box { left: number; right: number; top: number; bottom: number }
const PAD = 4
const touches = (p: Box, q: Box): boolean => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom

/**
 * Labels in order: focus, selected, hovered, depth 1, then by links. Each sits centred under its node at r + 15, else
 * above at r + 7, else is not drawn; boxes pad 4 px and never touch another label or a node (G3). Above 15 nodes,
 * notes deeper than depth 1 are labelled only when hovered or selected. The focus is always named (D7): it goes first,
 * and where neither place is clear of nodes it takes the place under its node, moved inside the pane.
 */
export function placeLabels(layout: GraphLayout, options: { selected: string | null; hovered: string | null; measure(text: string): number }): PlacedLabel[] {
  const small = layout.nodes.length <= SMALL_GRAPH
  const rank = (node: PlacedNode): number => node.depth === 0 ? 0 : node.id === options.selected ? 1 : node.id === options.hovered ? 2 : node.depth === 1 ? 3 : 4
  const order = layout.nodes
    .filter((node) => small || node.depth <= 1 || node.id === options.selected || node.id === options.hovered)
    .sort((p, q) => rank(p) - rank(q) || q.links - p.links || p.title.localeCompare(q.title))
  const taken: Box[] = []
  const nodeBoxes = layout.nodes.map((node) => ({ id: node.id, box: { left: node.x - node.r, right: node.x + node.r, top: node.y - node.r, bottom: node.y + node.r } }))
  const placed: PlacedLabel[] = []
  for (const node of order) {
    const text = labelText(node.title)
    const width = options.measure(text)
    for (const below of [true, false]) {
      // The baseline: under the node at r + 15, or above it at r + 7.
      const y = below ? node.y + node.r + 15 : node.y - node.r - 7
      const box: Box = { left: node.x - width / 2 - PAD, right: node.x + width / 2 + PAD, top: y - LABEL_SIZE + 1 - PAD, bottom: y + 3 + PAD }
      if (box.left < 0 || box.right > layout.width || box.top < 0 || box.bottom > layout.height) continue
      if (taken.some((other) => touches(box, other))) continue
      if (nodeBoxes.some((other) => other.id !== node.id && touches(box, other.box))) continue
      taken.push(box)
      placed.push({ id: node.id, text, x: node.x, y, width, below })
      break
    }
    if (node.depth === 0 && !placed.length) {
      // The reserved focus label: under the node, kept inside the pane; later labels keep clear of it.
      const half = width / 2 + PAD
      const x = Math.min(Math.max(node.x, half), layout.width - half)
      const below = node.y + node.r + 15 + 3 + PAD <= layout.height
      const y = below ? node.y + node.r + 15 : Math.max(LABEL_SIZE + PAD, node.y - node.r - 7)
      taken.push({ left: x - half, right: x + half, top: y - LABEL_SIZE + 1 - PAD, bottom: y + 3 + PAD })
      placed.push({ id: node.id, text, x, y, width, below })
    }
  }
  return placed
}

/** The node a key moves to (design.md Keys): Left and Right along the ring, Up to the parent, Down to the first child. */
export function graphStep(layout: GraphLayout, from: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): string {
  const node = layout.nodes.find((each) => each.id === from)
  if (!node) return layout.nodes[0]?.id ?? from
  if (key === 'ArrowUp') return node.parent ?? from
  if (key === 'ArrowDown') {
    const child = layout.nodes.filter((each) => each.parent === node.id).sort((p, q) => p.angle - q.angle)[0]
    return child?.id ?? from
  }
  const ring = layout.nodes.filter((each) => each.depth === node.depth).sort((p, q) => p.angle - q.angle)
  if (ring.length < 2) return from
  const at = ring.findIndex((each) => each.id === from)
  return ring[(at + (key === 'ArrowRight' ? 1 : -1) + ring.length) % ring.length]!.id
}

/** Where each node is drawn at time t of a tween (0 to 1, eased); new nodes leave their parent. */
export function tweenPoints(from: ReadonlyMap<string, GraphPoint>, to: readonly PlacedNode[], t: number): Map<string, GraphPoint> {
  const eased = 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
  const out = new Map<string, GraphPoint>()
  const target = new Map(to.map((node) => [node.id, node]))
  for (const node of to) {
    const start = from.get(node.id) ?? (node.parent ? from.get(node.parent) ?? target.get(node.parent) : undefined) ?? node
    out.set(node.id, { x: start.x + (node.x - start.x) * eased, y: start.y + (node.y - start.y) * eased })
  }
  return out
}

export const TWEEN_NEW_MS = 240
export const TWEEN_MOVE_MS = 300
