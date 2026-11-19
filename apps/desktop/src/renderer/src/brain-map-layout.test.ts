// MODULE: brain-map-layout.test.ts - Epic 128.5: the whole-brain map's layout (groups, belt, fit, same picture), counts line, labels (G3), hit and keys
import type { BrainMap, BrainMapNode } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { layoutMap, mapNumbers, mapStep, nearestNote, placeMapLabels } from './brain-map-layout'

const KINDS = ['feedback', 'fact', 'project', 'user', 'reference', 'map']
const measure = (text: string): number => text.length * 6.6

/** His brain's shape today (counts only, titles synthetic): 57 notes, groups of 5,4,4,3,2,2,2,2 and 33 alone, 17 links. */
function shapeOfToday(): BrainMap {
  const nodes: BrainMapNode[] = []
  const edges: BrainMap['edges'] = []
  let at = 0
  const add = (): string => { const id = `n${String(at).padStart(3, '0')}`; nodes.push({ id, title: `Synthetic note ${at}`, kind: KINDS[at % KINDS.length]!, status: 'active', links: 0 }); at += 1; return id }
  const link = (a: string, b: string): void => { edges.push(a < b ? { from: a, to: b } : { from: b, to: a }) }
  for (const size of [5, 4, 4, 3, 2, 2, 2, 2]) {
    const ids = Array.from({ length: size }, add)
    for (let i = 1; i < size; i += 1) link(ids[0]!, ids[i]!)
  }
  // One extra link closes a triangle in the group of 5: 17 links in all.
  link('n001', 'n002')
  for (let i = 0; i < 33; i += 1) add()
  for (const node of nodes) node.links = edges.filter((edge) => edge.from === node.id || edge.to === node.id).length
  return { nodes, edges, total: nodes.length }
}

/** A dense synthetic brain: n notes, m links, from a fixed seed. */
function dense(n: number, m: number): BrainMap {
  let seed = 7
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
  const nodes: BrainMapNode[] = Array.from({ length: n }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, title: `Dense note number ${i}`, kind: KINDS[i % KINDS.length]!, status: 'active', links: 0 }))
  const keys = new Set<string>()
  while (keys.size < m) {
    const a = Math.floor(random() * n)
    const b = Math.floor(random() * n)
    if (a === b) continue
    const [p, q] = [nodes[a]!.id, nodes[b]!.id].sort() as [string, string]
    keys.add(`${p} ${q}`)
  }
  const edges = [...keys].map((key) => { const [from, to] = key.split(' ') as [string, string]; return { from, to } })
  for (const edge of edges) { nodes.find((node) => node.id === edge.from)!.links += 1; nodes.find((node) => node.id === edge.to)!.links += 1 }
  return { nodes, edges, total: n }
}

const overlaps = (layout: ReturnType<typeof layoutMap>): number => {
  let count = 0
  for (let i = 0; i < layout.nodes.length; i += 1) for (let j = i + 1; j < layout.nodes.length; j += 1) {
    const p = layout.nodes[i]!
    const q = layout.nodes[j]!
    if (Math.hypot(p.x - q.x, p.y - q.y) < p.r + q.r) count += 1
  }
  return count
}

