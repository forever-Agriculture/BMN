// MODULE: brain-map-layout.ts - The whole brain in one fitted picture: linked groups as packed discs, unlinked notes as a belt, labels that never touch (Epic 128.5, design-128-5.md)
import type { BrainMap, BrainMapNode } from '@bmn/protocol'
import { labelText, LABEL_SIZE, type PlacedLabel } from './brain-graph-layout'

/** A map label: under or above its dot (centred), else to its right or left. */
export interface MapLabel extends PlacedLabel { anchor: 'middle' | 'start' | 'end' }

export interface MapPoint { x: number; y: number }
export interface MapNode extends BrainMapNode, MapPoint {
  r: number
  /** Index of its linked group (biggest first), or -1 for a note with no link. */
  group: number
  parent: string | null
}
export interface MapCounts { notes: number; links: number; alone: number; groups: number; largest: number; total: number }
export interface MapLayout {
  width: number
  height: number
  pitch: number
  nodes: MapNode[]
  /** Outlines of groups of 3 or more, as ellipses (the picture is stretched along its longer side). */
  discs: { x: number; y: number; rx: number; ry: number; size: number }[]
  edges: { from: string; to: string; tree: boolean }[]
  /** Each group's centre note, biggest group first: the first labels at rest after the open and selected notes. */
  centres: string[]
  counts: MapCounts
}

const KIND_ORDER = ['fact', 'project', 'map', 'reference', 'lesson', 'preference', 'feedback', 'user', 'check']
const kindRank = (kind: string): number => { const at = KIND_ORDER.indexOf(kind); return at === -1 ? KIND_ORDER.length : at }
const byTitle = (a: BrainMapNode, b: BrainMapNode): number => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
const byKindTitle = (a: BrainMapNode, b: BrainMapNode): number => kindRank(a.kind) - kindRank(b.kind) || byTitle(a, b)

/** Exact centres (least farthest note) up to this group size; a bigger group is centred on its busiest note. */
const EXACT_CENTRE = 400
export const MAP_PITCH_MAX = 40
const STRETCH_MAX = 1.45
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

interface Unit { x: number; y: number }

/** BFS distances from one note inside its group. */
function distances(from: string, near: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const seen = new Map([[from, 0]])
  const queue = [from]
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at]!
    for (const to of near.get(id) ?? []) if (!seen.has(to)) { seen.set(to, seen.get(id)! + 1); queue.push(to) }
  }
  return seen
}

/**
 * One group as a disc in pitch units (design 2): the centre note in the middle, layer d (d links away) on the fewest
 * whole rings that hold it (ring k has radius k and 6k slots, the first at -90 degrees); each note takes the free
 * slot nearest its parent, ties to the inner ring, then clockwise.
 */
function layoutGroup(members: BrainMapNode[], near: ReadonlyMap<string, readonly string[]>, byId: ReadonlyMap<string, BrainMapNode>):
  { centre: string; points: Map<string, Unit>; parent: Map<string, string | null>; rings: number } {
  let centre = members[0]!
  if (members.length <= EXACT_CENTRE) {
    let best = Infinity
    for (const note of [...members].sort((a, b) => b.links - a.links || byTitle(a, b))) {
      const far = Math.max(...distances(note.id, near).values())
      if (far < best) { best = far; centre = note }
    }
  } else centre = [...members].sort((a, b) => b.links - a.links || byTitle(a, b))[0]!
  const points = new Map<string, Unit>([[centre.id, { x: 0, y: 0 }]])
  const parent = new Map<string, string | null>([[centre.id, null]])
  let layer = [centre.id]
  let nextRing = 1
  let rings = 0
  while (layer.length) {
    const found: string[] = []
    for (const from of layer) {
      const children = (near.get(from) ?? []).filter((id) => !parent.has(id)).map((id) => byId.get(id)!).sort(byKindTitle)
      for (const child of children) { parent.set(child.id, from); found.push(child.id) }
    }
    if (!found.length) break
    const slots: { ring: number; index: number; x: number; y: number; free: boolean }[] = []
    let room = 0
    while (room < found.length) {
      const count = 6 * nextRing
      for (let index = 0; index < count; index += 1) {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count
        slots.push({ ring: nextRing, index, x: nextRing * Math.cos(angle), y: nextRing * Math.sin(angle), free: true })
      }
      room += count
      rings = nextRing
      nextRing += 1
    }
    // Around the centre every slot is as near as any other: the first layer is spread evenly, from the top.
    if (layer.length === 1 && layer[0] === centre.id && slots.length) {
      found.forEach((id, index) => {
        const slot = slots[Math.floor((index * slots.length) / found.length)]!
        slot.free = false
        points.set(id, { x: slot.x, y: slot.y })
      })
      layer = found
      continue
    }
    for (const id of found) {
      const from = points.get(parent.get(id)!)!
      let pick = -1
      let best = Infinity
      slots.forEach((slot, at) => {
        if (!slot.free) return
        const d = (slot.x - from.x) ** 2 + (slot.y - from.y) ** 2
        // Ties (within rounding) keep the earlier slot: inner ring first, then clockwise from the top.
        if (d < best - 1e-9) { best = d; pick = at }
      })
      const slot = slots[pick]!
      slot.free = false
      points.set(id, { x: slot.x, y: slot.y })
    }
    layer = found
  }
  return { centre: centre.id, points, parent, rings }
}

