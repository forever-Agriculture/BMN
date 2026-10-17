// MODULE: quick-look.tsx - Quick look: one sheet over the window to walk the project and read a file (Epic 67)
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  quickLookCount,
  quickLookFileType,
  quickLookHomePath,
  quickLookName,
  quickLookPathParts,
  quickLookSize,
  sameQuickLookIdentity,
  type QuickLookReadResult,
  type QuickLookRootResult,
  type QuickLookSource
} from '@bmn/protocol'
import { createCodeView, goToPosition, showFindMatches, showSecrets, topVisibleLine, type SecretView } from './quick-look-code'
import { findCountLabel, findMatches, matchAt, stepMatch, type FindMatch } from './quick-look-find'
import { MARKDOWN_PAGE_MAX_BYTES, markdownPage, matchesOnPage, pageRuns } from './quick-look-markdown'
import { MarkdownPageView, type MarkdownPageHandle } from './quick-look-page'
import {
  EMPTY_TRAIL,
  canGoBack,
  canGoForward,
  escapeStep,
  parseGoToLine,
  recalledPlace,
  rememberPlace,
  trailStep,
  trailVisit,
  type Trail
} from './quick-look-place'
import {
  maskedSlice,
  outsideSecrets,
  quickLookSecretRanges,
  reveal,
  revealSecondsLeft,
  secretOnLine,
  viewText,
  type Reveal
} from './quick-look-secrets'
import { treeKey, treeRows, type TreeListing, type TreeRow } from './quick-look-tree'
import { quickLookFooter, type QuickLookFocus } from './quick-look-keys'
import './quick-look.css'

/** Below this sheet width the tree starts folded, so that the file keeps 80 columns. */
export const QUICK_LOOK_TREE_FOLD_WIDTH = 940
/** How often a shown file's identity is asked for while the window has focus (Story 67.2 AC2). */
export const QUICK_LOOK_IDENTITY_MS = 2000

/** Rendered or source, per Markdown file, kept in this window's memory until BMN quits (Story 67.4 AC1). */
const markdownModes = new Map<string, 'rendered' | 'source'>()

export interface QuickLookRequest {
  source: QuickLookSource
  /** A file to show at once, at its place. */
  open?: { path: string; line: number | null; column: number | null } | null
}

interface OpenFile {
  path: string
  line: number | null
  column: number | null
  /** The line kept at the top after a reload or from the remembered place. */
  topLine: number | null
  /** A heading a Markdown link named, shown at the top. */
  heading: string | null
  result: QuickLookReadResult | null
}

interface FindState {
  open: boolean
  query: string
  matchCase: boolean
  current: number
  /** The matches `current` counts in; for newer matches the current one is worked out again, so a count never mixes two queries. */
  of: readonly FindMatch[] | null
}

/** How a file comes to be opened: a new visit adds to the trail, a step along it or a recalled place does not. */
type OpenWay = 'visit' | 'trail' | 'recall'

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const modifiedWords = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  return `${day}, ${time}`
}

