// MODULE: brain-page.ts - The Brain page's read-only view of the store: paged summaries, every-word search, a note with its links, history and a capped neighbourhood (Epic 128)
import type { DatabaseConnection } from './database-initialization'
import type { BrainGraph, BrainGraphNode, BrainPageList, BrainPageNote, BrainPageNoteRef, BrainPageSearch, BrainPageSummary, BrainPageVersion, BrainPageStatus as BrainStatus } from '@bmn/protocol'
import { BrainError } from './brain-store'
export type { BrainGraph, BrainPageList, BrainPageNote, BrainPageSearch, BrainPageVersion } from '@bmn/protocol'

/** The 150-node cap after the focus: 36, 60 and 53 by ring; a ring's unused places pass to the next (Epic 128 D7). */
export const GRAPH_RING_PLACES = [36, 60, 53] as const
export const GRAPH_OPEN_NODES = 8
export const BRAIN_PAGE_LIST_LIMIT = 100
export const BRAIN_PAGE_SEARCH_LIMIT = 10

const HEAD = `FROM brain_note n JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision`
const NEWEST = 'ORDER BY julianday(v.source_time) DESC, v.recorded_at DESC, n.id'

/** The first line of a note that is not a heading, rule or blank, as one line of at most 180 characters. */
export function summaryLine(markdown: string, words: readonly string[] = []): string {
  const lines = markdown.split('\n').map((line) => line.trim()).filter((line) => line && !/^(?:#{1,6}\s|---+$|```)/u.test(line))
  const lower = words.map((word) => word.toLocaleLowerCase('und'))
  const hit = lower.length ? lines.find((line) => lower.some((word) => line.toLocaleLowerCase('und').includes(word))) : undefined
  // A link reads as its words: [[Name|label]] shows "label", [[Name]] shows "Name".
  return (hit ?? lines[0] ?? '').replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/gu, (_, name: string, label?: string) => (label ?? name).trim())
    .replace(/\s+/gu, ' ').slice(0, 180)
}

/** The words of a query: split on spaces, each at most 100 characters, at most 12 of them. */
export function queryWords(query: string): string[] {
  return [...new Set(query.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).map((word) => word.slice(0, 100)))].slice(0, 12)
}

function statusesFor(archived: boolean): readonly BrainStatus[] { return archived ? ['active', 'archived'] : ['active'] }

export class BrainPageReader {
  constructor(private readonly database: DatabaseConnection) {}

  private summary(row: { id: string; title: string; kind: string; status: BrainStatus; source_time: string; markdown: string }, words: readonly string[] = []): BrainPageSummary {
    return { id: row.id, title: row.title, kind: row.kind, status: row.status, changed: row.source_time, summary: summaryLine(row.markdown, words) }
  }

  /** A page of notes, newest change first: visible ones, or with `withdrawn` only the withdrawn ones. */
  list(options: { archived?: boolean; withdrawn?: boolean; offset?: number; limit?: number } = {}): BrainPageList {
    const statuses = options.withdrawn ? ['withdrawn'] : statusesFor(options.archived === true)
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = Math.min(BRAIN_PAGE_LIST_LIMIT, Math.max(1, Math.trunc(options.limit ?? BRAIN_PAGE_LIST_LIMIT)))
    const marks = statuses.map(() => '?').join(',')
    const rows = this.database.prepare(`SELECT n.id, n.status, v.title, v.kind, v.source_time, v.markdown ${HEAD}
      WHERE n.status IN (${marks}) ${NEWEST} LIMIT ? OFFSET ?`).all(...statuses, limit, offset) as Parameters<BrainPageReader['summary']>[0][]
    const total = (this.database.prepare(`SELECT count(*) AS c FROM brain_note WHERE status IN (${marks})`).get(...statuses) as { c: number }).c
    const withdrawn = (this.database.prepare("SELECT count(*) AS c FROM brain_note WHERE status='withdrawn'").get() as { c: number }).c
    return { notes: rows.map((row) => this.summary(row)), total, withdrawn, offset }
  }