/**
 * Places the whole brain (design-128-5.md section 2): groups by size then centre title, the biggest in the middle,
 * each next disc at the first point of a spiral out of the centre (step half a pitch) that clears the placed discs
 * by a pitch; unlinked notes, by kind then title, on belt rings from 1.5 pitches outside the outermost group, each
 * ring holding notes in proportion to its length and turned half a step from the last. Then it is fitted to the
 * well, stretched along the longer side by at most 1.45, with a pitch of at most 40 px.
 */
export function layoutMap(map: BrainMap, width: number, height: number): MapLayout {
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  const lists = new Map<string, string[]>()
  for (const edge of map.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    lists.set(edge.from, [...(lists.get(edge.from) ?? []), edge.to])
    lists.set(edge.to, [...(lists.get(edge.to) ?? []), edge.from])
  }
  const near: ReadonlyMap<string, readonly string[]> = lists
  // Linked groups.
  const seen = new Set<string>()
  const groups: BrainMapNode[][] = []
  const alone: BrainMapNode[] = []
  for (const node of [...map.nodes].sort(byTitle)) {
    if (seen.has(node.id)) continue
    if (!near.has(node.id)) { seen.add(node.id); alone.push(node); continue }
    const members = [...distances(node.id, near).keys()]
    for (const id of members) seen.add(id)
    groups.push(members.map((id) => byId.get(id)!))
  }
  const placed = groups.map((members) => ({ members, ...layoutGroup(members, near, byId) }))
  placed.sort((a, b) => b.members.length - a.members.length || byId.get(a.centre)!.title.localeCompare(byId.get(b.centre)!.title) || a.centre.localeCompare(b.centre))
  // Packing on a spiral, half a pitch between turns and between points.
  const discs: { x: number; y: number; R: number }[] = []
  const resume = new Map<number, { theta: number }>()
  for (const group of placed) {
    const R = group.rings + 0.5
    if (!discs.length) { discs.push({ x: 0, y: 0, R }); continue }
    // Discs come biggest first; one of the same size cannot fit before where the last one went.
    let theta = resume.get(R)?.theta ?? 0
    for (;;) {
      const r = (0.5 * theta) / (2 * Math.PI)
      const x = r * Math.cos(theta - Math.PI / 2)
      const y = r * Math.sin(theta - Math.PI / 2)
      if (discs.every((disc) => Math.hypot(disc.x - x, disc.y - y) >= disc.R + R + 1 - 1e-9)) {
        discs.push({ x, y, R })
        resume.set(R, { theta })
        break
      }
      theta += 0.5 / Math.max(r, 0.5)
    }
  }
  const unit = new Map<string, Unit>()
  const parentOf = new Map<string, string | null>()
  const groupOf = new Map<string, number>()
  placed.forEach((group, at) => {
    const disc = discs[at]!
    for (const [id, point] of group.points) { unit.set(id, { x: disc.x + point.x, y: disc.y + point.y }); groupOf.set(id, at) }
    for (const [id, from] of group.parent) parentOf.set(id, from)
  })
  // The belt.
  const outer = discs.reduce((most, disc) => Math.max(most, Math.hypot(disc.x, disc.y) + disc.R), 0)
  const belt = [...alone].sort(byKindTitle)
  if (belt.length) {
    const start = discs.length ? outer + 1.5 : belt.length === 1 ? 0 : 1
    const caps: number[] = []
    let room = 0
    while (room < belt.length) {
      const radius = start + caps.length
      const cap = radius === 0 ? 1 : Math.max(1, Math.floor(2 * Math.PI * radius))
      caps.push(cap)
      room += cap
    }
    const shares = caps.map((cap) => Math.floor((belt.length * cap) / room))
    let left = belt.length - shares.reduce((sum, share) => sum + share, 0)
    const order = caps.map((cap, at) => ({ at, rest: (belt.length * cap) / room - shares[at]! })).sort((a, b) => b.rest - a.rest || a.at - b.at)
    for (let i = 0; left > 0; i = (i + 1) % order.length) {
      const at = order[i]!.at
      if (shares[at]! < caps[at]!) { shares[at]! += 1; left -= 1 }
    }
    let next = 0
    shares.forEach((count, ring) => {
      const radius = start + ring
      for (let index = 0; index < count; index += 1) {
        const angle = -Math.PI / 2 + ((index + (ring % 2) * 0.5) * 2 * Math.PI) / count
        const note = belt[next++]!
        unit.set(note.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
      }
    })
  }
  // Fit.
  const extent = Math.max(0.5, ...[...unit.values()].map((point) => Math.hypot(point.x, point.y) + 0.25), ...discs.map((disc) => Math.hypot(disc.x, disc.y) + disc.R))
  const wide = width >= height
  const stretch = wide ? Math.min(width / Math.max(1, height), STRETCH_MAX) : Math.min(height / Math.max(1, width), STRETCH_MAX)
  const sx = wide ? stretch : 1
  const sy = wide ? 1 : stretch
  const side = width < 480 ? 16 : 72
  const pitch = Math.max(1, Math.min(MAP_PITCH_MAX, (width - 2 * side) / (2 * extent * sx), (height - 40) / (2 * extent * sy)))
  const cx = width / 2
  const cy = height / 2
  const nodes = map.nodes.map((note): MapNode => {
    const point = unit.get(note.id) ?? { x: 0, y: 0 }
    const group = groupOf.get(note.id) ?? -1
    const r = group === -1 ? clamp(0.12 * pitch, 1.5, 4) : clamp(0.15 * pitch + 0.02 * pitch * Math.min(note.links, 8), 2, 9)
    return { ...note, x: cx + point.x * pitch * sx, y: cy + point.y * pitch * sy, r, group, parent: parentOf.get(note.id) ?? null }
  })
  const edges = map.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).map((edge) => {
    // A tree edge runs from parent to child.
    if (parentOf.get(edge.to) === edge.from) return { from: edge.from, to: edge.to, tree: true }
    if (parentOf.get(edge.from) === edge.to) return { from: edge.to, to: edge.from, tree: true }
    return { ...edge, tree: false }
  })
  return {
    width, height, pitch, nodes, edges,
    discs: placed.flatMap((group, at) => group.members.length >= 3
      ? [{ x: cx + discs[at]!.x * pitch * sx, y: cy + discs[at]!.y * pitch * sy, rx: discs[at]!.R * pitch * sx, ry: discs[at]!.R * pitch * sy, size: group.members.length }] : []),
    centres: placed.map((group) => group.centre),
    counts: { notes: map.nodes.length, links: edges.length, alone: alone.length, groups: placed.length, largest: placed[0]?.members.length ?? 0, total: map.total }
  }
}