describe('whole-brain map layout', () => {
  it('counts his brain as the numbers line says', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    expect(layout.counts).toEqual({ notes: 57, links: 17, alone: 33, groups: 8, largest: 5, total: 57 })
    expect(mapNumbers(layout.counts)).toBe('57 notes · 17 links · 33 alone · 8 groups, largest 5')
    expect(mapNumbers({ notes: 3000, links: 9000, alone: 0, groups: 1, largest: 3000, total: 3412 })).toBe('First 3,000 of 3,412 notes · 9,000 links · 0 alone · 1 group, largest 3,000')
    expect(mapNumbers({ notes: 1, links: 0, alone: 1, groups: 0, largest: 0, total: 1 })).toBe('1 note · 0 links · 1 alone')
  })

  it('draws the same picture for the same brain, whatever order the notes come in', () => {
    const map = shapeOfToday()
    const one = layoutMap(map, 940, 640)
    const two = layoutMap({ ...map, nodes: [...map.nodes].reverse(), edges: [...map.edges].reverse() }, 940, 640)
    const at = (layout: typeof one): Record<string, string> => Object.fromEntries(layout.nodes.map((node) => [node.id, `${node.x.toFixed(3)},${node.y.toFixed(3)}`]))
    expect(at(two)).toEqual(at(one))
  })

  it('keeps every dot inside the well, apart from every other, groups in the middle and the belt outside them', () => {
    for (const [width, height] of [[940, 640], [288, 288], [1240, 700]] as const) {
      const layout = layoutMap(shapeOfToday(), width, height)
      expect(overlaps(layout)).toBe(0)
      for (const node of layout.nodes) {
        expect(node.x - node.r).toBeGreaterThanOrEqual(0)
        expect(node.x + node.r).toBeLessThanOrEqual(width)
        expect(node.y - node.r).toBeGreaterThanOrEqual(0)
        expect(node.y + node.r).toBeLessThanOrEqual(height)
      }
      const centre = { x: width / 2, y: height / 2 }
      const far = (node: { x: number; y: number }): number => Math.hypot((node.x - centre.x) / (width >= height ? Math.min(width / height, 1.45) : 1), (node.y - centre.y) / (height > width ? Math.min(height / width, 1.45) : 1))
      const linked = layout.nodes.filter((node) => node.group !== -1)
      const alone = layout.nodes.filter((node) => node.group === -1)
      expect(Math.min(...alone.map(far))).toBeGreaterThan(Math.max(...linked.map(far)))
      // Disc outlines for groups of 3 or more only, and they never cross.
      expect(layout.discs.map((disc) => disc.size)).toEqual([5, 4, 4, 3])
    }
  })

  it('puts the biggest group in the middle, its centre the note nearest all others', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    const centre = layout.nodes.find((node) => node.id === layout.centres[0])!
    expect(centre.id).toBe('n000')
    expect(centre.x).toBeCloseTo(470)
    expect(centre.y).toBeCloseTo(320)
    expect(layout.pitch).toBeLessThanOrEqual(40)
  })

  it('marks tree edges from parent to child', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    const trees = layout.edges.filter((edge) => edge.tree)
    for (const edge of trees) expect(layout.nodes.find((node) => node.id === edge.to)!.parent).toBe(edge.from)
    // 8 groups of 24 notes hold 16 tree edges; the triangle's third link is the one other.
    expect(trees).toHaveLength(16)
  })

  it('lays out 1,000 notes and 3,000 links quickly, fitted, with no two dots on top of each other', () => {
    const map = dense(1000, 3000)
    const start = performance.now()
    const layout = layoutMap(map, 940, 640)
    const took = performance.now() - start
    expect(took).toBeLessThan(500)
    expect(layout.nodes).toHaveLength(1000)
    expect(overlaps(layout)).toBe(0)
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x).toBeLessThanOrEqual(940)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeLessThanOrEqual(640)
    }
  })

  it('packs many small groups without slowing down', () => {
    const nodes: BrainMapNode[] = Array.from({ length: 1000 }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, title: `Pair ${i}`, kind: 'fact', status: 'active', links: 1 }))
    const edges = Array.from({ length: 500 }, (_, i) => ({ from: nodes[2 * i]!.id, to: nodes[2 * i + 1]!.id }))
    const start = performance.now()
    const layout = layoutMap({ nodes, edges, total: 1000 }, 940, 640)
    expect(performance.now() - start).toBeLessThan(500)
    expect(layout.counts).toMatchObject({ groups: 500, largest: 2, alone: 0 })
    expect(overlaps(layout)).toBe(0)
  })

  it('places a brain with no links as a belt from the centre, and one note in the middle', () => {
    const lone = layoutMap({ nodes: [{ id: 'a', title: 'Alone', kind: 'fact', status: 'active', links: 0 }], edges: [], total: 1 }, 600, 400)
    expect(lone.nodes[0]).toMatchObject({ x: 300, y: 200, group: -1 })
    const empty = layoutMap({ nodes: [], edges: [], total: 0 }, 600, 400)
    expect(empty.nodes).toEqual([])
    expect(mapNumbers(empty.counts)).toBe('0 notes · 0 links · 0 alone')
  })
})

describe('map labels, hit and keys', () => {
  const touch = (labels: ReturnType<typeof placeMapLabels>): number => {
    const boxes = labels.map((label) => {
      const left = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - label.width : label.x - label.width / 2
      return { left: left - 4, right: left + label.width + 4, top: label.y - 15, bottom: label.y + 7 }
    })
    let count = 0
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const p = boxes[i]!
      const q = boxes[j]!
      if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) count += 1
    }
    return count
  }

  it('labels the open note and group centres at rest, never an unlinked note, and no two labels touch', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    // n013 heads a pair: its label has room, so as the open note it is labelled first.
    const labels = placeMapLabels(layout, { open: 'n013', selected: null, hovered: null, rest: 24, measure })
    expect(labels[0]!.id).toBe('n013')
    expect(labels.length).toBeGreaterThanOrEqual(6)
    expect(labels.every((label) => layout.nodes.find((node) => node.id === label.id)!.group !== -1)).toBe(true)
    expect(touch(labels)).toBe(0)
    const narrow = placeMapLabels(layoutMap(shapeOfToday(), 288, 288), { open: null, selected: null, hovered: null, rest: 4, measure })
    expect(narrow.length).toBeLessThanOrEqual(4)
    expect(touch(narrow)).toBe(0)
  })

  it('names a hovered note, even an unlinked one, and still no two labels touch', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    // A dot with room only at its side is named there.
    const side = layoutMap({ nodes: [{ id: 'a', title: 'Side', kind: 'fact', status: 'active', links: 2 }, { id: 'b', title: 'Up', kind: 'fact', status: 'active', links: 1 }, { id: 'c', title: 'Down', kind: 'fact', status: 'active', links: 1 }],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }], total: 3 }, 200, 120)
    expect(placeMapLabels(side, { open: null, selected: null, hovered: 'a', rest: 0, measure }).find((label) => label.id === 'a')?.anchor).toMatch(/start|end/)
    const belt = layout.nodes.find((node) => node.group === -1)!
    const labels = placeMapLabels(layout, { open: null, selected: null, hovered: belt.id, rest: 24, measure })
    expect(labels.some((label) => label.id === belt.id)).toBe(true)
    expect(touch(labels)).toBe(0)
    const dense1000 = layoutMap(dense(1000, 3000), 940, 640)
    const busy = placeMapLabels(dense1000, { open: null, selected: dense1000.nodes[5]!.id, hovered: dense1000.nodes[9]!.id, rest: 24, measure })
    expect(touch(busy)).toBe(0)
  })

  it('finds the note under the pointer within reach, and arrows move to the nearest note that way', () => {
    const layout = layoutMap(shapeOfToday(), 940, 640)
    const node = layout.nodes[0]!
    expect(nearestNote(layout, { x: node.x + 1, y: node.y })).toBe(node.id)
    expect(nearestNote(layout, { x: 1, y: 1 })).toBeNull()
    const right = mapStep(layout, node.id, 'ArrowRight')
    expect(right).not.toBe(node.id)
    expect(layout.nodes.find((each) => each.id === right)!.x).toBeGreaterThan(node.x)
  })
})
