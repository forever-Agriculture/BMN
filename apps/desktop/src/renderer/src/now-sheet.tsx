// MODULE: now-sheet.tsx - Story 110.9: the Now sheet, one row per session with what it does, who it waits on and the time left
//
// It replaces the dev-auto runs dialog and keeps its bounded read, its 30 s self-refresh and its generation guard. The rows,
// words and the standup text come from @bmn/protocol's `buildNow`, the one builder `bmn now` uses too. Design: the approved
// `.dev-auto/evidence/110/now-design/index.html` (docs/design.md, "Now sheet").
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildNow,
  nowClock,
  standupText,
  type DevAutoRunsResult,
  type DevAutoRun,
  type NowRow,
  type NowSection,
  type NowSessionInput,
  type NowView
} from '@bmn/protocol'
import { Dialog } from './dialog'
import { boundedRead } from './bounded-read'
import { Icon } from './icons'
import { SELF_REFRESH_MS, useSelfRefresh } from './self-refresh'
import './now-sheet.css'

/** What the sheet keeps between openings, so the same key brings it back on the row he left, same scroll, same rows open. */
export interface NowMemory {
  key: string | null
  scrollTop: number
  open: string[]
  notRunningOpen: boolean
  result: DevAutoRunsResult | null
}

export function createNowMemory(): NowMemory {
  return { key: null, scrollTop: 0, open: [], notRunningOpen: false, result: null }
}

/** Fixed presentation fixtures, available only through the isolated test-mode shell. */
export const NOW_TEST_PRESETS = ['success', 'pending', 'reject', 'partial', 'many', 'empty'] as const
export type NowTestPreset = (typeof NOW_TEST_PRESETS)[number]
export function createNowTestControl(enabled: boolean, select: (preset: NowTestPreset | undefined) => void): {
  select(preset: unknown): void
} | null {
  if (!enabled) return null
  return Object.freeze({ select(value: unknown): void {
    if (value === 'reset') { select(undefined); return }
    if (typeof value !== 'string' || !(NOW_TEST_PRESETS as readonly string[]).includes(value)) throw new Error('Unknown Now QA preset')
    select(value as NowTestPreset)
  } })
}

function nowTestInputs(preset: NowTestPreset): { workspaces: Workspaces; sessions: NowSessionInput[] } {
  const count = preset === 'empty' ? 0 : preset === 'many' ? 100 : 3
  return { workspaces: [{ workspaceId: 'qa-fixture', name: 'Synthetic QA' }],
    sessions: Array.from({ length: count }, (_, index) => ({ sessionId: `qa-session-${index + 1}`, workspaceId: 'qa-fixture',
      name: preset === 'many' ? `Synthetic session ${index + 1} with a long name whose complete accessible text remains available` : `Synthetic session ${index + 1}`,
      dot: preset === 'many' && index % 10 === 9 ? 'exited' : 'running-idle',
      live: preset !== 'many' || index % 10 !== 9, started: true, agent: true, working: false, progressLabel: null, title: null, card: null })) }
}
function readNowTestPreset(preset: NowTestPreset): Promise<DevAutoRunsResult> {
  if (preset === 'pending') return new Promise(() => {}) // boundedRead retains its ordinary five-second deadline.
  if (preset === 'reject') return Promise.reject(new Error('Synthetic Now read failure'))
  const runs: DevAutoRun[] = preset !== 'partial' ? [] : [{ workspaceIds: ['qa-fixture'], checkout: '/synthetic/qa',
    branch: 'qa-fixture', project: null, status: null, nextAction: null, decisions: [], runId: null,
    decisionEntries: [], omittedDecisions: 0, finished: false, updatedAt: null, ownership: 'own', ownerCheckout: null,
    ownerBranch: null, unavailable: 'Synthetic unreadable handoff', board: { checkout: null, rows: [], unavailable: null }, ownerItems: [], waitingOn: null,
    finishedStories: [], skippedFinishedStories: 0, leadConversations: [], sessionId: 'qa-session-1', sessionLink: null }]
  return Promise.resolve({ runs, skipped: 0, issues: [], observedAt: new Date().toISOString() })
}

type Workspaces = ReadonlyArray<{ workspaceId: string; name: string }>

/**
 * A refresh never moves a row under him: while the pointer or the focus is in the list, every row keeps the section and
 * the place it is shown in. Words still change in place and a row that went is gone; a new row never lands above or
 * between shown rows: it joins the last section when that is its own, else it comes after everything under its own
 * section's title. Once he leaves the list, every row takes its own place again.
 */