  /**
   * Notes that hold every typed word, in any order (R128-FR1, 128.1 AC2). Words of 3 or more characters use the
   * store's trigram index; shorter ones are checked in the text. Short words are checked before the 10-result limit.
   */
  search(query: string, archived = false): BrainPageSearch {
    const words = queryWords(query)
    if (!words.length) return { notes: [], limited: false }
    const statuses = statusesFor(archived)
    const marks = statuses.map(() => '?').join(',')
    const long = words.filter((word) => [...word].length >= 3)
    const short = words.filter((word) => [...word].length < 3).map((word) => word.toLocaleLowerCase('und'))
    const holdsShort = (row: { title: string; markdown: string }): boolean => {
      if (!short.length) return true
      const text = (row.title + '\n' + row.markdown).toLocaleLowerCase('und')
      return short.every((word) => text.includes(word))
    }
    type Row = Parameters<BrainPageReader['summary']>[0]
    const rows: Iterable<Row> = long.length
      ? this.database.prepare(`SELECT n.id, n.status, v.title, v.kind, v.source_time, v.markdown, bm25(brain_search,0,5,1) AS score
          FROM brain_search JOIN brain_note n ON n.id=brain_search.note
          JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision
          WHERE brain_search MATCH ? AND n.status IN (${marks}) ORDER BY score, n.id`)
        .iterate(long.map((word) => '"' + word.replaceAll('"', '""') + '"').join(' AND '), ...statuses) as Iterable<Row>
      : this.database.prepare(`SELECT n.id, n.status, v.title, v.kind, v.source_time, v.markdown ${HEAD}
          WHERE n.status IN (${marks}) ${NEWEST}`).iterate(...statuses) as Iterable<Row>
    const notes: BrainPageSummary[] = []
    let limited = false
    for (const row of rows) {
      if (!holdsShort(row)) continue
      if (notes.length === BRAIN_PAGE_SEARCH_LIMIT) { limited = true; break }
      notes.push(this.summary(row, words))
    }
    return { notes, limited }
  }

  private ref(id: string): BrainPageNoteRef | undefined {
    return this.database.prepare(`SELECT n.id, n.status, v.title, v.kind ${HEAD} WHERE n.id=?`).get(id) as BrainPageNoteRef | undefined
  }