/** "57 notes · 17 links · 33 alone · 8 groups, largest 5" (design 5); above the cap it opens with "First N of total". */
export function mapNumbers(counts: MapCounts): string {
  const n = (value: number): string => value.toLocaleString('en-US')
  const plural = (value: number, one: string, many: string): string => `${n(value)} ${value === 1 ? one : many}`
  const notes = counts.total > counts.notes ? `First ${n(counts.notes)} of ${n(counts.total)} notes` : plural(counts.notes, 'note', 'notes')
  const parts = [notes, plural(counts.links, 'link', 'links'), `${n(counts.alone)} alone`]
  if (counts.groups) parts.push(`${plural(counts.groups, 'group', 'groups')}, largest ${n(counts.largest)}`)
  return parts.join(' · ')
}

interface Box { left: number; right: number; top: number; bottom: number }
const PAD = 4
const touches = (p: Box, q: Box): boolean => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom

/**
 * Labels (design 3, G3): at rest the open note, the selected one, then each group's centre biggest group first, then by
 * links, at most `rest` of them; unlinked notes are never labelled at rest. Then the hovered note and its neighbours
 * (its whole group when it has 8 notes or fewer); a hovered label that only collides with rest labels replaces them.
 * Each label sits under its node at r + 15, else above at r + 7, else right or left of it at r + 6 (a group's centre is
 * often closed in above and below by its own ring), else is not drawn; boxes pad 4 px and never touch.
 */