function Chevron(props: { open: boolean }): React.JSX.Element {
  return (
    <svg className="ql-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d={props.open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** The path row: folders cut first, the name and the line he came for always shown, then the file's facts. */
function PathRow(props: { path: string; root: string | null; line: number | null; facts: string | null; eyebrow?: string | undefined; actions?: ReactNode }): React.JSX.Element {
  const parts = quickLookPathParts(props.path, props.root)
  return (
    <div className="ql-path">
      {props.eyebrow ? <span className="ql-eyebrow">{props.eyebrow}</span> : null}
      <span className="ql-pth" title={props.path}>
        <bdi>
          <span className="ql-pd">{parts.directory}</span><span className="ql-pn">{parts.name}</span>
          {props.line !== null ? <span className="ql-pp">:{props.line}</span> : null}
        </bdi>
      </span>
      {parts.outside && props.root ? <span className="ql-facts">Outside {props.root}</span> : null}
      {props.facts ? <span className="ql-facts">{props.facts}</span> : null}
      {props.actions ? <span className="ql-path-actions">{props.actions}</span> : null}
    </div>
  )
}

/** A file that is not shown as text says what it is: its type, size, time and path, and where it lives. */
function FileFacts(props: { result: Extract<QuickLookReadResult, { status: 'unavailable' }>; onFeedback(text: string): void }): React.JSX.Element {
  const path = props.result.canonicalPath ?? props.result.path
  const facts = props.result.facts
  return (
    <div className="ql-facts-block">
      {facts ? (
        <dl className="ql-dl">
          <dt>Type</dt><dd>{quickLookFileType(path).label}</dd>
          <dt>Size</dt><dd>{quickLookCount(facts.byteLength)} bytes</dd>
          <dt>Modified</dt><dd>{modifiedWords(facts.modifiedAt)}</dd>
          <dt>Path</dt><dd className="ql-mono">{path}</dd>
          {props.result.canonicalPath && props.result.canonicalPath !== props.result.path ? <><dt>Through symlink</dt><dd className="ql-mono">{props.result.path}</dd></> : null}
        </dl>
      ) : <p className="ql-message">{props.result.message}</p>}
      {facts ? (
        <div className="ql-actions">
          <button type="button" className="ql-button" onClick={() => {
            void window.aiTerminal.showFileReference(path)
              .then(() => props.onFeedback('Shown in the file manager.'))
              .catch((error: unknown) => props.onFeedback(failureText(error, 'Show in Folder failed.')))
          }}>Show in Folder</button>
          <button type="button" className="ql-button" onClick={() => {
            void window.aiTerminal.writeClipboardText(path)
              .then(() => props.onFeedback('Path copied.'))
              .catch((error: unknown) => props.onFeedback(failureText(error, 'Copy failed.')))
          }}>Copy path</button>
        </div>
      ) : null}
    </div>
  )
}

/** The file read-only in CodeMirror; recreated for each read so a reload starts from the bytes on disk. */
function CodeView(props: {
  result: Extract<QuickLookReadResult, { status: 'ready' }>
  /** The file's text with one `\n` per line ending, as the view, find and the masks count it. */
  text: string
  secrets: SecretView
  onRevealSecret(index: number): void
  line: number | null
  column: number | null
  topLine: number | null
  focus: boolean
  onView(view: EditorView | null): void
  /** The line at the top, reported as the file scrolls, so a place is kept without measuring a closing sheet. */
  onTop(path: string, line: number): void
  onFocus(): void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const onView = useRef(props.onView)
  onView.current = props.onView
  const onTop = useRef(props.onTop)
  onTop.current = props.onTop
  const onReveal = useRef(props.onRevealSecret)
  onReveal.current = props.onRevealSecret
  const secrets = useRef(props.secrets)
  secrets.current = props.secrets
  const shown = useRef<EditorView | null>(null)
  const focus = useRef(props.focus)
  focus.current = props.focus
  useEffect(() => {
    if (!host.current) return
    const type = quickLookFileType(props.result.path)
    const view = createCodeView(host.current, {
      content: props.text, language: type.language, line: props.line, column: props.column, topLine: props.topLine,
      label: `${quickLookName(props.result.path)}, read only`, secrets: secrets.current, onRevealSecret: (index) => onReveal.current(index)
    })
    shown.current = view
    onView.current(view)
    if (focus.current) view.focus()
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (view.dom.isConnected) onTop.current(props.result.path, topVisibleLine(view)) })
    }
    view.scrollDOM.addEventListener('scroll', report, { passive: true })
    report()
    return () => {
      cancelAnimationFrame(frame)
      view.scrollDOM.removeEventListener('scroll', report)
      shown.current = null
      onView.current(null)
      view.destroy()
    }
  }, [props.result, props.text, props.line, props.column, props.topLine])
  useEffect(() => {
    if (shown.current && shown.current.state.doc.length === props.text.length) showSecrets(shown.current, props.secrets)
  }, [props.secrets, props.text])
  return <div className="ql-code" ref={host} onFocus={props.onFocus} />
}

