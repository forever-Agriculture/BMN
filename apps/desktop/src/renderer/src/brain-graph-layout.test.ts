// MODULE: brain-graph-layout.test.ts - Epic 128 128.2 AC2: orbits, angles, the label rule (G3), kind colours (C4), keys and the tween at 1, 3, 8, 15 and 150 nodes
import type { BrainGraph, BrainGraphNode } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { graphStep, kindColour, labelText, layoutGraph, placeLabels, tweenPoints, LABEL_CHARS } from './brain-graph-layout'

const KINDS = ['fact', 'project', 'map', 'reference', 'lesson', 'preference', 'feedback', 'user', 'check']
const LONG = 'A synthetic note whose title is much longer than any label may be'

/** A neighbourhood of n nodes: the focus, then rings of up to 6, 36 and the rest, each child under a parent in the ring before. */
function graph(n: number, title = (i: number) => `${LONG} ${i}`): BrainGraph {
  const nodes: BrainGraphNode[] = [{ id: 'n0', title: title(0), kind: 'fact', status: 'active', depth: 0, parent: null, links: 6 }]
  const rings: string[][] = [['n0']]
  for (let i = 1; i < n; i += 1) {
    const depth = i <= 6 ? 1 : i <= 42 ? 2 : 3
    const parents = rings[depth - 1]!
    const parent = parents[i % parents.length]!
    nodes.push({ id: `n${i}`, title: title(i), kind: KINDS[i % KINDS.length]!, status: i % 11 === 0 ? 'archived' : 'active', depth, parent, links: 1 + (i % 5) })
    ;(rings[depth] ??= []).push(`n${i}`)
  }
  const edges = nodes.filter((node) => node.parent).map((node) => ({ from: node.parent!, to: node.id, tree: true }))
  return { focus: 'n0', depth: Math.max(1, ...nodes.map((node) => node.depth)) as 1 | 2 | 3, nodes, edges, more: [0, 0, 0] }
}
const measure = (text: string): number => text.length * 6.6

describe('graph layout on fixed orbits', () => {
  it('puts the focus in the centre and every node inside the pane', () => {
    for (const [width, height] of [[940, 680], [690, 600]] as const) {
      for (const n of [1, 3, 8, 15, 150]) {
        const layout = layoutGraph(graph(n), width, height)
        expect(layout.nodes[0]).toMatchObject({ x: width / 2, y: height / 2 })
        for (const node of layout.nodes) {
          expect(node.x - node.r).toBeGreaterThanOrEqual(0)
          expect(node.x + node.r).toBeLessThanOrEqual(width)
          expect(node.y - node.r).toBeGreaterThanOrEqual(0)
          expect(node.y + node.r).toBeLessThanOrEqual(height)
        }
      }
    }
  })

  it('places the first of three or more depth-1 notes at the top, and one or two at 0 degrees', () => {
    const three = layoutGraph(graph(4), 940, 680)
    expect(Math.min(...three.nodes.filter((n) => n.depth === 1).map((n) => Math.abs(n.angle + 90)))).toBeLessThan(1e-9)
    const two = layoutGraph(graph(3), 940, 680)
    expect(two.nodes.filter((n) => n.depth === 1).map((n) => n.angle)).toContain(0)
  })

  it('uses the larger radii and shows the ring lines at 15 nodes or fewer', () => {
    const small = layoutGraph(graph(15), 940, 680)
    expect(small.showRings).toBe(true)
    expect(small.nodes[0]!.r).toBe(12)
    const large = layoutGraph(graph(150), 940, 680)
    expect(large.showRings).toBe(false)
    expect(large.nodes[0]!.r).toBe(9)
    expect(large.nodes.find((n) => n.depth === 3)!.r).toBe(2.2)
  })

  it('puts a "+ N more" chip at 90 degrees on each full ring', () => {
    const capped = { ...graph(50), more: [0, 12, 0] as [number, number, number] }
    const layout = layoutGraph(capped, 940, 680)
    expect(layout.chips).toEqual([{ depth: 2, more: 12, x: 470, y: 340 + layout.rings[1]!.b }])
  })
})

