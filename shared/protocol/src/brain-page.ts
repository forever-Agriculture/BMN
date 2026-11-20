// MODULE: brain-page.ts - What the Brain page reads and asks over its private, read-only route (Epic 128)
export type BrainPageStatus = 'active' | 'archived' | 'withdrawn'

/** One row of the list or of search results: what the page shows without the note's body. */
export interface BrainPageSummary {
  id: string
  title: string
  kind: string
  status: BrainPageStatus
  changed: string
  summary: string
}
export interface BrainPageList { notes: BrainPageSummary[]; total: number; withdrawn: number; offset: number }
export interface BrainPageSearch { notes: BrainPageSummary[]; limited: boolean }
export interface BrainPageNoteRef { id: string; title: string; kind: string; status: BrainPageStatus }
export interface BrainPageNote {
  id: string
  /** The title as the page shows it: a file-name title ("ai-direction") reads as words ("AI direction"). */
  title: string
  /** The title as stored: the name `[[links]]` use. */
  name: string
  kind: string
  status: BrainPageStatus
  origin: string
  scope: string
  changed: string
  recorded: string
  revision: number
  markdown: string
  /** Resolved note links, in the order the note names them. */
  linksTo: BrainPageNoteRef[]
  linkedFrom: BrainPageNoteRef[]
  projects: string[]
  /** Names the note links to that are no note in the brain. */
  missing: string[]
  /** Every link name the note uses, with the note it reaches (null when none), for drawing its text. */
  targets: Record<string, string | null>
}
export interface BrainPageVersion {
  revision: number
  action: string
  /** Shown as BrainPageNote.title; `name` is the title as stored in that version. */
  title: string
  name: string
  /** Every link name this version uses, with the note it reaches today (null when none). */
  targets: Record<string, string | null>
  kind: string
  origin: string
  status: BrainPageStatus
  recorded: string
  changed: string
  markdown: string
}
export interface BrainGraphNode extends BrainPageNoteRef { depth: number; parent: string | null; links: number }
export interface BrainGraph {
  focus: string
  depth: 1 | 2 | 3
  nodes: BrainGraphNode[]
  /** Each drawn link once, as [from, to] in the order found; `tree` marks the edge from a node's parent. */
  edges: { from: string; to: string; tree: boolean }[]
  /** Notes found at each depth that the cap left out, ring by ring (index 0 is depth 1). */
  more: [number, number, number]
}

export interface BrainMapNode extends BrainPageNoteRef { links: number }
/** The whole brain (Epic 128.5): visible notes, busiest first up to the cap, and each link between them once. */
export interface BrainMap {
  nodes: BrainMapNode[]
  /** Each link once, `from` before `to` in id order. */
  edges: { from: string; to: string }[]
  /** Visible notes before the cap; above `nodes.length` the map reads "First N of total". */
  total: number
}

/** One request from the window; each command names its own keys (the route refuses any other). */
export type BrainPageRequest =
  | { command: 'status' }
  | { command: 'list'; archived?: boolean; withdrawn?: boolean; offset?: number }
  | { command: 'search'; query: string; archived?: boolean }
  | { command: 'read'; id: string }
  | { command: 'history'; id: string }
  | { command: 'graph'; id: string; depth?: 1 | 2 | 3; archived?: boolean }
  | { command: 'map'; archived?: boolean }