  /** A note by its id, any status, with what it links to and what links to it; withdrawn notes are never listed as links. */
  read(id: string): BrainPageNote {
    const row = this.database.prepare(`SELECT n.id, n.status, v.title, v.kind, v.origin, v.scope, v.source_time, v.recorded_at, v.revision, v.markdown ${HEAD} WHERE n.id=?`)
      .get(id) as { id: string; status: BrainStatus; title: string; kind: string; origin: string; scope: string; source_time: string; recorded_at: string; revision: number; markdown: string } | undefined
    if (!row) throw new BrainError('NOT_FOUND', 'Brain note not found')
    const links = this.database.prepare('SELECT kind, target, resolved FROM brain_link WHERE note=? ORDER BY rowid').all(id) as { kind: 'note' | 'project'; target: string; resolved: string | null }[]
    const order = new Map<string, number>()
    for (const match of row.markdown.matchAll(/\[\[([^\]|#]+)/gu)) { const name = match[1]!.trim(); if (!order.has(name)) order.set(name, order.size) }
    const byPlace = (a: { target: string }, b: { target: string }): number => (order.get(a.target) ?? 1e9) - (order.get(b.target) ?? 1e9)
    const noteLinks = links.filter((link) => link.kind === 'note').sort(byPlace)
    const targets: Record<string, string | null> = {}
    const linksTo: BrainPageNoteRef[] = []
    const missing: string[] = []
    for (const link of noteLinks) {
      const target = link.resolved ? this.ref(link.resolved) : undefined
      const reachable = target && target.status !== 'withdrawn' ? target : undefined
      targets[link.target] = reachable?.id ?? null
      if (!reachable) missing.push(link.target)
      else if (!linksTo.some((each) => each.id === reachable.id)) linksTo.push(reachable)
    }
    const linkedFrom = (this.database.prepare(`SELECT DISTINCT n.id, n.status, v.title, v.kind FROM brain_link l
      JOIN brain_note n ON n.id=l.note JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision
      WHERE l.resolved=? AND l.kind='note' AND n.status!='withdrawn' AND n.id<>? ORDER BY v.title, n.id`).all(id, id) as BrainPageNoteRef[])
    return {
      id: row.id, title: row.title, kind: row.kind, status: row.status, origin: row.origin, scope: row.scope,
      changed: row.source_time, recorded: row.recorded_at, revision: row.revision, markdown: row.markdown,
      linksTo, linkedFrom, projects: links.filter((link) => link.kind === 'project').map((link) => link.target), missing, targets
    }
  }

  /** Every version of a note, newest first; read-only (Epic 128: History restores nothing). */
  history(id: string): BrainPageVersion[] {
    if (!this.ref(id)) throw new BrainError('NOT_FOUND', 'Brain note not found')
    return (this.database.prepare(`SELECT revision, action, title, kind, origin, status, recorded_at AS recorded, source_time AS changed, markdown
      FROM brain_version WHERE note=? ORDER BY revision DESC`).all(id) as BrainPageVersion[])
  }

  /**
   * A note's neighbourhood (Epic 128 D7): links walked only between visible notes (active, plus archived when shown,
   * never withdrawn), in both directions. Ring by ring, most links first, then title; a ring keeps at most its places
   * (unused places pass to the next ring) and only kept notes lead further. With no depth, it opens at the least
   * depth that draws 8 nodes, else the deepest there is.
   */
  graph(id: string, options: { depth?: 1 | 2 | 3; archived?: boolean } = {}): BrainGraph {
    const focus = this.ref(id)
    if (!focus) throw new BrainError('NOT_FOUND', 'Brain note not found')
    const statuses = statusesFor(options.archived === true)
    const marks = statuses.map(() => '?').join(',')
    const visible = new Map((this.database.prepare(`SELECT n.id, n.status, v.title, v.kind ${HEAD} WHERE n.status IN (${marks})`)
      .all(...statuses) as BrainPageNoteRef[]).map((note) => [note.id, note]))
    if (!visible.has(id)) visible.set(id, focus)
    const near = new Map<string, Set<string>>()
    const join = (a: string, b: string): void => { const set = near.get(a) ?? new Set<string>(); set.add(b); near.set(a, set) }
    for (const link of this.database.prepare("SELECT note, resolved FROM brain_link WHERE kind='note' AND resolved IS NOT NULL").iterate() as Iterable<{ note: string; resolved: string }>) {
      if (link.note === link.resolved || !visible.has(link.note) || !visible.has(link.resolved)) continue
      join(link.note, link.resolved); join(link.resolved, link.note)
    }
    const degree = (note: string): number => near.get(note)?.size ?? 0
    const byTitle = (a: string, b: string): number => visible.get(a)!.title.localeCompare(visible.get(b)!.title) || a.localeCompare(b)
    const walk = (depth: number): { rings: string[][]; parent: Map<string, string | null>; more: [number, number, number] } => {
      const seen = new Set([id])
      const parent = new Map<string, string | null>([[id, null]])
      const rings: string[][] = [[id]]
      const more: [number, number, number] = [0, 0, 0]
      let spare = 0
      for (let ring = 1; ring <= depth; ring += 1) {
        // Parents in title order, so a child's parent is the first that finds it, ties by title (design.md).
        const found: string[] = []
        for (const from of [...rings[ring - 1]!].sort(byTitle)) {
          for (const to of [...(near.get(from) ?? [])].sort(byTitle)) {
            if (seen.has(to)) continue
            seen.add(to); parent.set(to, from); found.push(to)
          }
        }
        const places = GRAPH_RING_PLACES[ring - 1]! + spare
        found.sort((a, b) => degree(b) - degree(a) || byTitle(a, b))
        const kept = found.slice(0, places)
        more[ring - 1] = found.length - kept.length
        spare = places - kept.length
        rings.push(kept)
        if (!kept.length) break
      }
      return { rings, parent, more }
    }
    let depth: 1 | 2 | 3 = options.depth ?? 3
    let result = walk(depth)
    if (options.depth === undefined) {
      const counts = [1, 2, 3].map((d) => result.rings.slice(0, d + 1).reduce((sum, ring) => sum + ring.length, 0))
      const enough = counts.findIndex((count) => count >= GRAPH_OPEN_NODES)
      // The deepest there is: the last depth that still adds a note (a lone note opens at depth 1).
      const deepest = Math.max(1, result.rings.slice(1).filter((ring) => ring.length > 0).length)
      depth = (enough === -1 ? deepest : enough + 1) as 1 | 2 | 3
      result = walk(depth)
    }
    const drawn = result.rings.flat()
    const ringOf = new Map(result.rings.flatMap((ring, at) => ring.map((note) => [note, at] as const)))
    const nodes = drawn.map((note): BrainGraphNode => ({ ...visible.get(note)!, depth: ringOf.get(note)!, parent: result.parent.get(note) ?? null, links: degree(note) }))
    const edges: BrainGraph['edges'] = []
    const keyed = new Set<string>()
    for (const from of drawn) {
      for (const to of near.get(from) ?? []) {
        if (!ringOf.has(to)) continue
        const key = from < to ? `${from}\n${to}` : `${to}\n${from}`
        if (keyed.has(key)) continue
        keyed.add(key)
        const tree = result.parent.get(to) === from || result.parent.get(from) === to
        edges.push(result.parent.get(from) === to ? { from: to, to: from, tree } : { from, to, tree })
      }
    }
    for (let ring = depth; ring < 3; ring += 1) result.more[ring as 0 | 1 | 2] = 0
    return { focus: id, depth, nodes, edges, more: result.more }
  }
}