export function QuickLook(props: {
  request: QuickLookRequest
  /** In test mode the sheet offers `window.__aitermQuickLook`, which returns only masked text. */
  testMode?: boolean
  onClose(): void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const findField = useRef<HTMLInputElement>(null)
  const goToField = useRef<HTMLInputElement>(null)
  const codeView = useRef<EditorView | null>(null)
  const [rootInfo, setRootInfo] = useState<QuickLookRootResult | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [atGitRoot, setAtGitRoot] = useState(false)
  const [listings, setListings] = useState<ReadonlyMap<string, TreeListing>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [folded, setFolded] = useState(() => Math.min(1160, window.innerWidth - 32) < QUICK_LOOK_TREE_FOLD_WIDTH)
  // The open file has focus, or the tree when none is open; with the tree folded, the top field.
  const [focusArea, setFocusArea] = useState<QuickLookFocus>(() => props.request.open ? 'file' : folded ? 'field' : 'tree')
  const [file, setFile] = useState<OpenFile | null>(null)
  const [feedback, setFeedback] = useState('')
  const [find, setFind] = useState<FindState>({ open: false, query: '', matchCase: false, current: -1, of: null })
  const [goTo, setGoTo] = useState<{ open: boolean; text: string; invalid: boolean }>({ open: false, text: '', invalid: false })
  const [trail, setTrail] = useState<Trail>(EMPTY_TRAIL)
  const [changed, setChanged] = useState(false)
  const [peeking, setPeeking] = useState(false)
  const [goneNote, setGoneNote] = useState<string | null>(null)
  const [shownSecret, setShownSecret] = useState<Reveal | null>(null)
  const [, setModeTick] = useState(0)
  const [pageStatus, setPageStatus] = useState('')
  const pageView = useRef<MarkdownPageHandle | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const source = props.request.source
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  const peekingRef = useRef(false)
  /** The line at the top of the shown file, as its view last reported it. */
  const shownTop = useRef<{ path: string; line: number } | null>(null)
  /** Where find starts looking: the caret when the row opened. */
  const findAnchor = useRef(0)
  /** Set by a reload, so the next marking of find's matches does not scroll. */
  const keepTop = useRef(false)

  const root = rootInfo?.status === 'ready' ? (atGitRoot && rootInfo.gitRoot ? rootInfo.gitRoot : rootInfo.sessionFolder) : null
  const rows = useMemo(() => (root ? treeRows(root, listings, expanded) : []), [root, listings, expanded])
  const ready = file?.result?.status === 'ready' ? file.result : null
  const text = useMemo(() => (ready ? viewText(ready.content) : ''), [ready])
  // Values that look like secrets are hidden as soon as the file is drawn; masking does not find every secret.
  const secretRanges = useMemo(() => (ready ? quickLookSecretRanges(ready.path, ready.canonicalPath, text) : []), [ready, text])
  const revealed = shownSecret && shownSecret.index < secretRanges.length ? shownSecret.index : null
  const secondsLeft = revealSecondsLeft(shownSecret, now)
  const secrets = useMemo<SecretView>(() => ({ ranges: secretRanges, revealed, secondsLeft }), [secretRanges, revealed, secondsLeft])
  // A Markdown file of at most 512 KiB reads as a page unless he chose source for it (Story 67.4).
  const markdown = !!ready && quickLookFileType(ready.path).language === 'markdown'
  const pageTooLarge = markdown && ready.byteLength > MARKDOWN_PAGE_MAX_BYTES
  const page = useMemo(() => (markdown && !pageTooLarge ? markdownPage(text) : null), [markdown, pageTooLarge, text])
  const rendered = !!page && !!ready && markdownModes.get(ready.path) !== 'source'
  const runs = useMemo(() => (page ? pageRuns(page) : []), [page])
  const matches = useMemo(() => {
    if (!ready || !find.query) return []
    const found = outsideSecrets(findMatches(text, find.query, find.matchCase), secretRanges, revealed)
    return rendered ? matchesOnPage(found, runs) : found
  }, [ready, text, find.query, find.matchCase, secretRanges, revealed, rendered, runs])
  const headingLine = file?.heading && page ? page.headings.find((each) => each.slug === file.heading)?.line ?? null : null
  const currentMatch = find.of === matches ? find.current : matchAt(matches, findAnchor.current)
  const findRef = useRef({ matches, current: currentMatch, open: find.open })
  findRef.current = { matches, current: currentMatch, open: find.open }

  const list = useCallback((folder: string): void => {
    setListings((current) => new Map(current).set(folder, current.get(folder) ?? { entries: null, more: 0, unavailable: null }))
    void window.aiTerminal.listQuickLookFolder({ ...source, folder })
      .then((result) => setListings((current) => new Map(current).set(folder, result.status === 'ready'
        ? { entries: result.entries, more: result.more, unavailable: null }
        : { entries: [], more: 0, unavailable: result.message })))
      .catch((error: unknown) => setListings((current) => new Map(current).set(folder, { entries: [], more: 0, unavailable: failureText(error, 'This folder is unavailable') })))
  }, [source])

  const read = useCallback((path: string): Promise<QuickLookReadResult> => window.aiTerminal.readQuickLookFile({ ...source, path })
    .catch((error: unknown): QuickLookReadResult => ({
      status: 'unavailable', path, canonicalPath: null, reason: 'unreadable', message: failureText(error, 'The file could not be read.'), facts: null
    })), [source])

  const shownPath = useRef<string | null>(null)
  shownPath.current = file?.path ?? null
  /** The shown file's top line, as its view last reported it; read through refs, so a memoised opener sees it too. */
  const currentTop = useCallback((): number | null => (shownTop.current && shownTop.current.path === shownPath.current ? shownTop.current.line : null), [])

  const open = useCallback((path: string, line: number | null = null, column: number | null = null,
    options: { way?: OpenWay; topLine?: number | null; focus?: boolean; heading?: string | null } = {}): void => {
    const way = options.way ?? 'visit'
    if (way !== 'trail') {
      const here = currentTop()
      setTrail((current) => trailVisit(current, { path, line, column }, here))
    }
    setFile({ path, line, column, topLine: options.topLine ?? null, heading: options.heading ?? null, result: null })
    setShownSecret(null)
    setPageStatus('')
    setFeedback('')
    setChanged(false)
    setGoneNote(null)
    setGoTo({ open: false, text: '', invalid: false })
    setFind((current) => ({ ...current, current: -1, of: null }))
    findAnchor.current = 0
    if (options.focus !== false) setFocusArea('file')
    void read(path).then((result) => {
      // A remembered file that is gone leaves the tree open with one line saying so (Story 67.2 AC4).
      if (way === 'recall' && result.status === 'unavailable' && result.reason === 'missing') {
        setFile((current) => (current?.path === path ? null : current))
        setGoneNote(`The last file, ${quickLookName(path)}, is no longer there.`)
        setFocusArea((current) => (current === 'file' ? 'tree' : current))
        return
      }
      setFile((current) => (current?.path === path && current.line === line && current.column === column && !current.result ? { ...current, result } : current))
    })
  }, [read, currentTop])

  /** Reads the shown file again and keeps the line at the top; nothing reloads by itself (Story 67.2 AC2). */
  const reload = (): void => {
    if (!file) return
    const { path } = file
    const topLine = currentTop()
    keepTop.current = true
    setShownSecret(null)
    setChanged(false)
    void read(path).then((result) => setFile((current) => (current?.path === path ? { ...current, topLine, result } : current)))
  }

  const step = (direction: -1 | 1): void => {
    const next = trailStep(trail, direction, currentTop())
    if (!next) return
    setTrail(next.trail)
    open(next.entry.path, next.entry.line, next.entry.column, { way: 'trail', topLine: next.entry.topLine ?? null })
  }

  /** Rendered or source for this Markdown file, kept until BMN quits; the line at the top stays (Story 67.4 AC1). */
  const switchMarkdown = (mode: 'rendered' | 'source'): void => {
    if (!ready) return
    const topLine = currentTop()
    markdownModes.set(ready.path, mode)
    setFile((current) => (current ? { ...current, topLine } : current))
    setModeTick((tick) => tick + 1)
    setFocusArea('file')
  }

  /** An outside address is never opened: it is shown, and Enter copies it. */
  const copyAddress = (address: string): void => {
    setPageStatus(address)
    void window.aiTerminal.writeClipboardText(address)
      .then(() => setFeedback('Address copied'))
      .catch((error: unknown) => setFeedback(failureText(error, 'Copy failed.')))
  }

  /** Shows one hidden value for ten seconds, or hides it again; any other shown value hides first (Story 67.3). */
  const toggleSecret = (index: number): void => setShownSecret((current) => (current?.index === index ? null : reveal(index, Date.now())))

  // The countdown of a shown value, and its end.
  useEffect(() => {
    if (!shownSecret) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= shownSecret.until) setShownSecret(null)
    }, 250)
    return () => window.clearInterval(timer)
  }, [shownSecret])

  // Test mode only: what the sheet shows of the file, with every hidden value masked, never the value itself.
  const hookRef = useRef<() => { path: string | null; text: string | null; hidden: number; revealed: number | null }>(() => ({ path: null, text: null, hidden: 0, revealed: null }))
  hookRef.current = () => ({ path: ready?.path ?? null, text: ready ? maskedSlice(text, secretRanges, 0, text.length, revealed) : null, hidden: secretRanges.length, revealed })
  useEffect(() => {
    if (!props.testMode) return
    const target = window as unknown as { __aitermQuickLook?: { snapshot(): ReturnType<typeof hookRef.current> } }
    const hook = { snapshot: () => hookRef.current() }
    target.__aitermQuickLook = hook
    return () => { if (target.__aitermQuickLook === hook) delete target.__aitermQuickLook }
  }, [props.testMode])

  // The sheet is a native modal: the window dims behind it, focus stays inside, and no layout changes, so no
  // terminal is resized. Esc is taken as a key (see onSheetKey) so the browser raises no close request: Chromium
  // makes a repeated, refused close request final and closes the dialog itself. A cancel event from elsewhere still
  // closes the innermost thing first, and a dialog the browser closed anyway closes the sheet, so the two agree.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    const cancel = (event: Event): void => {
      event.preventDefault()
      cancelRef.current()
    }
    const closed = (): void => onClose.current()
    element.addEventListener('cancel', cancel)
    element.addEventListener('close', closed)
    return () => {
      element.removeEventListener('cancel', cancel)
      element.removeEventListener('close', closed)
      if (element.open) element.close()
    }
  }, [])

  // Holding F8 peeks at the terminals: no key pressed meanwhile reaches the sheet or a terminal, and releasing it
  // or leaving the window brings the sheet back as it was (Story 67.2 AC3).
  useEffect(() => {
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'F8' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        swallow(event)
        if (!peekingRef.current) {
          peekingRef.current = true
          setPeeking(true)
          setShownSecret(null)
        }
        return
      }
      if (peekingRef.current) swallow(event)
    }
    const up = (event: KeyboardEvent): void => {
      if (!peekingRef.current) return
      swallow(event)
      if (event.key === 'F8') {
        peekingRef.current = false
        setPeeking(false)
      }
    }
    const blur = (): void => {
      peekingRef.current = false
      setPeeking(false)
      setShownSecret(null)
    }
    const other = (event: Event): void => { if (peekingRef.current) swallow(event as KeyboardEvent) }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('keypress', other, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('keypress', other, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useEffect(() => {
    let current = true
    void window.aiTerminal.quickLookRoot(source)
      .then((result) => { if (current) setRootInfo(result) })
      .catch((error: unknown) => { if (current) setRootError(failureText(error, 'This folder is unavailable')) })
    return () => { current = false }
  }, [])

  // Each root keeps its place while BMN runs: the last file and its top line, the open folders and the last search.
  // A file asked for by the opening wins over the remembered one (Story 67.2 AC4).
  const placeRef = useRef<(shown: string) => void>(() => undefined)
  placeRef.current = (shown) => {
    const top = currentTop()
    rememberPlace(shown, {
      file: file ? { path: file.path, topLine: top ?? file.topLine ?? file.line ?? 1 } : null,
      expanded: [...expanded],
      find: find.query ? { query: find.query, matchCase: find.matchCase } : null
    })
  }
  const asked = useRef(props.request.open ?? null)
  useEffect(() => {
    if (!root) return
    const place = recalledPlace(root)
    setExpanded(new Set(place?.expanded ?? []))
    setSelected(null)
    setTyped('')
    setTrail(EMPTY_TRAIL)
    setFind((current) => place?.find ? { ...current, query: place.find.query, matchCase: place.find.matchCase, current: -1, of: null } : current)
    list(root)
    for (const folder of place?.expanded ?? []) list(folder)
    const wanted = asked.current
    asked.current = null
    if (wanted) open(wanted.path, wanted.line, wanted.column)
    else if (place?.file) open(place.file.path, null, null, { way: 'recall', topLine: place.file.topLine })
    else {
      setFile(null)
      if (focusArea === 'file') setFocusArea(folded ? 'field' : 'tree')
    }
    return () => placeRef.current(root)
  }, [root])

  // A root that cannot be read still shows the file the opening asked for.
  useEffect(() => {
    if ((rootInfo?.status !== 'unavailable' && !rootError) || !asked.current) return
    const wanted = asked.current
    asked.current = null
    open(wanted.path, wanted.line, wanted.column)
  }, [rootInfo, rootError])

  // While the sheet is open and the window has focus, the shown file's identity is asked for every 2 s and once
  // when focus returns; a difference offers a reload, nothing more (Story 67.2 AC2).
  useEffect(() => {
    if (!ready || changed) return
    let live = true
    const check = (): void => {
      if (!document.hasFocus()) return
      void window.aiTerminal.quickLookIdentity({ ...source, path: ready.path })
        .then((now) => { if (live && !sameQuickLookIdentity(ready.identity, now)) setChanged(true) })
        .catch(() => undefined)
    }
    const timer = window.setInterval(check, QUICK_LOOK_IDENTITY_MS)
    window.addEventListener('focus', check)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [ready, changed, source])

  // Focus follows the area the keys belong to; a peek leaves it where it was.
  useEffect(() => {
    if (peeking) return
    if (focusArea === 'tree' && !folded) tree.current?.focus()
    else if (focusArea === 'file') (codeView.current ?? pageView.current)?.focus()
    else if (focusArea === 'find') {
      findField.current?.focus()
      findField.current?.select()
    }
    else if (focusArea === 'goto') goToField.current?.focus()
    else field.current?.focus()
  }, [focusArea, folded, peeking])

  useEffect(() => {
    if (focusArea === 'tree' && selected === null && rows.length > 0) {
      const first = rows.find((row) => row.kind !== 'note')
      if (first) setSelected(first.path)
    }
  }, [rows, focusArea, selected])

  useEffect(() => {
    if (!selected) return
    tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // A new query or case marks its matches and goes to the first one from the caret; a reload only marks them, so
  // the line at the top stays.
  useEffect(() => {
    const view = codeView.current
    const reveal = !keepTop.current
    keepTop.current = false
    if (!find.open || (!view && !rendered)) return
    const current = matchAt(matches, findAnchor.current)
    setFind((state) => ({ ...state, current, of: matches }))
    // The page scrolls to its current match itself.
    if (view) showFindMatches(view, matches, current, reveal)
  }, [matches, find.open])

  const findStep = (direction: 1 | -1): void => {
    const view = codeView.current
    if (!view && !rendered) return
    const current = stepMatch(matches, currentMatch, direction)
    setFind((state) => ({ ...state, current, of: matches }))
    if (view) showFindMatches(view, matches, current, true)
  }

  const openFind = (): void => {
    findAnchor.current = codeView.current ? codeView.current.state.selection.main.from : 0
    setGoTo({ open: false, text: '', invalid: false })
    setFind((state) => ({ ...state, open: true }))
    setFocusArea('find')
    findField.current?.select()
  }

  const closeFind = (): void => {
    setFind((state) => ({ ...state, open: false }))
    if (codeView.current) showFindMatches(codeView.current, [], -1, false)
    setFocusArea('file')
  }

  const submitGoTo = (): void => {
    const view = codeView.current
    if (!view && !rendered) return
    const target = parseGoToLine(goTo.text, view ? view.state.doc.lines : ready?.lineCount ?? 1)
    if (!target) {
      setGoTo((state) => ({ ...state, invalid: true }))
      return
    }
    if (view) goToPosition(view, target.line, target.column)
    else pageView.current?.goToLine(target.line)
    setGoTo({ open: false, text: '', invalid: false })
    setFocusArea('file')
  }

  const expand = (path: string): void => {
    setExpanded((current) => new Set(current).add(path))
    if (!listings.has(path)) list(path)
  }
  const collapse = (path: string): void => setExpanded((current) => {
    const next = new Set(current)
    next.delete(path)
    return next
  })

  const escape = escapeStep({ focus: focusArea === 'tree' ? 'tree' : focusArea === 'field' ? 'field' : 'file', typed: typed.length > 0, revealed: revealed !== null,
    goTo: goTo.open, find: find.open })
  const cancelRef = useRef<() => void>(() => undefined)
  cancelRef.current = () => {
    switch (escape) {
      case 'clear-typed': setTyped(''); return
      case 'hide-secret': setShownSecret(null); return
      case 'close-goto':
        setGoTo({ open: false, text: '', invalid: false })
        setFocusArea('file')
        return
      case 'close-find': closeFind(); return
      case 'close-sheet': onClose.current()
    }
  }

  const onTreeKey = (event: React.KeyboardEvent): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const action = treeKey(rows, selected, event.key, typed)
    if (action.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind !== 'typed') setTyped('')
    switch (action.kind) {
      case 'select': setSelected(action.path); return
      case 'expand': expand(action.path); return
      case 'collapse': collapse(action.path); return
      case 'open': open(action.path); return
      case 'typed':
        setTyped(action.text)
        if (action.path) setSelected(action.path)
    }
  }

  // The sheet's own keys are taken before the file's view sees them, so CodeMirror never handles them.
  const onSheetKey = (event: React.KeyboardEvent): void => {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey
    const take = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (ctrl && event.shiftKey && event.code === 'KeyE') {
      take()
      onClose.current()
      return
    }
    if (plain && !event.shiftKey && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      take()
      cancelRef.current()
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyB') {
      take()
      setFolded((value) => {
        if (!value && focusArea === 'tree') setFocusArea(file ? 'file' : 'field')
        return !value
      })
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyF' && ready && ready.byteLength > 0) {
      take()
      openFind()
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyG' && ready && ready.byteLength > 0) {
      take()
      setFind((state) => (state.open ? { ...state, open: false } : state))
      if (codeView.current) showFindMatches(codeView.current, [], -1, false)
      setGoTo({ open: true, text: '', invalid: false })
      setFocusArea('goto')
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyR') {
      take()
      const view = codeView.current
      if (secretRanges.length === 0) return
      if (!view) {
        // On a page there is no caret: the first hidden value in view.
        const index = rendered ? pageView.current?.hiddenInView() ?? null : null
        if (index === null) setFeedback('No hidden value in view.')
        else toggleSecret(index)
        return
      }
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      const index = secretOnLine(secretRanges, line.from, line.to)
      if (index === null) setFeedback('No hidden value on this line.')
      else toggleSecret(index)
      return
    }
    if (plain && !event.shiftKey && event.key.toLowerCase() === 'm' && focusArea === 'file' && page && ready) {
      take()
      switchMarkdown(rendered ? 'source' : 'rendered')
      return
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      take()
      step(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (plain && event.key === 'F5') {
      take()
      if (changed) reload()
      return
    }
    if (plain && event.key === 'Tab') {
      take()
      const order: QuickLookFocus[] = [...(folded ? [] : ['tree' as const]), ...(ready ? ['file' as const] : [])]
      if (order.length === 0) return
      const index = order.indexOf(focusArea)
      setFocusArea(order[(index + (event.shiftKey ? order.length - 1 : 1)) % order.length]!)
    }
  }

  const onFindKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      findStep(event.shiftKey ? -1 : 1)
    } else if (event.altKey && !event.ctrlKey && event.code === 'KeyC') {
      event.preventDefault()
      setFind((state) => ({ ...state, matchCase: !state.matchCase }))
    }
  }

  const rootName = root ? quickLookName(root) || root : null
  const home = rootInfo?.home ?? null
  const unavailable = file?.result?.status === 'unavailable' ? file.result : null
  const type = file ? quickLookFileType(file.path) : null
  const footer = quickLookFooter({ focus: focusArea, fileOpen: !!ready, escape, folded, secrets: secretRanges.length > 0, back: canGoBack(trail), forward: canGoForward(trail),
    markdown: page ? (rendered ? 'rendered' : 'source') : null })

  return (
    <dialog ref={dialog} className={`app-dialog quick-look${peeking ? ' peeking' : ''}`} aria-label="Quick look" onKeyDownCapture={onSheetKey}>
      {peeking ? <p className="ql-peek" role="status">Peeking · release F8 to return</p> : null}
      <div className="ql-top">
        <label className={`ql-in${focusArea === 'field' ? ' focus' : ''}`}>
          <SearchGlyph />
          <input ref={field} aria-label="Go to file" placeholder="Go to file" spellCheck={false} onFocus={() => setFocusArea('field')} />
        </label>
        <div className="ql-seg" role="group" aria-label="Search">
          <span className={focusArea === 'field' ? 'on' : ''}>Files</span>
          <span>Contents</span>
        </div>
        <kbd>Esc</kbd>
      </div>
      <div className="ql-body">
        {folded ? null : (
          <aside className="ql-left" aria-label="Project">
            <div className="ql-head">
              {root ? <><b className="ql-root-name">{rootName}</b><span className="ql-root" title={root}>{quickLookHomePath(root, home)}</span></> : null}
              {typed ? <span className="ql-typed" aria-label={`Typed ${typed}`}>{typed}<span className="ql-caret" /></span> : null}
              {!typed && rootInfo?.status === 'ready' && rootInfo.gitRoot ? (
                <button type="button" className="ql-plate" onClick={() => setAtGitRoot((value) => !value)}>
                  {atGitRoot ? 'Session folder' : 'Git root'}
                </button>
              ) : null}
            </div>
            {rootInfo?.status === 'unavailable' || rootError ? (
              <p className="ql-unavailable">This folder is unavailable</p>
            ) : (
              <div ref={tree} className="ql-tree" role="tree" aria-label="Project files" tabIndex={0}
                aria-activedescendant={selected ? `ql-row-${rows.findIndex((row) => row.path === selected)}` : undefined}
                onKeyDown={onTreeKey} onFocus={() => setFocusArea('tree')}>
                {rows.map((row, index) => <TreeRowView key={row.path} row={row} index={index} selected={row.path === selected}
                  open={file?.path === row.path}
                  onClick={() => {
                    setSelected(row.path)
                    setTyped('')
                    if (row.kind === 'folder') (row.expanded ? collapse : expand)(row.path)
                    else if (row.kind === 'file' || row.kind === 'link') open(row.path)
                  }} />)}
              </div>
            )}
          </aside>
        )}
        <section className="ql-main" aria-label="File">
          {file ? (
            ready ? (
              <>
                <PathRow path={file.path} root={root} line={file.line}
                  facts={[type?.label, `${quickLookCount(ready.lineCount)} ${ready.lineCount === 1 ? 'line' : 'lines'}`, quickLookSize(ready.byteLength)].join(' · ')}
                  actions={page ? (
                    <span className="ql-seg ql-mode" role="group" aria-label="Markdown view">
                      <button type="button" className={rendered ? 'on' : ''} aria-pressed={rendered} onClick={() => switchMarkdown('rendered')}>Rendered</button>
                      <button type="button" className={rendered ? '' : 'on'} aria-pressed={!rendered} onClick={() => switchMarkdown('source')}>Source</button>
                    </span>
                  ) : null} />
                {pageTooLarge ? <p className="ql-note">Over 512 KB, so shown as source.</p> : null}
                {ready.canonicalPath !== ready.path ? <p className="ql-note">Through symlink · {ready.canonicalPath}</p> : null}
                {changed ? (
                  <div className="ql-changed" role="status">
                    <span>Changed on disk</span>{' '}<span aria-hidden="true">·</span>{' '}
                    <button type="button" className="ql-link-button" onClick={reload}>Reload</button>{' '}<kbd>F5</kbd>
                  </div>
                ) : null}
                {find.open ? (
                  <div className="ql-find" role="search" aria-label="Find in file">
                    <input ref={findField} className="ql-find-in" aria-label="Find in file" placeholder="Find in file" spellCheck={false}
                      value={find.query} onChange={(event) => setFind((state) => ({ ...state, query: event.target.value }))}
                      onKeyDown={onFindKey} onFocus={() => setFocusArea('find')} />
                    <button type="button" className={`ql-toggle${find.matchCase ? ' on' : ''}`} aria-pressed={find.matchCase} title="Match case (Alt C)"
                      onClick={() => setFind((state) => ({ ...state, matchCase: !state.matchCase }))}>Aa</button>
                    <span className="ql-count" aria-live="polite">{findCountLabel(matches, currentMatch, find.query)}</span>
                  </div>
                ) : null}
                {goTo.open ? (
                  <div className="ql-find" role="group" aria-label="Go to line">
                    <input ref={goToField} className="ql-find-in" aria-label="Go to line" placeholder="Line, or line:column" spellCheck={false}
                      value={goTo.text} onChange={(event) => setGoTo({ open: true, text: event.target.value, invalid: false })}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitGoTo() } }}
                      onFocus={() => setFocusArea('goto')} />
                    <span className="ql-count">{goTo.invalid ? 'Type a line, or a line and a column: 44 or 44:7' : `1–${quickLookCount(ready.lineCount)}`}</span>
                  </div>
                ) : null}
                {ready.byteLength === 0 ? <p className="ql-message">Empty file. Nothing to show.</p> : rendered && page ? (
                  <MarkdownPageView ref={pageView} page={page} path={ready.path} ranges={secretRanges} revealed={revealed} secondsLeft={secondsLeft}
                    matches={matches} current={currentMatch} line={file.line} heading={file.heading} topLine={file.topLine} focus={focusArea === 'file'}
                    status={pageStatus} onStatus={setPageStatus} onReveal={toggleSecret}
                    onTop={(line) => { shownTop.current = { path: ready.path, line } }}
                    onOpenFile={(path, line, column, heading) => open(path, line, column, { heading })}
                    onAddress={copyAddress} onFocus={() => setFocusArea('file')} />
                ) : (
                  <CodeView result={ready} text={text} secrets={secrets} onRevealSecret={toggleSecret} line={file.line ?? headingLine} column={file.column} topLine={file.topLine} focus={focusArea === 'file'}
                    onTop={(path, line) => { shownTop.current = { path, line } }}
                    onView={(view) => {
                      codeView.current = view
                      // A reload keeps find's marks on the new text.
                      if (view && findRef.current.open && findRef.current.matches.length > 0) {
                        showFindMatches(view, findRef.current.matches, Math.min(findRef.current.current, findRef.current.matches.length - 1), false)
                      }
                    }} onFocus={() => setFocusArea('file')} />
                )}
              </>
            ) : unavailable ? (
              <>
                <PathRow path={file.path} root={root} line={null}
                  eyebrow={unavailable.reason === 'too-large' ? 'Large' : unavailable.reason === 'binary' ? 'Binary' : undefined}
                  facts={unavailable.facts ? (unavailable.reason === 'too-large' ? `${quickLookSize(unavailable.facts.byteLength)} · over 2 MB, not shown`
                    : unavailable.reason === 'binary' ? `${quickLookSize(unavailable.facts.byteLength)} · no text preview` : null) : null} />
                <FileFacts result={unavailable} onFeedback={setFeedback} />
              </>
            ) : <PathRow path={file.path} root={root} line={file.line} facts="Reading…" />
          ) : <p className="ql-empty">{goneNote ?? (root ? 'Choose a file in the tree.' : rootInfo ? '' : 'Reading the project…')}</p>}
          {feedback ? <p className="ql-feedback" aria-live="polite">{feedback}</p> : null}
        </section>
      </div>
      <footer className="ql-hints">
        {footer.map((hint) => <span key={hint.label}>{hint.keys.map((key) => <kbd key={key}>{key}</kbd>)}{hint.label}</span>)}
        <span className="ql-hint-right"><kbd>Hold F8</kbd>Show terminals</span>
      </footer>
    </dialog>
  )
}