export function heldSections(shown: readonly NowSection[] | null, next: readonly NowSection[], hold: boolean): NowSection[] {
  if (!hold || shown === null) return [...next]
  const nextKeys = new Set(next.flatMap((section) => section.keys))
  const shownKeys = new Set(shown.flatMap((section) => section.keys))
  const kept = shown.map((section) => ({ ...section, keys: section.keys.filter((key) => nextKeys.has(key)) }))
  for (const section of next) {
    const added = section.keys.filter((key) => !shownKeys.has(key))
    if (added.length === 0) continue
    const last = kept.at(-1)
    if (last && (last.id === section.id || last.id.startsWith(`${section.id}:new`))) {
      last.keys.push(...added)
      continue
    }
    let id = section.id
    for (let count = 1; kept.some((item) => item.id === id); count += 1) id = `${section.id}:new${count === 1 ? '' : count}`
    kept.push({ ...section, id, keys: added })
  }
  return kept.filter((section) => section.keys.length > 0)
}

/** Where focus goes when the focused row went: the next row that is still there, else the one before, else the first. */
export function focusAfter(before: readonly string[], after: readonly string[], focused: string | null): string | null {
  if (focused !== null && after.includes(focused)) return focused
  const at = focused === null ? -1 : before.indexOf(focused)
  if (at >= 0) {
    const later = before.slice(at + 1).find((key) => after.includes(key))
    if (later) return later
    const earlier = before.slice(0, at).toReversed().find((key) => after.includes(key))
    if (earlier) return earlier
  }
  return after[0] ?? null
}

/** The rows the keyboard walks: every shown section's, the folded Not running only when it is open. */
export function visibleKeys(sections: readonly NowSection[], notRunningOpen: boolean): string[] {
  return sections.flatMap(section => section.kind === 'not-running' ? [`fold:${section.id}`, ...(notRunningOpen ? section.keys : [])] : section.keys)
}

/** The row's whole sentence, for its label and tooltip. */
export function rowWords(row: NowRow): string {
  const left = row.done ? 'Done' : row.left ? `${row.left}${row.plus ? ' plus the wait' : ''}` : 'No estimate'
  return `${row.name}. ${row.doing}${row.of ? `, ${row.of}` : ''}. Waits on ${row.who || 'nobody'}. ${left}.`
}

export type NowHead =
  | { kind: 'loading' }
  | { kind: 'read'; at: string }
  | { kind: 'stale'; at: string }
  | { kind: 'failed' }

export interface NowSheetViewProps {
  view: NowView
  sections: readonly NowSection[]
  head: NowHead
  copy: 'disabled' | 'ready' | 'copied' | 'failed'
  open: ReadonlySet<string>
  notRunningOpen: boolean
  focusKey: string | null
  currentSessionId: string | null
  onRow?(row: NowRow): void
  onToggle?(key: string): void
  onToggleNotRunning?(): void
  onCopy?(): void
  onFocusRow?(key: string): void
}

function HeadWords({ view, head }: { view: NowView; head: NowHead }): React.JSX.Element {
  if (head.kind === 'loading') return <span className="n-words" role="status"><span>Reading runs…</span></span>
  if (head.kind === 'failed') return <span className="n-words" role="status"><span>Runs unread</span></span>
  const at = <span>Read {nowClock(new Date(head.at))}</span>
  if (head.kind === 'stale') return <span className="n-words" role="status">{at}<span>·</span><span>stale</span></span>
  if (!view.agentRunning) return <span className="n-words" role="status">{at}<span>·</span><span>no agent running</span></span>
  return <span className="n-words" role="status">
    {at}<span>·</span><span>{view.sessions} {view.sessions === 1 ? 'session' : 'sessions'}</span><span>·</span>
    {view.waiting > 0
      ? <><span className="status-dot needs-you" aria-hidden="true" /><span className="now-you">{view.waiting} {view.waiting === 1 ? 'waits' : 'wait'} on you</span></>
      : <span>nothing waits on you</span>}
  </span>
}

