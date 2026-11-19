// MODULE: brain-page.test.ts - The Brain page's reads on a synthetic store: list order, every-word search, links, history and the capped neighbourhood (Epic 128)
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { describe, it, expect } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore, type BrainImport } from './brain-store'
import { BrainPageReader, GRAPH_RING_PLACES, queryWords, summaryLine } from './brain-page'
const SQLite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection

const note = (title: string, markdown: string, extra: Partial<BrainImport> = {}): BrainImport =>
  ({ source: `synthetic/${title}.md`, title, kind: 'fact', origin: 'import', scope: 'all', markdown, status: 'active', source_time: '2026-01-01T00:00:00.000Z', ...extra })

function brain(notes: BrainImport[]): { store: BrainStore; page: BrainPageReader; id(title: string): string; close(): void } {
  const store = new BrainStore(new SQLite(':memory:'))
  store.importNotes(notes)
  const ids = new Map(store.list().map((each) => [each.title, each.id]))
  return { store, page: new BrainPageReader(store.database), id: (title) => ids.get(title)!, close: () => store.database.close() }
}

describe('Brain page list and search', () => {
  it('lists visible notes newest change first, pages them and counts withdrawn ones apart', () => {
    const b = brain([
      note('Old fact', 'Old text.', { source_time: '2026-01-01T00:00:00.000Z' }),
      note('New fact', '# Heading\n\nNew text line.', { source_time: '2026-03-01T00:00:00.000Z' }),
      note('Archived fact', 'Archived text.', { status: 'archived', source_time: '2026-04-01T00:00:00.000Z' }),
      note('Gone fact', 'Gone text.', { source_time: '2026-02-01T00:00:00.000Z' })
    ])
    try {
      b.store.setWriteDoor(true)
      b.store.withdraw(b.id('Gone fact'), 1, 'synthetic-session')
      const first = b.page.list()
      expect(first.notes.map((n) => n.title)).toEqual(['New fact', 'Old fact'])
      expect(first.notes[0]!.summary).toBe('New text line.')
      expect(first).toMatchObject({ total: 2, withdrawn: 1, offset: 0 })
      expect(b.page.list({ archived: true }).notes.map((n) => n.title)).toEqual(['Archived fact', 'New fact', 'Old fact'])
      expect(b.page.list({ withdrawn: true }).notes.map((n) => n.title)).toEqual(['Gone fact'])
      expect(b.page.list({ offset: 1, limit: 1 }).notes.map((n) => n.title)).toEqual(['Old fact'])
    } finally { b.close() }
  })

  it('finds notes that hold every word in any order, not only the phrase, and leaves the agents search as it was', () => {
    const b = brain([
      note('Backup plan', 'The nightly backup runs at three. A later paragraph names the decision.'),
      note('Decision log', 'Each decision is written here, with no word about copies.'),
      note('Phrase note', 'This backup decision is one phrase.')
    ])
    try {
      expect(b.page.search('decision backup').notes.map((n) => n.title).sort()).toEqual(['Backup plan', 'Phrase note'])
      // The store's own search, which `bmn brain search` uses, still matches the exact phrase only.
      expect(b.store.search('decision backup').map((n) => n.title)).toEqual([])
      expect(b.store.search('backup decision').map((n) => n.title)).toEqual(['Phrase note'])
      expect(b.page.search('BACKUP').notes).toHaveLength(2)
      expect(b.page.search('backup').notes.find((n) => n.title === 'Backup plan')!.summary).toContain('nightly backup')
    } finally { b.close() }
  })

  it('counts every typed word, the thirteenth too, and never cuts a long word short (pre-review 2)', () => {
    // Twelve distinct words the note holds, then a thirteenth it lacks; and a stored 100-letter word asked with one more letter.
    const twelve = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
    const long = 'q'.repeat(100)
    const b = brain([note('Twelve', `${twelve} and ${long}.`)])
    try {
      expect(b.page.search(twelve).notes.map((n) => n.title)).toEqual(['Twelve'])
      expect(b.page.search(`${twelve} mike`).notes).toEqual([])
      expect(b.page.search(long).notes.map((n) => n.title)).toEqual(['Twelve'])
      expect(b.page.search(`${long}z`).notes).toEqual([])
    } finally { b.close() }
  })

  it('checks a word under three characters in the text before the 10-result limit', () => {
    const many = Array.from({ length: 14 }, (_, i) => note(`Backup ${String(i).padStart(2, '0')}`, `A backup note number ${i}.`))
    const b = brain([...many, note('Backup with QA', 'The QA backup drill.'), note('QA only', 'QA without the other word.')])
    try {
      const found = b.page.search('QA backup')
      expect(found.notes.map((n) => n.title)).toEqual(['Backup with QA'])
      expect(found.limited).toBe(false)
      const wide = b.page.search('backup')
      expect(wide.notes).toHaveLength(10)
      expect(wide.limited).toBe(true)
      expect(b.page.search('QA').notes.map((n) => n.title).sort()).toEqual(['Backup with QA', 'QA only'])
      expect(b.page.search('   ').notes).toEqual([])
    } finally { b.close() }
  })

  it('keeps archived notes out of search until shown, and withdrawn ones always', () => {
    const b = brain([note('Live', 'shared word'), note('Kept', 'shared word', { status: 'archived' }), note('Gone', 'shared word')])
    try {
      b.store.setWriteDoor(true)
      b.store.withdraw(b.id('Gone'), 1, 'synthetic-session')
      expect(b.page.search('shared word').notes.map((n) => n.title)).toEqual(['Live'])
      expect(b.page.search('shared word', true).notes.map((n) => n.title).sort()).toEqual(['Kept', 'Live'])
    } finally { b.close() }
  })

  it('splits a query into distinct words and summarises a note by its first text line', () => {
    expect(queryWords('  a  b a ')).toEqual(['a', 'b'])
    expect(summaryLine('# Title\n\n---\nFirst   line\nSecond')).toBe('First line')
    expect(summaryLine('# T\nalpha\nbeta gamma', ['GAMMA'])).toBe('beta gamma')
    expect(summaryLine('Part of [[Backup plan]] and [[Store schema|the schema]].')).toBe('Part of Backup plan and the schema.')
  })
})

