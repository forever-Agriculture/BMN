// MODULE: brain-page.tsx - The Brain page (Epic 128): search, read and follow his notes, and a note's neighbourhood graph; it only reads
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { BrainGraph, BrainMap, BrainPageList, BrainPageNote, BrainPageNoteRef, BrainPageRequest, BrainPageSearch, BrainPageSummary, BrainPageVersion } from '@bmn/protocol'
import { Dialog } from './dialog'
import { Segmented } from './history-preferences'
import { markdownPage } from './quick-look-markdown'
import { MarkdownPageView } from './quick-look-page'
import { quickLookSecretRanges, reveal, revealSecondsLeft, viewText, type Reveal } from './quick-look-secrets'
import { BrainGraphView } from './brain-graph'
import { BrainMapView } from './brain-map'
import { kindColour } from './brain-graph-layout'
import './brain-page.css'

export type BrainRead = <Result>(request: BrainPageRequest) => Promise<Result>
/** What the page keeps between openings: the note he last read and the Archived toggle. */
export interface BrainMemory { noteId: string | null; archived: boolean }
export const createBrainMemory = (): BrainMemory => ({ noteId: null, archived: false })

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'not-switched' } | { kind: 'unavailable'; reason: string }
type Depth = 1 | 2 | 3
const CYRILLIC = /[Ѐ-ӿ]/u
const NARROW = 720

const errorText = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'The brain did not answer')