function RowItem({ row, props, loading }: { row: NowRow; props: NowSheetViewProps; loading: boolean }): React.JSX.Element {
  const foldId = `now-fold-${row.key.replace(/[^A-Za-z0-9_-]/gu, '_')}`
  const isOpen = props.open.has(row.key)
  const words = rowWords(row)
  const left = loading ? <span className="c-left" />
    : row.done ? <span className="c-left is-faint">done</span>
      : row.left ? <span className="c-left">{row.left}{row.plus ? <span className="plus"> + wait</span> : null}</span>
        : <span className="c-left is-faint">no estimate</span>
  const hasFold = row.fold.length > 0 && !loading
  return <li className={`n-row${props.currentSessionId !== null && row.sessionId === props.currentSessionId ? ' is-current' : ''}${row.stopped ? ' is-stopped' : ''}`} data-key={row.key}>
    <button type="button" className="n-main" data-key={row.key} data-now-key={row.key} tabIndex={props.focusKey === row.key ? 0 : -1} aria-label={words} title={words}
      onClick={() => props.onRow?.(row)} onFocus={() => props.onFocusRow?.(row.key)}>
      <span className={`status-dot ${row.dot}`} aria-hidden="true" />
      <span className="c-name">{row.name}</span>
      <span className="c-doing"><span>{row.doing}</span>
        {row.of && !loading ? <span className="of">{row.of}</span> : null}{row.stale && !loading ? <span className="chip">stale</span> : null}</span>
      <span className={`c-who${row.you ? ' is-you' : ''}${row.unknown ? ' is-faint' : ''}`}>{row.who ? <><span className="lbl">Waits on </span>{row.who}</> : null}</span>
      {left}
    </button>
    {hasFold ? <>
      <button type="button" className="n-chev" tabIndex={-1} aria-expanded={isOpen} aria-controls={foldId} aria-label={`Explain ${row.name}`}
        onClick={() => props.onToggle?.(row.key)}><Icon name="chevron" size={14} /></button>
      <dl className="n-fold" id={foldId} hidden={!isOpen}>{row.fold.map((item) => <div key={item.label} className="n-pair">
        <dt>{item.label}</dt>
        <dd>{item.kind === 'card' ? <button type="button" className="link" tabIndex={-1} onClick={() => props.onRow?.(row)}>{item.value}</button>
          : item.kind === 'path' ? <span className="path" title={item.value}>{item.value}</span> : item.value}</dd>
      </div>)}</dl>
    </> : <span />}
  </li>
}

/** The sheet's body, everything it shows from explicit state; the renderer tests draw each designed state through it. */
export function NowSheetView(props: NowSheetViewProps & { scrollRef?: React.Ref<HTMLDivElement>; listHandlers?: React.HTMLAttributes<HTMLDivElement> }): React.JSX.Element {
  const byKey = new Map(props.view.rows.map((row) => [row.key, row]))
  const loading = props.head.kind === 'loading' || props.head.kind === 'failed' && props.view.loading
  const stale = props.head.kind === 'stale' || props.head.kind === 'failed'
  return <div className="n-box">
    {stale ? <p className="n-alert" role="alert">{props.head.kind === 'stale'
      ? `Could not read the dev-auto runs. Rows show the ${nowClock(new Date(props.head.at))} read.` : 'Could not read the dev-auto runs.'}</p> : null}
    <div className="n-cols" aria-hidden="true"><span /><span>Session</span><span>Doing</span><span>Waits on</span><span>Left</span></div>
    <div className="n-scroll" ref={props.scrollRef} {...props.listHandlers}>
      {props.sections.length === 0 ? <p className="n-note">No sessions yet.</p> : null}
      {props.sections.map((section) => {
        const rows = section.keys.flatMap((key) => byKey.get(key) ?? [])
        const items = rows.map((row) => <RowItem key={row.key} row={row} props={props} loading={loading} />)
        if (section.kind === 'not-running') {
          const id = `now-${section.id.replace(/[^A-Za-z0-9_-]/gu, '_')}`
          return <section key={section.id}>
            <button type="button" className="n-sec" data-key={`fold:${section.id}`} data-now-key={`fold:${section.id}`}
              tabIndex={props.focusKey === `fold:${section.id}` ? 0 : -1} onFocus={() => props.onFocusRow?.(`fold:${section.id}`)}
              aria-expanded={props.notRunningOpen} aria-controls={id} onClick={() => props.onToggleNotRunning?.()}>
              <Icon name="chevron" size={12} /><span>{section.title}</span><b>{rows.length}</b></button>
            <ul className="n-list" id={id} hidden={!props.notRunningOpen}>{items}</ul>
          </section>
        }
        return <section key={section.id}>
          <h3 className="n-sec"><span>{section.title}</span><b>{rows.length}</b></h3>
          <ul className="n-list">{items}</ul>
        </section>
      })}
    </div>
    <div className="n-head">
      <HeadWords view={props.view} head={props.head} />
      <button type="button" className="plate" disabled={props.copy === 'disabled'} aria-live="polite" onClick={() => props.onCopy?.()}>
        {props.copy === 'copied' ? 'Copied' : props.copy === 'failed' ? 'Not copied' : 'Copy standup'}</button>
    </div>
  </div>
}