export function placeMapLabels(layout: MapLayout, options: { open: string | null; selected: string | null; hovered: string | null; rest: number; measure(text: string): number }): MapLabel[] {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]))
  const centres = new Set(layout.centres)
  const restOrder: MapNode[] = []
  const add = (list: MapNode[], id: string | null | undefined): void => { const node = id ? byId.get(id) : undefined; if (node && !list.includes(node)) list.push(node) }
  add(restOrder, options.open)
  add(restOrder, options.selected)
  for (const id of layout.centres) add(restOrder, id)
  for (const node of [...layout.nodes].filter((each) => each.group !== -1 && !centres.has(each.id)).sort((a, b) => b.links - a.links || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))) add(restOrder, node.id)
  const hoverOrder: MapNode[] = []
  const hovered = options.hovered ? byId.get(options.hovered) : undefined
  if (hovered) {
    add(hoverOrder, hovered.id)
    const group = hovered.group === -1 ? [] : layout.nodes.filter((node) => node.group === hovered.group)
    const neighbours = group.length && group.length <= 8 ? group : layout.edges.flatMap((edge) => edge.from === hovered.id ? [edge.to] : edge.to === hovered.id ? [edge.from] : []).map((id) => byId.get(id)!)
    for (const node of neighbours) add(hoverOrder, node.id)
  }
  const nodeBoxes = layout.nodes.map((node) => ({ id: node.id, box: { left: node.x - node.r, right: node.x + node.r, top: node.y - node.r, bottom: node.y + node.r } }))
  const placed: (MapLabel & { box: Box; rest: boolean })[] = []
  const tryPlace = (node: MapNode, rest: boolean, replace: boolean): boolean => {
    const text = labelText(node.title)
    const width = options.measure(text)
    const side = node.y + LABEL_SIZE / 2 - 2
    const places: { x: number; y: number; below: boolean; anchor: MapLabel['anchor']; left: number }[] = [
      { x: node.x, y: node.y + node.r + 15, below: true, anchor: 'middle', left: node.x - width / 2 },
      { x: node.x, y: node.y - node.r - 7, below: false, anchor: 'middle', left: node.x - width / 2 },
      { x: node.x + node.r + 6, y: side, below: false, anchor: 'start', left: node.x + node.r + 6 },
      { x: node.x - node.r - 6, y: side, below: false, anchor: 'end', left: node.x - node.r - 6 - width }
    ]
    for (const place of places) {
      const box: Box = { left: place.left - PAD, right: place.left + width + PAD, top: place.y - LABEL_SIZE + 1 - PAD, bottom: place.y + 3 + PAD }
      if (box.left < 0 || box.right > layout.width || box.top < 0 || box.bottom > layout.height) continue
      if (nodeBoxes.some((other) => other.id !== node.id && touches(box, other.box))) continue
      const hits = placed.filter((other) => touches(box, other.box))
      if (hits.length && !(replace && hits.every((other) => other.rest))) continue
      for (const hit of hits) placed.splice(placed.indexOf(hit), 1)
      placed.push({ id: node.id, text, x: place.x, y: place.y, width, below: place.below, anchor: place.anchor, box, rest })
      return true
    }
    return false
  }
  let shown = 0
  for (const node of restOrder) {
    if (shown >= options.rest) break
    if (tryPlace(node, true, false)) shown += 1
  }
  hoverOrder.forEach((node, at) => {
    if (placed.some((label) => label.id === node.id)) return
    tryPlace(node, false, at === 0)
  })
  return placed.map((label): MapLabel => ({ id: label.id, text: label.text, x: label.x, y: label.y, width: label.width, below: label.below, anchor: label.anchor }))
}

/** The note nearest a point within reach (design 4: max(r + 6, pitch / 2), 16 px on narrow), else null. */
export function nearestNote(layout: MapLayout, point: MapPoint, narrow = false): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  for (const node of layout.nodes) {
    const d = Math.hypot(node.x - point.x, node.y - point.y)
    const reach = narrow ? 16 : Math.max(node.r + 6, layout.pitch / 2)
    if (d <= reach && d < bestDistance) { best = node.id; bestDistance = d }
  }
  return best
}

/** The nearest note in an arrow's direction, within 45 degrees of it (design 4), else the same note. */
export function mapStep(layout: MapLayout, from: string, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): string {
  const node = layout.nodes.find((each) => each.id === from)
  if (!node) return layout.nodes[0]?.id ?? from
  const [dx, dy] = key === 'ArrowLeft' ? [-1, 0] : key === 'ArrowRight' ? [1, 0] : key === 'ArrowUp' ? [0, -1] : [0, 1]
  let best = from
  let bestDistance = Infinity
  for (const other of layout.nodes) {
    if (other.id === from) continue
    const vx = other.x - node.x
    const vy = other.y - node.y
    const d = Math.hypot(vx, vy)
    if (d === 0 || (vx * dx + vy * dy) / d < Math.SQRT1_2) continue
    if (d < bestDistance) { best = other.id; bestDistance = d }
  }
  return best
}