describe('Brain page note, links and history', () => {
  it('reads a note with links in its own order, links back, projects and names not in the brain', () => {
    const b = brain([
      note('Hub', 'See [[Zeta]] and [[Alpha|the first]] and [[Nowhere]]; code in [repo](~/code/repo).'),
      note('Alpha', 'Back to [[Hub]].'),
      note('Zeta', 'Plain.'),
      note('Gone', 'Also [[Hub]].')
    ])
    try {
      b.store.setWriteDoor(true)
      b.store.withdraw(b.id('Gone'), 1, 'synthetic-session')
      const hub = b.page.read(b.id('Hub'))
      expect(hub.linksTo.map((n) => n.title)).toEqual(['Zeta', 'Alpha'])
      expect(hub.linkedFrom.map((n) => n.title)).toEqual(['Alpha'])
      expect(hub.projects).toEqual(['~/code/repo'])
      expect(hub.missing).toEqual(['Nowhere'])
      expect(hub.targets).toEqual({ Zeta: b.id('Zeta'), Alpha: b.id('Alpha'), Nowhere: null })
      expect(hub).toMatchObject({ kind: 'fact', status: 'active', origin: 'import', revision: 1 })
      expect(b.page.read(b.id('Gone')).status).toBe('withdrawn')
      expect(() => b.page.read('no-such-id')).toThrow(/not found/)
    } finally { b.close() }
  })

  it('lists every version newest first, read-only', () => {
    const b = brain([note('Changing', 'First.')])
    try {
      b.store.setWriteDoor(true)
      b.store.edit(b.id('Changing'), 1, { title: 'Changing', kind: 'fact', origin: 'agent', scope: 'all', markdown: 'Second.' }, 'synthetic-session')
      expect(b.page.history(b.id('Changing')).map((v) => [v.revision, v.action, v.markdown])).toEqual([[2, 'edit', 'Second.'], [1, 'import', 'First.']])
    } finally { b.close() }
  })
})