export function NowSheet(props: {
  workspaces: Workspaces
  sessions: readonly NowSessionInput[]
  home: string | null
  currentSessionId: string | null
  memory: NowMemory
  testRead?: { preset: NowTestPreset; sequence: number } | undefined
  onOpenRow(row: NowRow): void
  onClose(): void
}): React.JSX.Element {
  const { memory } = props
  const fixture = useMemo(() => props.testRead ? nowTestInputs(props.testRead.preset) : null, [props.testRead?.preset])
  const workspaces = fixture?.workspaces ?? props.workspaces
  const sessions = fixture?.sessions ?? props.sessions
  const [result, setResult] = useState<DevAutoRunsResult | null>(memory.result)
  const [fresh, setFresh] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(memory.open))
  const [notRunningOpen, setNotRunningOpen] = useState(memory.notRunningOpen)
  const [focusKey, setFocusKey] = useState<string | null>(memory.key)
  const [pointerInside, setPointerInside] = useState(false)
  const [focusInside, setFocusInside] = useState(false)
  const [copy, setCopy] = useState<'ready' | 'copied' | 'failed'>('ready')
  const generation = useRef(0)
  const mounted = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const load = async (): Promise<void> => {
    const request = ++generation.current
    try {
      const snapshot = await boundedRead(props.testRead ? readNowTestPreset(props.testRead.preset) : window.aiTerminal.readDevAutoRuns())
      if (!mounted.current || generation.current !== request) return
      memory.result = snapshot
      setResult(snapshot)
      setFresh(true)
      setFailed(false)
    } catch {
      if (mounted.current && generation.current === request) setFailed(true)
    }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; generation.current++ }
  }, [props.testRead?.sequence])
  // Story 75.7: dev-auto writes its files outside BMN, so they are read again every 30 s while this is on screen, when the
  // window comes back and when a card changes; the read is bounded and what was shown stays meanwhile.
  useSelfRefresh(load, { topics: ['attention'], everyMs: SELF_REFRESH_MS })

  const view = useMemo(() => buildNow({ now: new Date(), audience: 'owner', workspaces, sessions,
    runs: result?.runs ?? null, home: props.home }), [workspaces, sessions, props.home, result])
  // The first placement shown with a read of the runs in this opening (a remembered one too) holds while he is in the list;
  // the rows shown while nothing was read yet hold nothing.
  const shown = useRef<NowSection[] | null>(null)
  const hold = (pointerInside || focusInside) && shown.current !== null
  const sections = heldSections(shown.current, view.sections, hold)
  const order = visibleKeys(sections, notRunningOpen)
  const lastOrder = useRef<string[]>(order)
  const target = focusAfter(lastOrder.current, order, focusKey)
  // The row button that has the focus, and whether he left the list for something else (then nothing takes it back).
  const focused = useRef<HTMLElement | null>(null)
  const wantFocus = useRef(false)
  useEffect(() => {
    if (result !== null) shown.current = sections
    lastOrder.current = order
  })
  // Focus is never lost to a refresh: a row that moved section is drawn anew and takes the focus back; a row that went, or
  // was folded away, hands it to the next row. Before paint, so the keyboard never lands on the page.
  useLayoutEffect(() => {
    if (target !== focusKey) {
      setFocusKey(target)
      memory.key = target
    }
    const before = focused.current
    if (!wantFocus.current || target === null || before === null) return
    const dialog = scroll.current?.closest('dialog') ?? null
    const active = document.activeElement
    const inside = active instanceof HTMLElement && active !== dialog && dialog?.contains(active) === true
    const removed = !before.isConnected && !inside
    const handedOn = target !== focusKey && active === before
    if (!removed && !handedOn) return
    const button = scroll.current?.querySelector<HTMLElement>(`[data-now-key="${CSS.escape(target)}"]`)
    if (button && button !== active) button.focus({ preventScroll: true })
  })
  // Opens on the row he left, at the same scroll. This runs after the dialog's own effect opened it and focused that row.
  useEffect(() => {
    const list = scroll.current
    if (!list) return
    list.scrollTop = memory.scrollTop
    const key = focusAfter(order, order, memory.key)
    if (key !== null) list.querySelector<HTMLElement>(`[data-now-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (copy === 'ready') return
    const timer = setTimeout(() => setCopy('ready'), 2_000)
    return () => clearTimeout(timer)
  }, [copy])

  const moveTo = (key: string | undefined): void => {
    if (key === undefined) return
    setFocusKey(key)
    memory.key = key
    const button = scroll.current?.querySelector<HTMLElement>(`[data-now-key="${CSS.escape(key)}"]`)
    button?.focus()
    button?.scrollIntoView({ block: 'nearest' })
  }
  const toggle = (key: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      memory.open = [...next]
      return next
    })
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-now-key]') : null
    if (!button) return
    const key = button.dataset.key ?? null
    const at = key === null ? -1 : order.indexOf(key)
    const go = { ArrowDown: order[Math.min(at + 1, order.length - 1)], ArrowUp: order[Math.max(at - 1, 0)], Home: order[0], End: order.at(-1) }[event.key]
    if (go !== undefined) {
      event.preventDefault()
      moveTo(go)
      return
    }
    if (key?.startsWith('fold:')) {
      if ((event.key === 'ArrowRight' && !notRunningOpen) || (event.key === 'ArrowLeft' && notRunningOpen)) {
        event.preventDefault()
        setNotRunningOpen(value => { memory.notRunningOpen = !value; return !value })
      }
      return
    }
    const row = view.rows.find((item) => item.key === key)
    if (!row || row.fold.length === 0 || view.loading) return
    if ((event.key === 'ArrowRight' && !open.has(row.key)) || (event.key === 'ArrowLeft' && open.has(row.key))) {
      event.preventDefault()
      toggle(row.key)
    }
  }
  const onRow = (row: NowRow): void => {
    setFocusKey(row.key)
    memory.key = row.key
    // A run with no session only opens its row; every other row opens its session, with its card in front.
    if (row.sessionId === null || props.testRead) toggle(row.key)
    else props.onOpenRow(row)
  }
  const onCopy = (): void => {
    const text = standupText(buildNow({ now: new Date(), audience: 'owner', workspaces, sessions,
      runs: result?.runs ?? null, home: props.home }), workspaces)
    window.aiTerminal.writeClipboardText(text).then(() => setCopy('copied'), () => setCopy('failed'))
  }
  const head: NowHead = result === null ? failed ? { kind: 'failed' } : { kind: 'loading' }
    : failed ? { kind: 'stale', at: result.observedAt } : { kind: 'read', at: result.observedAt }
  return <Dialog label="Now" onClose={props.onClose} className="now-dialog">
    <NowSheetView view={view} sections={sections} head={head} copy={!fresh ? 'disabled' : copy} open={open}
      notRunningOpen={notRunningOpen} focusKey={order.includes(focusKey ?? '') ? focusKey : order[0] ?? null}
      currentSessionId={props.currentSessionId} onRow={onRow} onToggle={toggle} onCopy={onCopy}
      onFocusRow={(key) => { setFocusKey(key); memory.key = key }}
      onToggleNotRunning={() => setNotRunningOpen((value) => { memory.notRunningOpen = !value; return !value })}
      scrollRef={scroll}
      listHandlers={{
        onKeyDown,
        onScroll: (event) => { memory.scrollTop = event.currentTarget.scrollTop },
        onPointerEnter: () => setPointerInside(true),
        onPointerLeave: () => setPointerInside(false),
        onFocus: (event) => {
          setFocusInside(true)
          wantFocus.current = true
          if (event.target instanceof HTMLElement && event.target.hasAttribute('data-now-key')) focused.current = event.target
        },
        onBlur: (event) => {
          const list = event.currentTarget
          const next = event.relatedTarget as Node | null
          if (list.contains(next)) return
          if (next !== null) {
            wantFocus.current = false
            setFocusInside(false)
            return
          }
          // No new focus: he clicked outside any control or the window went away, or a refresh drew the row anew.
          const from = event.target
          // A real departure (the row still there and focus not back in the list) also drops the wish to restore focus,
          // so a later refresh never pulls focus back after he left on purpose.
          queueMicrotask(() => {
            if (!from.isConnected || list.contains(document.activeElement)) return
            wantFocus.current = false
            setFocusInside(false)
          })
        }
      }} />
  </Dialog>
}