/** "16 Nov", with the year when it is not this year. */
export function brainDate(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}
function brainTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `${brainDate(iso)}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/** True when the note's text opens with a level-1 heading of its own title. */
export function startsWithTitle(note: { title: string; markdown: string }): boolean {
  const first = /^\s*#\s+(.+?)\s*#*\s*$/mu.exec(note.markdown.replace(/^---\n[\s\S]*?\n---\n/u, '').split('\n').find((line) => line.trim()) ?? '')
  return !!first && first[1]!.trim().toLocaleLowerCase('und') === note.title.trim().toLocaleLowerCase('und')
}

/** The words a nothing-found search shows (design.md frame 2). */
export function noResultWords(query: string): string {
  return CYRILLIC.test(query) ? 'No note has these words. The notes are in English, so try English words.' : 'No note has these words. Try one word.'
}

function KindMark(props: { kind: string; status: string }): React.JSX.Element {
  return <span className="b-mark" aria-hidden="true" style={{ background: kindColour(props.kind, props.status) }} />
}

function Chip(props: { children: ReactNode }): React.JSX.Element { return <span className="b-chip">{props.children}</span> }

function NoteRow(props: { note: BrainPageSummary; current: boolean; words?: readonly string[]; onOpen(): void; onPoint(): void }): React.JSX.Element {
  const { note } = props
  return (
    <li>
      <button type="button" className={`b-row${props.current ? ' current' : ''}`} data-note={note.id} tabIndex={-1}
        onClick={props.onOpen} onMouseMove={props.onPoint}>
        <span className="b-row-head">
          <KindMark kind={note.kind} status={note.status} />
          <span className="b-row-title" title={note.title}>{note.title}</span>
          {note.status !== 'active' ? <Chip>{note.status}</Chip> : null}
          <span className="b-row-kind">{note.kind}</span>
          <span className="b-row-date">{brainDate(note.changed)}</span>
        </span>
        <span className="b-row-summary" title={note.summary}>{props.words?.length ? <Marked text={note.summary} words={props.words} /> : note.summary}</span>
      </button>
    </li>
  )
}

/** The typed words marked in a summary line (F2: the selection fill under the words). */
function Marked(props: { text: string; words: readonly string[] }): React.JSX.Element {
  const escaped = props.words.filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  if (!escaped.length) return <>{props.text}</>
  const parts = props.text.split(new RegExp(`(${escaped.join('|')})`, 'giu'))
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index} className="b-hit">{part}</mark> : <span key={index}>{part}</span>))}</>
}

function RefList(props: { title: string; notes: readonly BrainPageNoteRef[]; onOpen(id: string): void }): React.JSX.Element | null {
  if (!props.notes.length) return null
  return (
    <section className="b-section">
      <h3>{props.title} <span className="b-count">{props.notes.length}</span></h3>
      <ul className="b-refs">
        {props.notes.map((note) => (
          <li key={note.id}>
            <button type="button" className="b-ref" onClick={() => props.onOpen(note.id)} title={note.title}>
              <KindMark kind={note.kind} status={note.status} /><span>{note.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NoteFacts(props: { note: BrainPageNote; onHistory(): void }): React.JSX.Element {
  const { note } = props
  return (
    <dl className="kv b-kv">
      <dt>Kind</dt><dd><KindMark kind={note.kind} status={note.status} /> {note.kind}</dd>
      <dt>Status</dt><dd>{note.status}</dd>
      <dt>Origin</dt><dd title={note.origin}>{note.origin}</dd>
      <dt>Scope</dt><dd title={note.scope}>{note.scope}</dd>
      <dt>Last change</dt><dd>{brainTime(note.changed)}</dd>
      <dt>Version</dt><dd className="b-version">{note.revision}<button type="button" className="b-plate small" onClick={props.onHistory} title="History (H)">History…</button></dd>
    </dl>
  )
}

function NoteLinks(props: { note: BrainPageNote; archived: boolean; onOpen(id: string): void }): React.JSX.Element {
  const { note } = props
  const shown = (notes: readonly BrainPageNoteRef[]): BrainPageNoteRef[] => notes.filter((each) => each.status === 'active' || props.archived)
  const [missingOpen, setMissingOpen] = useState(false)
  return (
    <>
      <RefList title="Links to" notes={shown(note.linksTo)} onOpen={props.onOpen} />
      <RefList title="Linked from" notes={shown(note.linkedFrom)} onOpen={props.onOpen} />
      {note.projects.length ? (
        <section className="b-section">
          <h3>Projects <span className="b-count">{note.projects.length}</span></h3>
          <dl className="kv b-paths">{note.projects.map((path) => <dd key={path} className="path" title={path}><bdi>{path}</bdi></dd>)}</dl>
        </section>
      ) : null}
      {note.missing.length ? (
        <section className="b-section">
          <h3><button type="button" className="b-fold" aria-expanded={missingOpen} onClick={() => setMissingOpen(!missingOpen)}>
            Not in the brain <span className="b-count">{note.missing.length}</span></button></h3>
          {missingOpen ? <ul className="b-refs">{note.missing.map((name) => <li key={name} className="b-missing" title="No note with this name">{name}</li>)}</ul> : null}
        </section>
      ) : null}
    </>
  )
}

/** A note's text drawn by Quick Look's Markdown page; a link opens that note, an unresolved one is muted text. */
function NoteText(props: { note: BrainPageNote; onOpen(id: string): void; focus?: boolean }): React.JSX.Element {
  const { note } = props
  const path = `/brain/${note.id}.md`
  // One text for the page and its hidden values: line endings made `\n` as Quick look's view does (viewText).
  const text = useMemo(() => viewText(note.markdown), [note.markdown])
  const page = useMemo(() => {
    const targets: Record<string, string> = {}
    for (const [name, id] of Object.entries(note.targets)) if (id) { targets[`wiki:${name}`] = `/brain-note/${id}` }
    return markdownPage(text, targets)
  }, [text, note.targets])
  const ranges = useMemo(() => quickLookSecretRanges(path, path, text), [path, text])
  const [status, setStatus] = useState('')
  // A value is shown one at a time for ten seconds, as in Quick look; another note or version starts hidden.
  const [held, setShown] = useState<(Reveal & { of: string }) | null>(null)
  const shown = held && held.of === path + '\n' + text && Date.now() < held.until ? held : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!shown) return
    setNow(Date.now())
    const timer = window.setInterval(() => { const at = Date.now(); setNow(at); if (at >= shown.until) setShown(null) }, 250)
    return () => window.clearInterval(timer)
  }, [shown])
  const revealed = shown && shown.index < ranges.length ? shown.index : null
  return (
    <MarkdownPageView page={page} path={path} ranges={ranges} revealed={revealed} secondsLeft={revealSecondsLeft(shown, now)} matches={[]} current={-1}
      line={null} heading={null} topLine={null} focus={props.focus === true} status={status} onStatus={setStatus} unresolvedTitle="No note with this name"
      onReveal={(index) => setShown(shown?.index === index ? null : { ...reveal(index, Date.now()), of: path + '\n' + text })} onTop={() => undefined} onFocus={() => undefined}
      onAddress={(address) => setStatus(`${address} · not opened from the brain`)}
      onOpenFile={(target) => { const id = /^\/brain-note\/([^/]+)$/u.exec(target)?.[1]; if (id) props.onOpen(id) }} />
  )
}

function HistorySheet(props: { note: BrainPageNote; versions: BrainPageVersion[] | null; error: string | null; onClose(): void }): React.JSX.Element {
  const [pick, setPick] = useState<number | null>(null)
  const chosen = props.versions?.find((version) => version.revision === pick) ?? props.versions?.[0] ?? null
  const shown = useMemo(() => (chosen ? { ...props.note, markdown: chosen.markdown, targets: props.note.targets } : null), [chosen, props.note])
  return (
    <div className="b-history" role="region" aria-label={`History of ${props.note.title}`}>
      <div className="b-history-head">
        <h3>History <span className="b-count">{props.versions?.length ?? ''}</span></h3>
        <span className="b-muted">Read-only. Copy text from any version.</span>
        <button type="button" className="b-quiet" onClick={props.onClose}>Close</button>
      </div>
      {props.error ? <p className="b-alert" role="alert">{props.error}</p> : null}
      <div className="b-history-body">
        <ul className="b-versions" aria-label="Versions">
          {(props.versions ?? []).map((version) => (
            <li key={version.revision}>
              <button type="button" className={`b-row${version.revision === chosen?.revision ? ' current' : ''}`} onClick={() => setPick(version.revision)}>
                <span className="b-row-head"><span className="b-row-title">Version {version.revision}</span><span className="b-row-kind">{version.action}</span>
                  <span className="b-row-date">{brainDate(version.recorded)}</span></span>
                <span className="b-row-summary">{version.origin}{version.title !== props.note.title ? ` · ${version.title}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="b-history-text">{shown ? <NoteText key={chosen!.revision} note={shown} onOpen={() => undefined} /> : null}</div>
      </div>
    </div>
  )
}