describe('Brain page neighbourhood (D7)', () => {
  it('draws a note with no visible neighbour alone at depth 1', () => {
    const b = brain([note('Alone', 'Nothing linked.'), note('Other', 'Also alone.')])
    try {
      const graph = b.page.graph(b.id('Alone'))
      expect(graph).toMatchObject({ depth: 1, edges: [], more: [0, 0, 0] })
      expect(graph.nodes.map((n) => n.title)).toEqual(['Alone'])
    } finally { b.close() }
  })

  it('walks links both ways only between visible notes; archived ones join when shown, withdrawn ones never', () => {
    const b = brain([
      note('Focus', '[[Live]] [[Kept]] [[Gone]]'),
      note('Live', 'plain'),
      note('Kept', 'plain', { status: 'archived' }),
      note('Gone', 'plain'),
      note('Back', 'points to [[Focus]]')
    ])
    try {
      b.store.setWriteDoor(true)
      b.store.withdraw(b.id('Gone'), 1, 'synthetic-session')
      expect(b.page.graph(b.id('Focus'), { depth: 1 }).nodes.map((n) => n.title).sort()).toEqual(['Back', 'Focus', 'Live'])
      const shown = b.page.graph(b.id('Focus'), { depth: 1, archived: true })
      expect(shown.nodes.map((n) => n.title).sort()).toEqual(['Back', 'Focus', 'Kept', 'Live'])
      expect(shown.edges.every((edge) => edge.tree && edge.from === b.id('Focus'))).toBe(true)
      // A hidden note has no graph of its own: withdrawn never, archived only when shown.
      expect(() => b.page.graph(b.id('Gone'), { archived: true })).toThrow(/not shown in the graph/)
      expect(() => b.page.graph(b.id('Kept'))).toThrow(/not shown in the graph/)
      expect(b.page.graph(b.id('Kept'), { depth: 1, archived: true }).nodes.map((n) => n.title)).toEqual(['Kept', 'Focus'])
    } finally { b.close() }
  })

  it('opens at the least depth that draws 8 nodes, else the deepest there is', () => {
    // A chain: Focus - A - B - C, with B also linked to 6 leaves.
    const leaves = Array.from({ length: 6 }, (_, i) => note(`Leaf ${i}`, 'plain'))
    const b = brain([
      note('Focus', '[[A]]'), note('A', '[[B]]'), note('B', `[[C]] ${leaves.map((l) => `[[${l.title}]]`).join(' ')}`), note('C', 'plain'), ...leaves,
      note('Short', '[[Tip]]'), note('Tip', 'plain')
    ])
    try {
      const graph = b.page.graph(b.id('Focus'))
      expect(graph.depth).toBe(3)
      expect(graph.nodes).toHaveLength(10)
      expect(graph.nodes.find((n) => n.title === 'C')).toMatchObject({ depth: 3, parent: b.id('B') })
      expect(b.page.graph(b.id('B')).depth).toBe(1)
      expect(b.page.graph(b.id('Short')).depth).toBe(1)
      expect(b.page.graph(b.id('Focus'), { depth: 2 }).nodes).toHaveLength(3)
    } finally { b.close() }
  })

  it('caps rings at 36, 60 and 53, most links first, passing unused places on, and counts the rest', () => {
    const ring1 = Array.from({ length: 40 }, (_, i) => `R1 ${String(i).padStart(2, '0')}`)
    const notes = [note('Focus', ring1.map((t) => `[[${t}]]`).join(' '))]
    // The last four ring-1 notes have one extra link each, so they are kept first.
    ring1.forEach((title, i) => notes.push(note(title, i >= 36 ? `[[Deep ${i}]]` : 'plain')))
    for (let i = 36; i < 40; i += 1) notes.push(note(`Deep ${i}`, 'plain'))
    const b = brain(notes)
    try {
      const graph = b.page.graph(b.id('Focus'), { depth: 2 })
      const first = graph.nodes.filter((n) => n.depth === 1)
      expect(first).toHaveLength(GRAPH_RING_PLACES[0])
      expect(first.slice(0, 4).map((n) => n.title)).toEqual(['R1 36', 'R1 37', 'R1 38', 'R1 39'])
      expect(graph.more).toEqual([4, 0, 0])
      expect(graph.nodes.filter((n) => n.depth === 2)).toHaveLength(4)
      expect(graph.nodes.every((n) => n.depth === 0 || graph.nodes.some((p) => p.id === n.parent))).toBe(true)
    } finally { b.close() }
  })

  it('stays within 150 nodes and quick on a 1,000-note, 3,000-link brain', () => {
    // Synthetic: each note links to three others picked by a fixed pseudo-random sequence, so depth 3 passes the cap.
    const titles = Array.from({ length: 1000 }, (_, i) => `Synthetic ${i}`)
    let seed = 128
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 1000 }
    const b = brain(titles.map((title, i) => note(title, [0, 1, 2].map(() => { let to = next(); if (to === i) to = (to + 1) % 1000; return `[[${titles[to]}]]` }).join(' '))))
    try {
      const start = performance.now()
      const graph = b.page.graph(b.id('Synthetic 0'), { depth: 3 })
      const took = performance.now() - start
      expect(graph.nodes.length).toBeLessThanOrEqual(150)
      expect(graph.nodes.length).toBeGreaterThan(100)
      expect(graph.more.reduce((a, c) => a + c, 0)).toBeGreaterThan(0)
      console.log(JSON.stringify({ notes: 1000, links: 3000, nodes: graph.nodes.length, edges: graph.edges.length, ms: Math.round(took) }))
      expect(took).toBeLessThan(100)
      const listStart = performance.now()
      expect(b.page.list().notes).toHaveLength(100)
      expect(b.page.search('Synthetic 99').notes.length).toBeGreaterThan(0)
      expect(performance.now() - listStart).toBeLessThan(100)
    } finally { b.close() }
  }, 30_000)
})