describe('labels never touch (G3)', () => {
  const touch = (p: { x: number; y: number; width: number }, q: { x: number; y: number; width: number }): boolean =>
    // Each label's box: its text width plus 4 px padding on every side, from 11 px above the baseline to 3 px below.
    Math.abs(p.x - q.x) < (p.width + q.width) / 2 + 8 && Math.abs(p.y - q.y) < 11 + 3 + 8
  for (const [width, height] of [[940, 680], [690, 600]] as const) {
    for (const n of [1, 3, 8, 15, 150]) {
      it(`at ${n} nodes in ${width} x ${height}`, () => {
        const layout = layoutGraph(graph(n), width, height)
        const selected = layout.nodes.at(-1)!.id
        const labels = placeLabels(layout, { selected, hovered: null, measure })
        for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) expect(touch(labels[i]!, labels[j]!)).toBe(false)
        // The focus label is always drawn first; every label is cut at 24 characters.
        expect(labels[0]!.id).toBe('n0')
        expect(labels.every((label) => [...label.text].length <= LABEL_CHARS)).toBe(true)
        // At 15 nodes or fewer every node is tried; above, deeper notes are labelled only on hover or selection.
        if (n > 15) expect(labels.every((label) => layout.nodes.find((node) => node.id === label.id)!.depth <= 1 || label.id === selected)).toBe(true)
      })
    }
  }

  it('draws the focus label when the focus and the selected label cannot both fit (D7)', () => {
    const layout = layoutGraph(graph(2, () => 'Same place'), 300, 200)
    // Put the selected note right on top of the focus.
    layout.nodes[1] = { ...layout.nodes[1]!, x: layout.nodes[0]!.x, y: layout.nodes[0]!.y + 4 }
    const labels = placeLabels(layout, { selected: 'n1', hovered: null, measure })
    expect(labels.map((label) => label.id)).toEqual(['n0'])
  })

  it('always names the focus, even in a crowded narrow pane with another note selected (review)', () => {
    for (const [width, height] of [[256, 420], [300, 360], [690, 600]] as const) {
      const layout = layoutGraph(graph(150), width, height)
      const labels = placeLabels(layout, { selected: layout.nodes.at(-1)!.id, hovered: null, measure })
      const focus = labels.find((label) => label.id === 'n0')
      expect(focus).toBeDefined()
      expect(focus!.x - focus!.width / 2).toBeGreaterThanOrEqual(0)
      expect(focus!.x + focus!.width / 2).toBeLessThanOrEqual(width)
      for (const other of labels.filter((label) => label.id !== 'n0')) expect(touch(focus!, other)).toBe(false)
    }
  })

  it('cuts a long title at 24 characters', () => {
    expect(labelText('Short')).toBe('Short')
    expect([...labelText(LONG)]).toHaveLength(24)
    expect(labelText(LONG).endsWith('…')).toBe(true)
  })
})

describe('kind colours (C4), keys and motion', () => {
  it('gives each kind its family hue, archived notes the faint one and unknown kinds the muted one', () => {
    expect(kindColour('project', 'active')).toBe(kindColour('fact', 'active'))
    expect(kindColour('reference', 'active')).toBe(kindColour('map', 'active'))
    expect(kindColour('feedback', 'active')).toBe(kindColour('preference', 'active'))
    expect(kindColour('user', 'active')).toBe(kindColour('preference', 'active'))
    expect(kindColour('lesson', 'archived')).toBe('var(--faint)')
    expect(kindColour('something', 'active')).toBe('var(--muted)')
  })

  it('moves along the ring with Left and Right, to the parent with Up and the first child with Down', () => {
    const layout = layoutGraph(graph(15), 940, 680)
    const ring = layout.nodes.filter((n) => n.depth === 1).sort((p, q) => p.angle - q.angle)
    expect(graphStep(layout, ring[0]!.id, 'ArrowRight')).toBe(ring[1]!.id)
    expect(graphStep(layout, ring[0]!.id, 'ArrowLeft')).toBe(ring.at(-1)!.id)
    expect(graphStep(layout, ring[0]!.id, 'ArrowUp')).toBe('n0')
    expect(layout.nodes.find((n) => n.id === graphStep(layout, 'n0', 'ArrowDown'))!.depth).toBe(1)
    expect(graphStep(layout, 'n0', 'ArrowRight')).toBe('n0')
  })

  it('tweens from the old places, new nodes leaving their parent, and rests at the end', () => {
    const layout = layoutGraph(graph(3), 940, 680)
    const from = new Map([['n0', { x: 0, y: 0 }]])
    const start = tweenPoints(from, layout.nodes, 0)
    expect(start.get('n1')).toEqual({ x: 0, y: 0 })
    const end = tweenPoints(from, layout.nodes, 1)
    for (const node of layout.nodes) expect(end.get(node.id)).toEqual({ x: node.x, y: node.y })
  })
})