function TreeRowView(props: { row: TreeRow; index: number; selected: boolean; open: boolean; onClick(): void }): React.JSX.Element {
  const row = props.row
  const indent = { paddingLeft: `${6 + row.depth * 12}px` }
  if (row.kind === 'more' || row.kind === 'note') {
    return <div id={`ql-row-${props.index}`} className={`ql-tr ql-tr-${row.kind}${props.selected ? ' sel' : ''}`} style={indent} data-path={row.path}
      role="treeitem" aria-selected={props.selected}>{row.label}</div>
  }
  const folder = row.kind === 'folder'
  return (
    <div id={`ql-row-${props.index}`} className={`ql-tr${folder ? ' fold' : ''}${row.dimmed ? ' dim' : ''}${props.selected ? ' sel' : ''}${props.open ? ' open' : ''}`}
      style={indent} data-path={row.path} role="treeitem" aria-selected={props.selected} aria-level={row.depth + 1}
      {...(folder ? { 'aria-expanded': row.expanded } : {})} onClick={props.onClick}>
      <span className="ql-tr-chev">{folder ? <Chevron open={row.expanded} /> : null}</span>
      <span className="ql-nm">
        {row.joined.length > 0 ? <><i>{row.name}/</i>{row.joined.slice(0, -1).map((name) => <i key={name}>{name}/</i>)}{row.joined[row.joined.length - 1]}</> : row.name}
        {row.kind === 'link' ? <span className="ql-link"> → link</span> : null}
      </span>
    </div>
  )
}