describe('Brain page whole-brain map (128.5)', () => {
  it('holds every visible note and each link between visible notes once; archived ones join when shown, withdrawn ones never', () => {
    const b = brain([
      note('Hub', '[[Live]] [[Kept]] [[Gone]] [[Nowhere]]'),
      note('Live', 'back to [[Hub]]'),
      note('Kept', 'plain', { status: 'archived' }),
      note('Gone', 'plain'),
      note('Alone', 'no links')
    ])
    try {
      b.store.setWriteDoor(true)
      b.store.withdraw(b.id('Gone'), 1, 'synthetic-session')
      const map = b.page.map()
      expect(map.nodes.map((n) => n.title)).toEqual(['Hub', 'Live', 'Alone'])
      expect(map.total).toBe(3)
      // Hub and Live link both ways: one link, drawn once, in id order.
      expect(map.edges).toEqual([b.id('Hub') < b.id('Live') ? { from: b.id('Hub'), to: b.id('Live') } : { from: b.id('Live'), to: b.id('Hub') }])
      expect(map.nodes.find((n) => n.title === 'Hub')!.links).toBe(1)
      const shown = b.page.map({ archived: true })
      expect(shown.nodes.map((n) => n.title).sort()).toEqual(['Alone', 'Hub', 'Kept', 'Live'])
      expect(shown.edges).toHaveLength(2)
      expect(shown.nodes.find((n) => n.title === 'Hub')!.links).toBe(2)
    } finally { b.close() }
  })

  it('above the cap keeps the busiest notes, only links between kept notes, and counts every visible note', () => {
    const b = brain([note('Hub', '[[A]] [[B]] [[C]]'), note('A', '[[B]]'), note('B', 'plain'), note('C', 'plain'), note('Lone', 'plain')])
    try {
      const map = b.page.map({ limit: 3 })
      expect(map.total).toBe(5)
      expect(map.nodes.map((n) => n.title)).toEqual(['Hub', 'A', 'B'])
      const kept = new Set(map.nodes.map((n) => n.id))
      expect(map.edges.every((edge) => kept.has(edge.from) && kept.has(edge.to))).toBe(true)
      expect(map.edges).toHaveLength(3)
    } finally { b.close() }
  })

  it('reads a 1,000-note, 3,000-link brain quickly', () => {
    const titles = Array.from({ length: 1000 }, (_, i) => `Synthetic ${i}`)
    let seed = 1285
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 1000 }
    const b = brain(titles.map((title, i) => note(title, [0, 1, 2].map(() => { let to = next(); if (to === i) to = (to + 1) % 1000; return `[[${titles[to]}]]` }).join(' '))))
    try {
      const start = performance.now()
      const map = b.page.map()
      const took = performance.now() - start
      expect(map.nodes).toHaveLength(1000)
      expect(map.edges.length).toBeGreaterThan(2500)
      expect(new Set(map.edges.map((edge) => `${edge.from} ${edge.to}`)).size).toBe(map.edges.length)
      expect(map.edges.every((edge) => edge.from < edge.to)).toBe(true)
      console.log(JSON.stringify({ map: true, notes: map.nodes.length, links: map.edges.length, ms: Math.round(took) }))
      expect(took).toBeLessThan(200)
    } finally { b.close() }
  }, 30_000)
})