/** The search shows at most this many notes; at that many the count reads "First 10" (design.md). */
const BRAIN_PAGE_SEARCH_SHOWN = 10

export function BrainSheet(props: { memory: BrainMemory; read?: BrainRead; onClose(): void; reducedMotion?: boolean }): React.JSX.Element {
  const read = useMemo<BrainRead>(() => props.read ?? (<Result,>(request: BrainPageRequest) => window.aiTerminal.brainPage<Result>(request)), [props.read])
  const memory = props.memory
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [archived, setArchivedState] = useState(memory.archived)
  const [list, setList] = useState<BrainPageList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [withdrawn, setWithdrawn] = useState<BrainPageList | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; archived: boolean; found: BrainPageSearch } | null>(null)
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<BrainPageNote | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [view, setView] = useState<'note' | 'graph'>('note')
  const [pane, setPane] = useState<'text' | 'links' | 'graph'>('text')
  const [back, setBack] = useState<string[]>([])
  const [forward, setForward] = useState<string[]>([])
  const [history, setHistory] = useState<{ versions: BrainPageVersion[] | null; error: string | null } | null>(null)
  const [graph, setGraph] = useState<BrainGraph | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [depth, setDepth] = useState<Depth | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [beside, setBeside] = useState<BrainPageNote | null>(null)
  const [narrow, setNarrow] = useState(false)
  // The whole-brain map (Epic 128.5): open from a note or the list; its own selection and side panel.
  const [mapOpen, setMapOpen] = useState(false)
  const [brainMap, setBrainMap] = useState<BrainMap | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapSelected, setMapSelected] = useState<string | null>(null)
  const [mapBeside, setMapBeside] = useState<BrainPageNote | null>(null)
  const mapSeq = useRef(0)
  const focusMap = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const searchSeq = useRef(0)
  const noteSeq = useRef(0)
  const graphSeq = useRef(0)
  const historySeq = useRef(0)
  const listSeq = useRef(0)
  const paging = useRef(new Set<string>())
  const focusGraph = useRef(false)
  const shownNote = useRef<BrainPageNote | null>(null)

  const setArchived = (value: boolean): void => { memory.archived = value; setArchivedState(value) }

  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setNarrow(element.clientWidth < NARROW))
    observer.observe(element)
    setNarrow(element.clientWidth > 0 && element.clientWidth < NARROW)
    return () => observer.disconnect()
  }, [])

  const openNote = useCallback((id: string, how: 'push' | 'back' | 'forward' | 'start' = 'push', keepGraph = false): void => {
    const seq = ++noteSeq.current
    historySeq.current += 1
    setNoteError(null)
    setHistory(null)
    read<BrainPageNote>({ command: 'read', id }).then((next) => {
      if (seq !== noteSeq.current) return
      const current = shownNote.current
      if (current && current.id !== next.id) {
        if (how === 'push') { setBack((stack) => [...stack, current.id].slice(-100)); setForward([]) }
        if (how === 'back') setForward((stack) => [current.id, ...stack].slice(0, 100))
        if (how === 'forward') setBack((stack) => [...stack, current.id].slice(-100))
      }
      // Another note opens at its own depth (D7); a refocus keeps the graph showing, at any width.
      if (current?.id !== next.id) setDepth(null)
      shownNote.current = next
      setNote(next)
      memory.noteId = next.id
      // The link or row that opened it is gone, or the search field held the keys: keep them on the page (G, H).
      requestAnimationFrame(() => {
        const element = box.current
        const active = document.activeElement
        if (!element || keepGraph || element.contains(active) && active !== element && active !== search.current) return
        (element.querySelector<HTMLElement>('.b-text .ql-page') ?? element).focus()
      })
      setQuery('')
      setResults(null)
      if (!keepGraph) setPane('text')
      setSelected(next.id)
    }).catch((error: unknown) => {
      if (seq !== noteSeq.current) return
      if (how === 'start') { memory.noteId = null; return }
      setNoteError(errorText(error))
    })
  }, [read, memory])

  // Status first; then the note he last read, else the list.
  useEffect(() => {
    let live = true
    read<{ state: 'ready' | 'not-switched' }>({ command: 'status' }).then((answer) => {
      if (!live) return
      setStatus(answer.state === 'ready' ? { kind: 'ready' } : { kind: 'not-switched' })
      if (answer.state === 'ready' && memory.noteId) openNote(memory.noteId, 'start')
    }).catch((error: unknown) => { if (live) setStatus({ kind: 'unavailable', reason: errorText(error) }) })
    return () => { live = false }
  }, [read, memory, openNote])

  // The field is disabled until the brain answers; then focus moves to it, unless he has moved it into the page.
  useEffect(() => {
    // Opening on a note leaves the keys with the note (G, H), so only the list puts focus in the field.
    if (status.kind !== 'ready' || memory.noteId) return
    if (!box.current?.contains(document.activeElement)) search.current?.focus()
  }, [status.kind, memory])

  // A first page starts a new list (a new filter); a later page is asked once and joins only the list it was asked for, at its offset.
  const loadList = useCallback((offset: number): void => {
    if (offset === 0) { listSeq.current += 1; paging.current.clear() }
    const seq = listSeq.current
    // A pending page belongs to its own list: an answer for an earlier filter never frees the key of a later one.
    const key = `${seq}:list:${offset}`
    if (offset > 0) { if (paging.current.has(key)) return; paging.current.add(key) }
    read<BrainPageList>({ command: 'list', archived, offset }).then((page) => {
      if (seq !== listSeq.current) return
      setListError(null)
      setList((current) => (offset === 0 ? page : current && page.offset === current.notes.length ? { ...page, notes: [...current.notes, ...page.notes] } : current))
    }).catch((error: unknown) => { if (seq === listSeq.current) setListError(errorText(error)) }).finally(() => paging.current.delete(key))
  }, [read, archived])
  const loadWithdrawn = (offset: number): void => {
    const seq = listSeq.current
    const key = `${seq}:withdrawn:${offset}`
    if (paging.current.has(key)) return
    paging.current.add(key)
    read<BrainPageList>({ command: 'list', withdrawn: true, offset }).then((next) => {
      if (seq !== listSeq.current) return
      setWithdrawn((current) => (offset === 0 ? next : current && next.offset === current.notes.length ? { ...next, notes: [...current.notes, ...next.notes] } : current))
    }).catch((error: unknown) => { if (seq === listSeq.current) setListError(errorText(error)) }).finally(() => paging.current.delete(key))
  }
  useEffect(() => { if (status.kind === 'ready') loadList(0) }, [status.kind, loadList])
  useEffect(() => { setWithdrawn(null) }, [archived])

  // Results replace the list as he types; an older answer never overwrites a newer one.
  useEffect(() => {
    if (status.kind !== 'ready') return
    const typed = query.trim()
    const seq = ++searchSeq.current
    if (!typed) { setResults(null); return }
    read<BrainPageSearch>({ command: 'search', query: typed, archived }).then((found) => {
      if (seq === searchSeq.current) { setResults({ query: typed, archived, found }); setCursor(0) }
    }).catch((error: unknown) => {
      if (seq !== searchSeq.current) return
      setResults({ query: typed, archived, found: { notes: [], limited: false } })
      setListError(errorText(error))
    })
  }, [query, archived, status.kind, read])

  // Only a visible note has a graph (D7): never a withdrawn one, an archived one only with Archived on.
  const graphable = note !== null && (note.status === 'active' || (note.status === 'archived' && archived))
  useEffect(() => { if (!graphable) { setView('note'); setPane((current) => (current === 'graph' ? 'text' : current)) } }, [graphable])
  const showGraph = graphable && !mapOpen && !query.trim() && (narrow ? pane === 'graph' : view === 'graph')
  useEffect(() => {
    if (!showGraph || !note) return
    const seq = ++graphSeq.current
    setGraphError(null)
    read<BrainGraph>({ command: 'graph', id: note.id, archived, ...(depth === null ? {} : { depth }) }).then((next) => {
      // Only the graph of the note now shown counts: an answer for the centre he just left is dropped.
      if (seq !== graphSeq.current || next.focus !== shownNote.current?.id) return
      setGraph(next)
      setSelected((current) => (current && next.nodes.some((node) => node.id === current) ? current : next.focus))
    }).catch((error: unknown) => {
      // A graph that can no longer be shown as asked (a note withdrawn, Archived turned off) is not left on screen.
      if (seq === graphSeq.current) { setGraph(null); setGraphError(errorText(error)) }
    })
  }, [showGraph, note, archived, depth, read])

  // G (or the Graph choice) gives the keys to the graph once it is drawn, so arrows and Enter act on it.
  useEffect(() => {
    if (!showGraph || !graph || !focusGraph.current) return
    focusGraph.current = false
    box.current?.querySelector<SVGElement>('svg.b-graph')?.focus()
  }, [showGraph, graph])

  // The note shown beside the graph.
  useEffect(() => {
    if (!showGraph || !selected) return
    if (note && selected === note.id) { setBeside(note); return }
    let live = true
    read<BrainPageNote>({ command: 'read', id: selected }).then((next) => { if (live) setBeside(next) }).catch(() => { if (live) setBeside(null) })
    return () => { live = false }
  }, [showGraph, selected, note, read])

  // The map is read when shown and again when Archived changes; an older answer never replaces a newer one.
  const showMap = status.kind === 'ready' && mapOpen && !query.trim()
  useEffect(() => {
    if (!showMap) return
    const seq = ++mapSeq.current
    setMapError(null)
    read<BrainMap>({ command: 'map', archived }).then((next) => {
      if (seq !== mapSeq.current) return
      setBrainMap(next)
      setMapSelected((current) => (current && next.nodes.some((node) => node.id === current) ? current : null))
    }).catch((error: unknown) => { if (seq === mapSeq.current) { setBrainMap(null); setMapError(errorText(error)) } })
  }, [showMap, archived, read])
  // M (or the Map button) gives the keys to the map once it is drawn.
  useEffect(() => {
    if (!showMap || !brainMap || !focusMap.current) return
    focusMap.current = false
    box.current?.querySelector<SVGElement>('svg.b-map')?.focus()
  }, [showMap, brainMap])
  // The note shown beside the map.
  useEffect(() => {
    if (!showMap || !mapSelected) { setMapBeside(null); return }
    if (note && mapSelected === note.id) { setMapBeside(note); return }
    let live = true
    read<BrainPageNote>({ command: 'read', id: mapSelected }).then((next) => { if (live) setMapBeside(next) }).catch(() => { if (live) setMapBeside(null) })
    return () => { live = false }
  }, [showMap, mapSelected, note, read])
  const openMap = (): void => {
    historySeq.current += 1
    setHistory(null)
    setQuery('')
    setMapSelected(note?.id ?? mapSelected)
    focusMap.current = true
    setMapOpen(true)
  }
  const closeMap = (): void => { mapSeq.current += 1; setMapOpen(false) }
  /** Double-click or Shift Enter on the map: that note's neighbourhood graph; M comes back with it selected. */
  const graphFromMap = (id: string): void => {
    closeMap()
    setMapSelected(id)
    focusGraph.current = true
    setView('graph')
    setPane('graph')
    openNote(id, 'push', true)
  }

  // A History answer counts only for the note and the opening it was asked for; closing it first drops the answer.
  const openHistory = (): void => {
    if (!note) return
    const seq = ++historySeq.current
    setHistory({ versions: null, error: null })
    read<BrainPageVersion[]>({ command: 'history', id: note.id }).then((versions) => { if (seq === historySeq.current) setHistory({ versions, error: null }) })
      .catch((error: unknown) => { if (seq === historySeq.current) setHistory({ versions: [], error: errorText(error) }) })
  }
  const closeHistory = (): void => { historySeq.current += 1; setHistory(null) }
  const goBack = (): void => { const id = back.at(-1); if (id) { setBack(back.slice(0, -1)); openNote(id, 'back') } }
  const goForward = (): void => { const id = forward[0]; if (id) { setForward(forward.slice(1)); openNote(id, 'forward') } }
  // The new centre opens at its own depth (openNote resets it with the note), never by asking again for the old centre.
  const refocus = (id: string): void => { openNote(id, 'push', true) }
  const toList = (): void => { closeMap(); noteSeq.current += 1; shownNote.current = null; setNote(null); memory.noteId = null; setView('note'); setGraph(null) }

  const typed = query.trim()
  // Only results for the words now typed, under the Archived setting now on, can be moved through or opened.
  const searched = results && results.query === typed && results.archived === archived ? results : null
  const rows = typed ? searched?.found.notes ?? [] : list?.notes ?? []

  /** Esc steps back (history, graph, search text, the open note), then closes. */
  const stepBack = (): boolean => {
    if (history) { closeHistory(); return true }
    if (typed) { setQuery(''); return true }
    if (mapOpen) { closeMap(); return true }
    if (note && (narrow ? pane !== 'text' : view === 'graph')) { setView('note'); setPane('text'); return true }
    return false
  }

  type Keyed = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target' | 'preventDefault' | 'stopPropagation'>
  const onKeyDown = (event: Keyed | ReactKeyboardEvent<HTMLDivElement>): void => {
    const field = event.target instanceof HTMLElement && event.target.matches('input, textarea')
    if (event.key === 'Escape') {
      if (stepBack()) { event.preventDefault(); event.stopPropagation(); if (field) search.current?.blur() }
      return
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      if (event.key === 'ArrowLeft') goBack(); else goForward()
      return
    }
    if (field) {
      if (event.target !== search.current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (rows.length) setCursor((at) => (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
      } else if (event.key === 'Enter' && rows[cursor]) {
        event.preventDefault()
        openNote(rows[cursor]!.id)
      }
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    // Letters and digits act only outside a field (design.md Keys).
    if (event.key === '/') { event.preventDefault(); search.current?.focus(); return }
    if (event.key.toLowerCase() === 'm' && !event.shiftKey && status.kind === 'ready') { event.preventDefault(); if (mapOpen) closeMap(); else openMap(); return }
    if (mapOpen && !typed) {
      if (event.key.toLowerCase() === 'h' && note) { event.preventDefault(); closeMap(); openHistory() }
      return
    }
    if (!note && !typed && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
      event.preventDefault(); setCursor((at) => (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length); return
    }
    if (!note && !typed && event.key === 'Enter' && rows[cursor] && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); openNote(rows[cursor]!.id); return }
    if (!note) return
    const key = event.key.toLowerCase()
    if (key === 'g') {
      event.preventDefault()
      if (!graphable) return
      const opening = narrow ? pane !== 'graph' : view !== 'graph'
      focusGraph.current = opening
      if (narrow) setPane(opening ? 'graph' : 'text'); else setView(opening ? 'graph' : 'note')
      return
    }
    if (key === 'h') { event.preventDefault(); if (history) closeHistory(); else openHistory(); return }
    if (showGraph && (event.key === '1' || event.key === '2' || event.key === '3')) { event.preventDefault(); setDepth(Number(event.key) as Depth); return }
  }

  // A key that reaches the window's body while the sheet is open (the link that opened a note is gone) is the page's.
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const stray = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.target !== document.body && event.target !== document.documentElement) return
      keys.current(event)
    }
    window.addEventListener('keydown', stray)
    return () => window.removeEventListener('keydown', stray)
  }, [])

  // The current row stays in view as the arrows move it.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('.b-row.current[data-note]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, results])

  const body = (): ReactNode => {
    if (status.kind === 'loading') return <div className="b-empty" aria-busy="true"><p className="b-muted">Opening the brain…</p><div className="b-skeleton" /><div className="b-skeleton" /><div className="b-skeleton short" /></div>
    if (status.kind === 'not-switched') return <div className="b-empty"><p>The Brain page opens after the switch to the BMN brain. Choose Switch to the BMN brain… in the palette.</p></div>
    if (status.kind === 'unavailable') return <div className="b-empty"><p role="alert" className="b-alert">The brain could not be read: {status.reason}</p></div>
    if (typed) return listBody()
    if (mapOpen) return mapBody()
    if (!note) return listBody()
    return noteBody(note)
  }

  const listBody = (): ReactNode => {
    if (listError && !rows.length) return <div className="b-empty"><p role="alert" className="b-alert">{listError}</p></div>
    if (typed && searched && !rows.length) return <div className="b-empty"><p className="b-strong">{noResultWords(typed)}</p></div>
    if (!typed && list && list.total === 0 && list.withdrawn === 0) return <div className="b-empty"><p className="b-strong">The brain is empty.</p></div>
    const words = typed ? typed.split(/\s+/u) : []
    return (
      <div className="b-list-wrap">
        <div className="b-list-head">
          <span>{typed ? (rows.length >= BRAIN_PAGE_SEARCH_SHOWN ? 'First 10' : `${rows.length} ${rows.length === 1 ? 'note' : 'notes'}`) : `${list?.total ?? 0} ${list?.total === 1 ? 'note' : 'notes'}`}</span>
          <span className="b-keys"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open</span>
        </div>
        <ul className="b-list" aria-label={typed ? 'Search results' : 'Notes, newest change first'}>
          {rows.map((row, index) => <NoteRow key={row.id} note={row} current={index === cursor} words={words} onOpen={() => openNote(row.id)} onPoint={() => setCursor(index)} />)}
        </ul>
        {!typed && list && list.notes.length < list.total ? <button type="button" className="b-plate b-more" onClick={() => loadList(list.notes.length)}>Show more</button> : null}
        {!typed && list && list.withdrawn > 0 ? (
          <div className="b-withdrawn">
            <button type="button" className="b-fold" aria-expanded={withdrawn !== null} onClick={() => {
              if (withdrawn) { setWithdrawn(null); return }
              loadWithdrawn(0)
            }}>Withdrawn <span className="b-count">{list.withdrawn}</span></button>
            {withdrawn ? <ul className="b-list">{withdrawn.notes.map((row) => <NoteRow key={row.id} note={row} current={false} onOpen={() => openNote(row.id)} onPoint={() => undefined} />)}</ul> : null}
            {withdrawn && withdrawn.notes.length < withdrawn.total ? <button type="button" className="b-plate b-more" onClick={() => loadWithdrawn(withdrawn.notes.length)}>Show more</button> : null}
          </div>
        ) : null}
      </div>
    )
  }

  const noteHead = (current: BrainPageNote): ReactNode => (
    <header className="b-note-head">
      <span className="b-eyebrow"><KindMark kind={current.kind} status={current.status} />{current.kind}{current.status !== 'active' ? <Chip>{current.status}</Chip> : null}</span>
      {/* A note that opens with its own title as a heading shows it once, in its text. */}
      <h1 className={`b-title${startsWithTitle(current) ? ' b-visually-hidden' : ''}`}>{current.title}</h1>
      {current.status === 'withdrawn' ? <p className="b-muted">Withdrawn: out of search and out of agents’ reach. History is kept.</p> : null}
    </header>
  )

  const graphPane = (): ReactNode => (
    <div className="b-graph-pane">
      <div className="b-graph-bar">
        <span className="b-label" id="b-depth">Depth</span>
        <Segmented labelledBy="b-depth" fit options={[1, 2, 3] as Depth[]} value={(depth ?? graph?.depth ?? 1) as Depth} optionLabel={(value) => String(value)} onChange={(value) => setDepth(value)} />
        <span className="b-muted b-graph-count">{graph ? `${graph.nodes.length} ${graph.nodes.length === 1 ? 'note' : 'notes'}${graph.more.some(Boolean) ? ` · ${graph.more.reduce((a, b) => a + b, 0)} more not drawn` : ''}` : ''}</span>
      </div>
      {graphError ? <p className="b-alert" role="alert">{graphError}</p> : null}
      {/* While a new focus loads, the last graph stays and then moves to the new one (G4). */}
      {graph ? (
        <BrainGraphView graph={graph} selected={selected} reducedMotion={props.reducedMotion}
          onSelect={setSelected} onRefocus={refocus} onMore={() => { setView('note'); setPane('links') }} />
      ) : <div className="b-graph-well" aria-busy="true" />}
    </div>
  )

  const besidePanel = (): ReactNode => {
    const shown = beside ?? note
    if (!shown) return null
    return (
      <aside className="b-side" aria-label="Selected note">
        <span className="b-eyebrow"><KindMark kind={shown.kind} status={shown.status} />{shown.kind}</span>
        <h2 className="b-side-title">{shown.title}</h2>
        <dl className="kv b-kv"><dt>Last change</dt><dd>{brainTime(shown.changed)}</dd><dt>Version</dt><dd>{shown.revision}</dd></dl>
        <div className="b-actions">
          <button type="button" className="b-plate" onClick={() => { if (shown.id === note?.id) { setView('note'); setPane('text') } else { setView('note'); openNote(shown.id) } }}>Open note</button>
          {shown.id !== note?.id ? <button type="button" className="b-plate" onClick={() => refocus(shown.id)} title="Shift Enter">Refocus</button> : null}
        </div>
        {graph && graph.nodes.length === 1 ? <p className="b-muted">No linked notes yet</p> : null}
        <div className="b-side-text"><NoteText key={shown.id} note={shown} onOpen={(id) => setSelected(id)} /></div>
      </aside>
    )
  }

  const mapBody = (): ReactNode => {
    // Only the note now selected is shown beside, so its buttons never act on the one before (pre-review).
    const shown = mapBeside && mapBeside.id === mapSelected ? mapBeside : null
    const side = (
      <aside className="b-side" aria-label="Selected note">
        {shown ? <>
          <span className="b-eyebrow"><KindMark kind={shown.kind} status={shown.status} />{shown.kind}</span>
          <h2 className="b-side-title">{shown.title}</h2>
          <dl className="kv b-kv"><dt>Last change</dt><dd>{brainTime(shown.changed)}</dd><dt>Version</dt><dd>{shown.revision}</dd></dl>
          <div className="b-actions">
            <button type="button" className="b-plate" onClick={() => { closeMap(); setView('note'); setPane('text'); if (shown.id !== note?.id) openNote(shown.id) }}>Open note</button>
            <button type="button" className="b-plate" onClick={() => graphFromMap(shown.id)} title="Shift Enter">Graph</button>
          </div>
          <div className="b-side-text"><NoteText key={shown.id} note={shown} onOpen={(id) => setMapSelected(id)} /></div>
        </> : <p className="b-side-empty" aria-busy={mapSelected ? 'true' : undefined}>{mapSelected ? 'Opening the note…' : 'Pick a note to read it here.'}</p>}
      </aside>
    )
    return (
      <div className={`b-note map${narrow ? ' narrow' : ''}`}>
        {mapError ? <p className="b-alert" role="alert">{mapError}</p> : null}
        {brainMap ? <BrainMapView map={brainMap} open={note?.id ?? null} selected={mapSelected} narrow={narrow} reducedMotion={props.reducedMotion}
          onSelect={setMapSelected} onOpenGraph={graphFromMap} /> : <div className="b-graph-pane"><div className="b-graph-well" aria-busy="true" /></div>}
        {side}
      </div>
    )
  }

  const noteBody = (current: BrainPageNote): ReactNode => {
    if (history) return <HistorySheet note={current} versions={history.versions} error={history.error} onClose={closeHistory} />
    const panel = (
      <aside className="b-side" aria-label="About this note">
        <h3 className="b-side-head">Note</h3>
        <NoteFacts note={current} onHistory={openHistory} />
        <NoteLinks note={current} archived={archived} onOpen={(id) => openNote(id)} />
      </aside>
    )
    if (narrow) {
      const links = [...current.linksTo, ...current.linkedFrom].filter((each) => each.status === 'active' || archived).length
      return (
        <div className="b-note narrow">
          {noteHead(current)}
          <div className="b-panes"><span id="b-pane" hidden>Show</span>
            <Segmented labelledBy="b-pane" fit options={graphable ? ['text', 'links', 'graph'] as const : ['text', 'links'] as const} value={pane}
              optionLabel={(value) => (value === 'text' ? 'Text' : value === 'links' ? `Links ${links}` : 'Graph')} onChange={(value) => { focusGraph.current = value === 'graph'; setPane(value) }} />
          </div>
          {pane === 'text' ? <div className="b-text"><NoteText key={`${current.id}:${current.revision}`} note={current} onOpen={(id) => openNote(id)} /></div> : null}
          {pane === 'links' ? panel : null}
          {pane === 'graph' && graphable ? <>{graphPane()}{besidePanel()}</> : null}
        </div>
      )
    }
    if (view === 'graph' && graphable) return <div className="b-note graph">{graphPane()}{besidePanel()}</div>
    return (
      <div className="b-note">
        <div className="b-text">
          {noteHead(current)}
          <NoteText key={`${current.id}:${current.revision}`} note={current} onOpen={(id) => openNote(id)} />
        </div>
        {panel}
      </div>
    )
  }

  return (
    <Dialog label="Brain" onClose={props.onClose} className="brain-dialog" initialFocus=".brain-dialog .b-search input">
      <div className="b-box" ref={box} onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="b-bar">
          <button type="button" className="icon-button" aria-label="Back" title="Back (Alt ←)" disabled={!back.length} onClick={goBack}>‹</button>
          <button type="button" className="icon-button" aria-label="Forward" title="Forward (Alt →)" disabled={!forward.length} onClick={goForward}>›</button>
          <label className="b-search">
            <span className="b-visually-hidden">Search the brain</span>
            <input ref={search} type="search" placeholder="Search the brain" value={query} disabled={status.kind !== 'ready'}
              onChange={(event) => setQuery(event.target.value)} aria-describedby="b-search-key" />
            <kbd id="b-search-key" aria-label="Press slash to search">/</kbd>
          </label>
          <div className="b-bar-end">
            {note && graphable && !typed && !narrow ? (
              <><span id="b-view" hidden>View</span>
                {/* While the map is open neither is chosen: one gold bar, on Map (visual review). */}
                <Segmented<'note' | 'graph' | null> labelledBy="b-view" fit options={['note', 'graph']} value={mapOpen ? null : view}
                  optionLabel={(value) => (value === 'note' ? 'Note' : 'Graph')} onChange={(value) => { if (!value) return; closeMap(); focusGraph.current = value === 'graph'; setView(value) }} /></>
            ) : null}
            {status.kind === 'ready' && !typed ? <button type="button" className="b-quiet b-map-toggle" aria-pressed={mapOpen} title="Whole-brain map (M)" onClick={() => (mapOpen ? closeMap() : openMap())}>Map</button> : null}
            {(note || mapOpen) && !typed ? <button type="button" className="b-quiet" onClick={toList}>All notes</button> : null}
            <button type="button" className="b-toggle" aria-pressed={archived} onClick={() => setArchived(!archived)}>Archived</button>
          </div>
        </div>
        {noteError ? <p className="b-alert" role="alert">{noteError}</p> : null}
        <div className="b-body">{body()}</div>
      </div>
    </Dialog>
  )
}
