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
  exactAbsoluteFileReference,
  sameQuickLookIdentity,
  secretFileKind,
  type FileReferenceBase,
  type QuickLookReadResult,
  type QuickLookSaveResult,
  type QuickLookRootResult,
  type QuickLookSearchResult,
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
  REVEAL_SECONDS,
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
import { readEnvFile, readersOf } from './quick-look-env'
import { EMPTY_ENV_DRAFT, EnvView, envDraftDirty, envDraftSummary, envDraftText, rebaseEnvDraft, type EnvDraft, type EnvViewHandle } from './quick-look-env-view'
import { SaveBar, asksQuestion, type SaveRow } from './quick-look-save-bar'
import { ConfigEditor, type ConfigDraftState, type ConfigEditorHandle } from './quick-look-config-editor'
import { lineEndingOf } from './quick-look-config-edit'
import { configFormatOf, syntaxWords } from './quick-look-syntax'
import { quickLookFooter, type QuickLookFocus } from './quick-look-keys'
import { SearchResults } from './quick-look-results'
import { copiedReference, missingWords, type PrintedReference, type QuickLookAsk } from './quick-look-open'
import {
  CONTENTS_SEARCH_WAIT_MS,
  FILES_SEARCH_WAIT_MS,
  contentsHeader,
  filesHeader,
  flatMatches,
  matchInText,
  matchLabel,
  rowPieces,
  searchable,
  stepSearchMatch,
  type QuickLookSearchMode
} from './quick-look-search'
import './quick-look.css'

/** Below this sheet width the tree starts folded, so that the file keeps 80 columns. */
export const QUICK_LOOK_TREE_FOLD_WIDTH = 940
/** How often a shown file's identity is asked for while the window has focus (Story 67.2 AC2). */
export const QUICK_LOOK_IDENTITY_MS = 2000

/** Rendered or source, per Markdown file, kept in this window's memory until BMN quits (Story 67.4 AC1). */
const markdownModes = new Map<string, 'rendered' | 'source'>()

export interface QuickLookRequest {
  source: QuickLookSource
  /** A file to show at once, at its place: a path, or a reference resolved as a Ctrl+click is (Story 67.6). */
  open?: QuickLookAsk | null
  /** The paths the session's terminal printed, newest first, listed while the top field is empty (Story 67.6 AC7). */
  recent?: PrintedReference[]
  /** Open with the top field in "Contents" mode (Ctrl+Shift+G, Story 67.5). */
  search?: 'contents' | null
}

interface OpenFile {
  path: string
  line: number | null
  column: number | null
  /** The line kept at the top after a reload or from the remembered place. */
  topLine: number | null
  /** A heading a Markdown link named, shown at the top. */
  heading: string | null
  /** The reference this file was opened by and the folder it resolved from; null for a path opened directly. */
  reference: { text: string; base: FileReferenceBase | null } | null
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

/**
 * How a file comes to be opened: a new visit adds to the trail, a step along it, a recalled place or a match shown
 * while ↑ ↓ move through results does not.
 */
type OpenWay = 'visit' | 'trail' | 'recall' | 'preview'

interface SearchState {
  searching: boolean
  /** The running search, which Esc stops. */
  requestId: string | null
  result: QuickLookSearchResult | null
  failure: string | null
  /** The mode, text and switches the result answers. */
  answers: string | null
}

const IDLE_SEARCH: SearchState = { searching: false, requestId: null, result: null, failure: null, answers: null }

/** What test mode's hook returns: masked text only, never a hidden value. */
interface QuickLookTestSnapshot {
  path: string | null
  text: string | null
  hidden: number
  revealed: number | null
  /** An edited file: its rows with every value masked, what is unsaved and what the Save bar or its row says (Story 68.1). */
  edit?: { rows: string[]; dirty: boolean; bar: string | null; row: string | null; saved: string | null; readOnly: string | null; draft?: string; syntax?: string | null; editing?: boolean } | null
  search: {
    mode: QuickLookSearchMode
    query: string
    matchCase: boolean
    wholeWord: boolean
    searching: boolean
    /** The shown result answers the field as it is now. */
    fresh: boolean
    picked: number
    failure: string | null
    header: { count: string; read: string; notes: string[] } | null
    rows: string[]
    opened: string | null
    mark: { from: number; to: number } | null
  } | null
}

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

/** The path row's "…" menu: Copy reference, Show in Folder, and Send to session… for a session's file (Story 67.6 AC2). */
function PathMenu(props: { open: boolean; sendable: boolean; onToggle(): void; onAction(action: 'copy' | 'show' | 'send'): void; onDismiss(): void }): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.open) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [props.open])
  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    event.stopPropagation()
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  return (
    <span className="ql-menu-wrap" onBlur={(event) => { if (props.open && !event.currentTarget.contains(event.relatedTarget as Node | null)) props.onDismiss() }}>
      <button type="button" className="ql-icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={props.open} title="More actions" onClick={props.onToggle}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
      </button>
      {props.open ? (
        <div ref={menu} className="ql-menu" role="menu" aria-label="File actions" onKeyDown={onKey}>
          <button type="button" role="menuitem" onClick={() => props.onAction('copy')}>Copy reference</button>
          <button type="button" role="menuitem" onClick={() => props.onAction('show')}>Show in Folder</button>
          {props.sendable ? <button type="button" role="menuitem" onClick={() => props.onAction('send')}>Send to session…</button> : null}
        </div>
      ) : null}
    </span>
  )
}

/** A reference whose file is missing: where it was looked for, and a folder to look in for this one opening (Story 67.6 AC3). */
function MissingFile(props: { path: string; root: string | null; line: number | null; words: ReturnType<typeof missingWords>; onChooseFolder(): void }): React.JSX.Element {
  return (
    <>
      <PathRow path={props.path} root={props.root} line={props.line} eyebrow="Missing" facts={null} />
      <div className="ql-facts-block">
        <p className="ql-missing-title" role="status">{props.words.title}</p>
        <p className="ql-missing-from">{props.words.from}</p>
        {props.words.chooseFolder ? (
          <div className="ql-actions"><button type="button" className="ql-button" onClick={props.onChooseFolder}>Choose folder…</button></div>
        ) : null}
      </div>
    </>
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
  /** "Send to session…": today's file-reference dialog on this reference, at its send step; a session's sheet only. */
  onSendReference?(reference: string): void
  onClose(): void
  /**
   * The window is asked to close or BMN to quit while the sheet is open: unsaved edits ask first, and the answer says
   * whether the close goes on (Story 68.1 AC8).
   */
  closeAsk?: { id: string; answer(proceed: boolean): void } | null
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
  const [focusArea, setFocusArea] = useState<QuickLookFocus>(() => props.request.search === 'contents' ? 'field' : props.request.open ? 'file' : folded ? 'field' : 'tree')
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
  // Editing (Story 68.1): his draft, in memory only, the row in the Save bar's place, the value shown, the last save.
  const [envDraft, setEnvDraft] = useState<EnvDraft>(EMPTY_ENV_DRAFT)
  const [saveRow, setSaveRow] = useState<SaveRow | null>(null)
  const [envShown, setEnvShown] = useState<{ row: number; until: number } | null>(null)
  const [savedAt, setSavedAt] = useState<{ path: string; at: string } | null>(null)
  const [envField, setEnvField] = useState(false)
  // A config file's edit mode (Story 68.2): on with E, its draft's state, and a note where the footer's hint is.
  const [editing, setEditing] = useState(false)
  const [configDraft, setConfigDraft] = useState<ConfigDraftState | null>(null)
  const [configShown, setConfigShown] = useState(false)
  const [footerNote, setFooterNote] = useState<string | null>(null)
  const configEditor = useRef<ConfigEditorHandle | null>(null)
  /** The bytes the config draft was made on: the file as read when E was pressed, or as it was when the draft was carried. */
  const editDigest = useRef<string | null>(null)
  const envView = useRef<EnvViewHandle | null>(null)
  const dirtyRef = useRef(false)
  /** A close of the window or a Quit that waits for his answer to the unsaved edits. */
  const pendingClose = useRef<((proceed: boolean) => void) | null>(null)
  // The top field: "Go to file" by name or "Contents", its switches, the search it runs and the result ↑ ↓ are on.
  const [searchMode, setSearchMode] = useState<QuickLookSearchMode>(props.request.search === 'contents' ? 'contents' : 'files')
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [search, setSearch] = useState<SearchState>(IDLE_SEARCH)
  const [picked, setPicked] = useState(0)
  /** The match the open file was opened at, as an index into the contents results. */
  const [openedMatch, setOpenedMatch] = useState<number | null>(null)
  /** The open file was opened from the results, so Esc goes back to them. */
  const [fromResults, setFromResults] = useState(false)
  /** Set once he moves to the top field or types in it; a remembered file opening late then leaves the keys there. */
  const fieldClaimed = useRef(props.request.search === 'contents')
  const [menuOpen, setMenuOpen] = useState(false)
  const [recentPicked, setRecentPicked] = useState(0)
  const recent = props.request.recent ?? []
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
  const rootRef = useRef(root)
  rootRef.current = root
  const rows = useMemo(() => (root ? treeRows(root, listings, expanded) : []), [root, listings, expanded])
  const ready = file?.result?.status === 'ready' ? file.result : null
  const unavailable = file?.result?.status === 'unavailable' ? file.result : null
  const text = useMemo(() => (ready ? viewText(ready.content) : ''), [ready])
  // A .env file the host says may be edited opens as rows, unless its form leaves something to guess (Story 68.1 AC1).
  const envKind = !!ready && secretFileKind(ready.path) === 'env'
  const envModel = useMemo(() => (ready && envKind && ready.edit?.status === 'editable' ? readEnvFile(ready.content) : null), [ready, envKind])
  const envRows = envModel?.status === 'rows' ? envModel : null
  const readOnlyWords = envKind && ready ? (ready.edit?.status === 'read-only' ? ready.edit.message : envModel?.status === 'read-only' ? envModel.reason : null) : null
  // A JSON, JSONC, YAML or TOML file the host says may be edited enters edit mode with E (Story 68.2 AC1).
  const configFormat = ready ? configFormatOf(ready.path) : null
  const configEnding = ready ? lineEndingOf(ready.content) : '\n'
  const configReadOnly = configFormat && ready ? (ready.edit?.status === 'read-only' ? ready.edit.message : configEnding === 'mixed' ? 'Read-only · mixed line endings' : null) : null
  const configEditable = !!configFormat && ready?.edit?.status === 'editable' && configEnding !== 'mixed'
  const configEditing = editing && configEditable
  const dirty = (!!envRows && envDraftDirty(envDraft)) || (configEditing && !!configDraft?.dirty)
  dirtyRef.current = dirty
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
  const showResults = searchMode === 'files' ? query.trim().length > 0 : query.length > 0
  // With the top field empty and in focus, the left column lists the paths the terminal printed (Story 67.6 AC7).
  const showRecent = !showResults && !folded && focusArea === 'field' && query === '' && recent.length > 0
  const flat = useMemo(() => (search.result?.mode === 'contents' ? flatMatches(search.result) : []), [search.result])
  const fileHits = search.result?.mode === 'files' ? search.result.files : []
  const openedSearch = openedMatch !== null && file && flat[openedMatch]?.path === file.path ? flat[openedMatch]! : null
  // The match the file was opened at is marked as find marks one, while find is closed.
  const searchMark = useMemo(() => (openedSearch && ready ? matchInText(text, openedSearch) : null), [openedSearch, ready, text])
  const shownMatches = find.open ? matches : searchMark ? (rendered ? matchesOnPage([searchMark], runs) : [searchMark]) : []
  const searchMarkRef = useRef(searchMark)
  searchMarkRef.current = find.open ? null : searchMark

  const list = useCallback((folder: string): void => {
    setListings((current) => new Map(current).set(folder, current.get(folder) ?? { entries: null, more: 0, unavailable: null }))
    void window.aiTerminal.listQuickLookFolder({ ...source, folder })
      .then((result) => setListings((current) => new Map(current).set(folder, result.status === 'ready'
        ? { entries: result.entries, more: result.more, unavailable: null }
        : { entries: [], more: 0, unavailable: result.message })))
      .catch((error: unknown) => setListings((current) => new Map(current).set(folder, { entries: [], more: 0, unavailable: failureText(error, 'This folder is unavailable') })))
  }, [source])

  const read = useCallback((path: string): Promise<QuickLookReadResult> => window.aiTerminal.readQuickLookFile({ ...source, path, ...(rootRef.current ? { root: rootRef.current } : {}) })
    .catch((error: unknown): QuickLookReadResult => ({
      status: 'unavailable', path, canonicalPath: null, reason: 'unreadable', message: failureText(error, 'The file could not be read.'), facts: null
    })), [source])

  const shownPath = useRef<string | null>(null)
  shownPath.current = file?.path ?? null
  /** The shown file's top line, as its view last reported it; read through refs, so a memoised opener sees it too. */
  const currentTop = useCallback((): number | null => (shownTop.current && shownTop.current.path === shownPath.current ? shownTop.current.line : null), [])

  const open = useCallback((path: string, line: number | null = null, column: number | null = null,
    options: { way?: OpenWay; topLine?: number | null; focus?: boolean; heading?: string | null; match?: number | null; fromResults?: boolean
      reference?: { text: string; base: FileReferenceBase | null } | null } = {}): void => {
    const way = options.way ?? 'visit'
    // Unsaved edits are never dropped without a question: opening another file asks first (Story 68.1 AC8).
    if (dirtyRef.current && path !== shownPath.current) {
      setSaveRow({ kind: 'guard', then: () => openRef.current(path, line, column, options) })
      return
    }
    setMenuOpen(false)
    setOpenedMatch(options.match ?? null)
    setFromResults(options.fromResults === true)
    if (way !== 'trail' && way !== 'preview') {
      const here = currentTop()
      setTrail((current) => trailVisit(current, { path, line, column }, here))
    }
    setFile({ path, line, column, topLine: options.topLine ?? null, heading: options.heading ?? null, reference: options.reference ?? null, result: null })
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
  const openRef = useRef(open)
  openRef.current = open

  /**
   * Opens a reference as a Ctrl+click does: resolved by the session's launch folder (or a folder chosen for this
   * opening), then shown here at its line and column; a missing file says where it was looked for (Story 67.6).
   */
  const openReference = useCallback((reference: string, baseDirectory: string | null = null, options: { fromResults?: boolean; asked?: boolean } = {}): void => {
    void window.aiTerminal.readFileReference({ ...source, reference, baseDirectory })
      // The file the opening asked for, resolved after he went to the top field, opens without taking its keys.
      .then((resolved) => open(resolved.resolvedPath, resolved.line, resolved.column, {
        reference: { text: reference, base: resolved.base }, fromResults: options.fromResults === true, focus: !(options.asked && fieldClaimed.current)
      }))
      .catch((error: unknown) => setFeedback(failureText(error, 'The file reference could not be opened.')))
  }, [source, open])

  const openAsk = (wanted: QuickLookAsk): void => {
    if ('reference' in wanted) openReference(wanted.reference, null, { asked: true })
    else open(wanted.path, wanted.line, wanted.column, { focus: !fieldClaimed.current })
  }

  /** Reads the shown file again and keeps the line at the top; nothing reloads by itself (Story 67.2 AC2). */
  const reload = (): void => {
    if (!file) return
    if (dirtyRef.current) {
      guarded(reload)
      return
    }
    const { path } = file
    const topLine = currentTop()
    keepTop.current = true
    setShownSecret(null)
    setChanged(false)
    void read(path).then((result) => setFile((current) => (current?.path === path ? { ...current, topLine, result } : current)))
  }

  const step = (direction: -1 | 1): void => {
    if (dirtyRef.current) {
      guarded(() => step(direction))
      return
    }
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

  /** A row of the edited .env file shown for ten seconds, or hidden again; one at a time (Story 68.1 AC2). */
  const toggleEnvValue = (row: number): void => setEnvShown((current) => (current?.row === row ? null : { row, until: Date.now() + REVEAL_SECONDS * 1000 }))

  /** Drops his draft and every question about it; the file stays as it was read. */
  const dropDraft = (): void => {
    dirtyRef.current = false
    setEnvDraft(EMPTY_ENV_DRAFT)
    setEnvShown(null)
    setSaveRow(null)
    setEditing(false)
    setConfigDraft(null)
    setConfigShown(false)
  }

  /**
   * Writes the draft through the host's one save method (Story 68.1 AC6). True once the file on disk holds it; the
   * draft is kept on any other outcome, and the row in the Save bar's place says why.
   */
  const saveDraft = async (): Promise<boolean> => {
    const base = ready
    if (!base || !rootRef.current || (!envRows && !configEditing)) return false
    const out = configEditing ? { status: 'ready' as const, text: configEditor.current?.text() ?? '' } : envDraftText(base.content, envRows!, envDraft)
    if (out.status === 'refused') {
      setSaveRow({ kind: 'failed', message: `Could not save · ${out.message}` })
      return false
    }
    setSaveRow({ kind: 'saving' })
    const digest = configEditing ? editDigest.current ?? base.digest : base.digest
    const result: QuickLookSaveResult = await window.aiTerminal.saveQuickLookFile({ ...source, root: rootRef.current, path: base.path, digest, text: out.text })
      .catch(() => ({ status: 'failed', message: 'Could not save · BMN could not reach the file' }))
    if (result.status === 'changed') {
      setSaveRow({ kind: 'conflict' })
      return false
    }
    if (result.status === 'failed') {
      setSaveRow({ kind: 'failed', message: result.message })
      return false
    }
    const path = base.path
    dropDraft()
    setSavedAt({ path, at: new Date(result.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    setChanged(false)
    void read(path).then((next) => setFile((current) => (current?.path === path ? { ...current, result: next } : current)))
    return true
  }

  /** Every way out with unsaved edits asks first: Save, Discard, Keep editing (Story 68.1 AC8). */
  const guarded = (then: () => void, keep?: () => void): void => {
    if (dirtyRef.current) setSaveRow({ kind: 'guard', then, ...(keep ? { keep } : {}) })
    else then()
  }

  const keepEditing = (): void => {
    const row = saveRow
    setSaveRow(row?.kind === 'failed' ? row : null)
    if (row?.kind === 'guard') row.keep?.()
    window.setTimeout(() => (configEditor.current ?? envView.current)?.focus(), 0)
  }

  /** Ctrl+S or Save: a config draft that does not parse asks first, with Keep editing in focus (Story 68.2 AC6). */
  const saveOrAsk = (): void => {
    const verdict = configEditing ? configEditor.current?.verdict() : null
    if (verdict?.status === 'invalid' && configFormat) {
      // A close waiting on the answer stays open: he is asked about the file first.
      if (saveRow?.kind === 'guard') saveRow.keep?.()
      setSaveRow({ kind: 'invalid', words: syntaxWords(configFormat, verdict) })
      return
    }
    onSaveBarSave()
  }

  const onSaveBarSave = (): void => {
    const row = saveRow
    void saveDraft().then((saved) => {
      if (row?.kind !== 'guard') return
      if (saved) row.then()
      else row.keep?.()
    })
  }

  const onSaveBarDiscard = (): void => {
    const row = saveRow
    dropDraft()
    if (row?.kind === 'guard') row.then()
  }

  /** The file as it is on disk now, masked, while his draft is kept and carried onto it (AC6). */
  const reviewLatest = (): void => {
    if (!ready || (!envRows && !configEditing)) return
    const path = ready.path
    if (configEditing) {
      void read(path).then((next) => {
        if (next.status !== 'ready' || shownPath.current !== path) {
          setSaveRow({ kind: 'failed', message: 'Could not save · the file can no longer be read' })
          return
        }
        if (!configEditor.current?.carry(viewText(next.content))) {
          setSaveRow({ kind: 'failed', message: 'Could not save · the other program changed the lines you changed' })
          return
        }
        editDigest.current = next.digest
        setSaveRow(null)
        setChanged(false)
        setFile((current) => (current?.path === path ? { ...current, result: next } : current))
        setFeedback('Latest from disk · your edits are kept on it')
      })
      return
    }
    const from = envRows
    if (!from) return
    void read(path).then((next) => {
      if (next.status !== 'ready' || shownPath.current !== path) {
        setSaveRow({ kind: 'failed', message: 'Could not save · the file can no longer be read' })
        return
      }
      const model = readEnvFile(next.content)
      const carried = model.status === 'rows' ? rebaseEnvDraft(from, model, envDraft) : null
      if (!carried) {
        setSaveRow({ kind: 'failed', message: 'Could not save · a key you changed is no longer in the file' })
        return
      }
      setEnvDraft(carried)
      setSaveRow(null)
      setChanged(false)
      setFile((current) => (current?.path === path ? { ...current, result: next } : current))
      setFeedback('Latest from disk · your edits are kept on it')
    })
  }

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
  useEffect(() => {
    if (!envShown) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= envShown.until) setEnvShown(null)
    }, 250)
    return () => window.clearInterval(timer)
  }, [envShown])

  // A draft belongs to the file it was made on; another file starts clean, and so does a closed sheet (AC10).
  useEffect(() => {
    dropDraft()
    setEnvField(false)
    setFooterNote(null)
  }, [ready?.path])
  // A note where the footer's hint is lasts a few seconds.
  useEffect(() => {
    if (!footerNote) return
    const timer = window.setTimeout(() => setFooterNote(null), 4000)
    return () => window.clearTimeout(timer)
  }, [footerNote])

  // The window's close and Quit learn only whether there are unsaved edits, never what they are.
  useEffect(() => {
    window.aiTerminal.reportQuickLookUnsaved(dirty)
  }, [dirty])
  useEffect(() => () => window.aiTerminal.reportQuickLookUnsaved(false), [])

  // A close of the window or a Quit asks here first when there are unsaved edits; otherwise it goes on at once.
  useEffect(() => {
    const ask = props.closeAsk
    if (!ask) return
    if (!dirtyRef.current) {
      ask.answer(true)
      return
    }
    let answered = false
    const answer = (proceed: boolean): void => {
      if (answered) return
      answered = true
      pendingClose.current = null
      ask.answer(proceed)
    }
    pendingClose.current = answer
    setSaveRow({ kind: 'guard', then: () => answer(true), keep: () => answer(false) })
  }, [props.closeAsk?.id])

  // Test mode only: what the sheet shows of the file, with every hidden value masked, never the value itself.
  const hookRef = useRef<() => QuickLookTestSnapshot>(() => ({ path: null, text: null, hidden: 0, revealed: null, search: null }))
  hookRef.current = () => ({
    path: ready?.path ?? null, text: ready ? maskedSlice(text, secretRanges, 0, text.length, revealed) : null, hidden: secretRanges.length, revealed,
    // Never a value, shown or not: a name, the dots and a length (AC10).
    edit: envRows ? {
      rows: [
        ...envRows.rows.flatMap((row) => (row.kind === 'key' ? [`${row.name}=•••• ${(envDraft.changed.get(row.line) ?? row.value).length}${envDraft.changed.has(row.line) ? ' unsaved' : ''}`] : [])),
        ...envDraft.added.map((each) => `${each.name || '(unnamed)'}=•••• ${each.value.length} added`)
      ],
      dirty, bar: dirty ? envDraftSummary(envRows, envDraft) : null,
      row: saveRow ? (saveRow.kind === 'failed' ? saveRow.message : saveRow.kind === 'invalid' ? saveRow.words : saveRow.kind) : null,
      saved: savedAt && ready && savedAt.path === ready.path ? savedAt.at : null, readOnly: null
    } : configEditing ? {
      rows: [], dirty, bar: dirty ? configDraft?.summary ?? null : null, editing: true, draft: configEditor.current?.masked() ?? '', syntax: configDraft?.syntax ?? null,
      row: saveRow ? (saveRow.kind === 'failed' ? saveRow.message : saveRow.kind === 'invalid' ? saveRow.words : saveRow.kind) : null,
      saved: savedAt && ready && savedAt.path === ready.path ? savedAt.at : null, readOnly: null
    } : readOnlyWords || configReadOnly ? { rows: [], dirty: false, bar: null, row: null, saved: savedAt && ready && savedAt.path === ready.path ? savedAt.at : null, readOnly: readOnlyWords ?? configReadOnly }
      : savedAt && ready && savedAt.path === ready.path ? { rows: [], dirty: false, bar: null, row: null, saved: savedAt.at, readOnly: null } : null,
    search: showResults ? {
      mode: searchMode, query, matchCase, wholeWord, searching: search.searching, fresh, picked, failure: search.failure,
      header: search.result?.mode === 'contents' ? contentsHeader(search.result) : search.result?.mode === 'files' ? { count: filesHeader(search.result), read: '', notes: [] } : null,
      rows: search.result?.mode === 'contents' ? search.result.files.flatMap((each) => each.lines.map((line) => {
        const pieces = rowPieces(line)
        return `${quickLookName(each.path)}:${line.line} ${pieces.before}[${pieces.match}]${pieces.after}`
      })) : fileHits.map((hit) => hit.path),
      opened: openedSearch ? matchLabel(openedMatch!, flat.length) : null,
      mark: searchMark
    } : null
  })
  useEffect(() => {
    if (!props.testMode) return
    const target = window as unknown as { __aitermQuickLook?: { snapshot(): QuickLookTestSnapshot } }
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
          setEnvShown(null)
          configEditor.current?.hide()
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
      setEnvShown(null)
      configEditor.current?.hide()
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
    if (wanted) openAsk(wanted)
    // Opened for a search, or once he went to the top field, the remembered file opens without taking the keys.
    else if (place?.file) open(place.file.path, null, null, { way: 'recall', topLine: place.file.topLine, focus: !fieldClaimed.current })
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
    openAsk(wanted)
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

  // The top field searches after a short wait; a newer query, a switch, closing the sheet or a new root cancels
  // the older search, and one search runs per window (Story 67.5).
  const searching = !!root && searchable(searchMode, query)
  const searchKey = JSON.stringify([root, searchMode, query, matchCase, wholeWord])
  // Results answer the field only as it was when they came; until the new answer comes they are shown dimmed and
  // nothing in them opens, so Enter never opens a file of the query before.
  const fresh = search.answers === searchKey
  useEffect(() => {
    if (!root || !searching) {
      setSearch(IDLE_SEARCH)
      return
    }
    const requestId = crypto.randomUUID()
    let live = true
    const timer = window.setTimeout(() => {
      setSearch((current) => ({ ...current, searching: true, requestId, failure: null }))
      void window.aiTerminal.quickLookSearch({ ...source, requestId, root, mode: searchMode, query, matchCase, wholeWord })
        .then((result) => {
          if (!live) return
          setSearch({ searching: false, requestId: null, result, failure: null, answers: searchKey })
          setPicked(0)
        })
        .catch((error: unknown) => { if (live) setSearch({ searching: false, requestId: null, result: null, failure: failureText(error, 'The search failed.'), answers: searchKey }) })
    }, searchMode === 'files' ? FILES_SEARCH_WAIT_MS : CONTENTS_SEARCH_WAIT_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
      void window.aiTerminal.cancelQuickLookSearch(requestId).catch(() => undefined)
    }
  }, [root, searching, searchMode, query, matchCase, wholeWord, source, searchKey])

  /** Shows a match of the contents results: while ↑ ↓ move, without the keys; with Enter, in the file with the keys. */
  const showMatch = (index: number, withKeys: boolean): void => {
    const match = flat[index]
    if (!match) return
    setPicked(index)
    if (file?.result && file.path === match.path && file.line === match.line && file.column === match.column) {
      setOpenedMatch(index)
      if (withKeys) {
        const here = currentTop()
        setTrail((current) => trailVisit(current, { path: match.path, line: match.line, column: match.column }, here))
        setFromResults(true)
        setFocusArea('file')
      }
      return
    }
    open(match.path, match.line, match.column, { way: withKeys ? 'visit' : 'preview', focus: withKeys, match: index, fromResults: true })
  }

  /** The next or previous match from the open one, across files. */
  const stepResult = (direction: 1 | -1): void => {
    if (!fresh) return
    const next = stepSearchMatch(openedMatch ?? picked, flat.length, direction)
    if (next >= 0) showMatch(next, focusArea === 'file')
  }

  const onFieldKey = (event: React.KeyboardEvent): void => {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey
    if (showRecent && plain && !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
      event.preventDefault()
      if (event.key === 'Enter') openRecent(recentPicked)
      else setRecentPicked((index) => stepSearchMatch(index, recent.length, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    const total = searchMode === 'contents' ? flat.length : fileHits.length
    if (plain && !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (total === 0 || !fresh) return
      const next = stepSearchMatch(picked, total, event.key === 'ArrowDown' ? 1 : -1)
      if (searchMode === 'contents') showMatch(next, false)
      else setPicked(next)
      return
    }
    if (plain && event.key === 'Enter') {
      event.preventDefault()
      if (!fresh) return
      if (searchMode === 'contents') showMatch(Math.max(0, picked), true)
      else if (fileHits[picked]) open(fileHits[picked]!.path, null, null, { fromResults: true })
      return
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && searchMode === 'contents' && (event.code === 'KeyC' || event.code === 'KeyW')) {
      event.preventDefault()
      if (event.code === 'KeyC') setMatchCase((value) => !value)
      else setWholeWord((value) => !value)
    }
  }

  /** A printed path opens as its Ctrl+click would, resolved by the session's launch folder; nothing was read to list it. */
  const openRecent = (index: number): void => {
    const each = recent[index]
    if (!each) return
    setRecentPicked(index)
    openReference(each.text)
  }

  /** The "…" menu's actions on the shown file (Story 67.6 AC2). */
  const menuPath = ready ? ready.canonicalPath : unavailable?.facts ? unavailable.canonicalPath ?? unavailable.path : null
  const sendable = !!props.onSendReference && !!source.sessionId && !!ready
  const menuAction = (action: 'copy' | 'show' | 'send'): void => {
    setMenuOpen(false)
    if (!menuPath || !file) return
    if (action === 'copy') {
      void window.aiTerminal.writeClipboardText(copiedReference(menuPath, file.line, file.column))
        .then(() => setFeedback('Reference copied.'))
        .catch((error: unknown) => setFeedback(failureText(error, 'Copy failed.')))
    } else if (action === 'show') {
      void window.aiTerminal.showFileReference(menuPath)
        .then(() => setFeedback('Shown in the file manager.'))
        .catch((error: unknown) => setFeedback(failureText(error, 'Show in Folder failed.')))
    } else {
      const reference = exactAbsoluteFileReference(menuPath, file.line, file.column)
      if (reference && props.onSendReference) props.onSendReference(reference)
      else setFeedback('This path cannot be written as a file reference.')
    }
  }

  const chooseFolder = (): void => {
    const reference = file?.reference
    if (!reference) return
    void window.aiTerminal.chooseFileReferenceBase()
      .then((folder) => { if (folder) openReference(reference.text, folder) })
      .catch((error: unknown) => setFeedback(failureText(error, 'The folder picker is unavailable.')))
  }

  /** Ctrl+P and Ctrl+Shift+G: the top field in its mode, its text selected. */
  const focusField = (mode: QuickLookSearchMode): void => {
    fieldClaimed.current = true
    setSearchMode(mode)
    setFocusArea('field')
    field.current?.focus()
    field.current?.select()
  }

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

  // A file that is being read has no view to hold the keys, and the view it replaces took focus with it: the sheet
  // keeps it, so a key pressed in that moment still reaches the sheet and not the page behind.
  useEffect(() => {
    const element = dialog.current
    const active = document.activeElement
    if (element?.open && (!active || active === document.body || !element.contains(active))) element.focus({ preventScroll: true })
  })

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

  const escape = escapeStep({ focus: focusArea === 'tree' ? 'tree' : focusArea === 'field' ? 'field' : 'file', typed: typed.length > 0, revealed: revealed !== null || envShown !== null || configShown,
    goTo: goTo.open, find: find.open, search: search.searching ? 'searching' : showResults ? 'results' : null, fromResults, menu: menuOpen,
    question: asksQuestion(saveRow), editField: !!envRows && envField && focusArea === 'file' })
  const cancelRef = useRef<() => void>(() => undefined)
  cancelRef.current = () => {
    switch (escape) {
      case 'keep-editing': keepEditing(); return
      case 'leave-field': envView.current?.leaveField(); return
      case 'close-menu':
        setMenuOpen(false)
        // As any menu: the focus goes back to the button that opened it.
        dialog.current?.querySelector<HTMLElement>('.ql-path button[aria-label="More actions"]')?.focus()
        return
      case 'clear-typed': setTyped(''); return
      case 'hide-secret':
        setShownSecret(null)
        setEnvShown(null)
        configEditor.current?.hide()
        return
      case 'close-goto':
        setGoTo({ open: false, text: '', invalid: false })
        setFocusArea('file')
        return
      case 'close-find': closeFind(); return
      case 'stop-search':
        if (search.requestId) void window.aiTerminal.cancelQuickLookSearch(search.requestId).catch(() => undefined)
        return
      case 'clear-search':
        setQuery('')
        setFocusArea(folded ? 'field' : 'tree')
        return
      case 'back-to-results':
        setFocusArea('field')
        field.current?.focus()
        return
      case 'close-sheet': guarded(() => onClose.current())
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
      guarded(() => onClose.current())
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyS' && (envRows || configEditing)) {
      take()
      if (dirty && saveRow?.kind !== 'saving' && !asksQuestion(saveRow)) saveOrAsk()
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyR' && configEditing) {
      take()
      if (!configEditor.current?.revealAtCaret()) setFeedback('No hidden value on this line.')
      return
    }
    // E enters edit mode on a config file that may be edited, and says why not on any other (Story 68.2 AC1).
    if (plain && !event.shiftKey && event.key.toLowerCase() === 'e' && focusArea === 'file' && ready && !configEditing && !envRows && !event.nativeEvent.isComposing) {
      take()
      if (configEditable) {
        editDigest.current = ready.digest
        setEditing(true)
        setFind((state) => (state.open ? { ...state, open: false } : state))
        setGoTo({ open: false, text: '', invalid: false })
      } else setFooterNote(configReadOnly ?? readOnlyWords ?? 'Read-only · source file')
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyR' && envRows) {
      take()
      const row = envView.current?.selectedRow() ?? null
      if (row === null) setFeedback('No value selected.')
      else toggleEnvValue(row)
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyP') {
      take()
      focusField('files')
      return
    }
    if (ctrl && event.shiftKey && event.code === 'KeyG') {
      take()
      focusField('contents')
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
    if (ctrl && !event.shiftKey && event.code === 'KeyF' && ready && ready.byteLength > 0 && !configEditing) {
      take()
      openFind()
      return
    }
    if (ctrl && !event.shiftKey && event.code === 'KeyG' && ready && ready.byteLength > 0 && !configEditing) {
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
      // The empty top field shows printed paths where the tree is; Tab from it brings the tree back and goes there.
      if (!event.shiftKey && showRecent && document.activeElement === field.current) {
        setFocusArea('tree')
        return
      }
      const stops = tabStops()
      if (stops.length === 0) return
      const active = document.activeElement
      // The innermost stop that holds the focus: a link before the page around it, the code view for its own parts.
      let index = stops.indexOf(active as HTMLElement)
      if (index === -1) index = stops.findLastIndex((stop) => !!active && stop.contains(active))
      if (index === -1 && active?.closest('.ql-code')) index = stops.findIndex((stop) => !!stop.closest('.ql-code'))
      const next = index === -1 ? (event.shiftKey ? stops.length - 1 : 0) : (index + (event.shiftKey ? stops.length - 1 : 1)) % stops.length
      stops[next]!.focus()
    }
  }

  /**
   * Where Tab goes, in order: the top field, the tree, the file, the page's links, the path row's buttons, the file
   * state's own actions (Choose folder…, Show in Folder, Copy path), the root's buttons, and round again. The tree and the code view are one stop each and keep their own keys; the tree and the
   * file stay next to each other, as the footer's "Tab" says. An eye is left out: Ctrl+R shows the value.
   */
  const tabStops = (): HTMLElement[] => {
    const element = dialog.current
    if (!element) return []
    const all = (selector: string): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(selector)]
    return [
      field.current, folded ? null : tree.current,
      element.querySelector<HTMLElement>('.ql-code .cm-content') ?? element.querySelector<HTMLElement>('.ql-page') ?? element.querySelector<HTMLElement>('.ql-env-rows'),
      ...all('.ql-env-add button'), ...all('.ql-save button'),
      ...all('.ql-find input'), ...all('.ql-page .ql-md-a, .ql-page .ql-md-img'), ...all('.ql-path button'), ...all('.ql-actions button'), ...all('.ql-head button')
    ].filter((stop): stop is HTMLElement => !!stop && stop.getClientRects().length > 0 && !(stop as HTMLButtonElement).disabled)
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
  const type = file ? quickLookFileType(file.path) : null
  const footer = quickLookFooter({ focus: focusArea, fileOpen: !!ready, escape, folded, secrets: secretRanges.length > 0, back: canGoBack(trail), forward: canGoForward(trail),
    markdown: page ? (rendered ? 'rendered' : 'source') : null, search: showResults ? searchMode : showRecent ? 'recent' : null,
    edit: envRows ? (envField ? 'env-field' : 'env-rows') : configEditing ? 'config' : configEditable ? 'config-available' : null,
    note: footerNote ?? (configReadOnly && !configEditing ? configReadOnly : null) })

  return (
    <dialog ref={dialog} className={`app-dialog quick-look${peeking ? ' peeking' : ''}`} aria-label="Quick look" tabIndex={-1} onKeyDownCapture={onSheetKey}>
      {peeking ? <p className="ql-peek" role="status">Peeking · release F8 to return</p> : null}
      <div className="ql-top">
        <label className={`ql-in${focusArea === 'field' ? ' focus' : ''}`}>
          <SearchGlyph />
          <input ref={field} aria-label={searchMode === 'files' ? 'Go to file' : 'Search contents'} placeholder={searchMode === 'files' ? 'Go to file' : 'Search contents'}
            spellCheck={false} value={query} maxLength={256} onChange={(event) => { fieldClaimed.current = true; setQuery(event.target.value); setPicked(0) }}
            onKeyDown={onFieldKey} onFocus={() => setFocusArea('field')} />
          {searchMode === 'contents' ? (
            <>
              <button type="button" className={`ql-toggle${matchCase ? ' on' : ''}`} aria-pressed={matchCase} title="Match case (Alt C)"
                onMouseDown={(event) => event.preventDefault()} onClick={() => setMatchCase((value) => !value)}>Aa</button>
              <button type="button" className={`ql-toggle${wholeWord ? ' on' : ''}`} aria-pressed={wholeWord} title="Whole word (Alt W)"
                onMouseDown={(event) => event.preventDefault()} onClick={() => setWholeWord((value) => !value)}>W</button>
            </>
          ) : null}
        </label>
        <div className="ql-seg ql-switch" role="group" aria-label="Search">
          <button type="button" className={searchMode === 'files' ? 'on' : ''} aria-pressed={searchMode === 'files'} title="Go to file (Ctrl P)" onClick={() => focusField('files')}>Files</button>
          <button type="button" className={searchMode === 'contents' ? 'on' : ''} aria-pressed={searchMode === 'contents'} title="Search contents (Ctrl Shift G)" onClick={() => focusField('contents')}>Contents</button>
        </div>
        <kbd>Esc</kbd>
      </div>
      <div className="ql-body">
        {showResults ? (
          <aside className="ql-left ql-searching" aria-label={searchMode === 'files' ? 'Go to file' : 'Search contents'}>
            <SearchResults root={root} picked={picked} stale={!fresh}
              search={{ mode: searchMode, searching: search.searching, result: search.result, failure: search.failure,
                waiting: !root ? 'This folder is unavailable' : searchMode === 'contents' && !searchable('contents', query) ? 'Type at least 2 characters' : null }}
              onOpen={(index) => {
                if (!fresh) return
                if (searchMode === 'contents') showMatch(index, true)
                else if (fileHits[index]) {
                  setPicked(index)
                  open(fileHits[index]!.path, null, null, { fromResults: true })
                }
              }} />
          </aside>
        ) : showRecent ? (
          <aside className="ql-left ql-searching" aria-label="Printed paths">
            <div className="ql-results">
              <div className="ql-results-head"><span>Printed in this session</span><span className="ql-results-read">newest first</span></div>
              <div className="ql-results-list" role="listbox" aria-label="Printed paths">
                {recent.map((each, index) => (
                  <div key={each.text} className={`ql-rf${index === recentPicked ? ' sel' : ''}`} role="option" aria-selected={index === recentPicked}
                    onMouseDown={(event) => event.preventDefault()} onClick={() => openRecent(index)}>
                    <span className="ql-rf-name">{quickLookName(each.path)}{each.line !== null ? <span className="ql-pp">:{each.line}</span> : null}</span>
                    <span className="ql-rf-dir"><bdi>{each.path.includes('/') ? each.path.slice(0, each.path.lastIndexOf('/')) : ''}</bdi></span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        ) : folded ? null : (
          <aside className="ql-left" aria-label="Project">
            <div className="ql-head">
              {root ? <><b className="ql-root-name">{rootName}</b><span className="ql-root" title={root}>{quickLookHomePath(root, home)}</span></> : null}
              {typed ? <span className="ql-typed" aria-label={`Typed ${typed}`}>{typed}<span className="ql-caret" /></span> : null}
              {!typed && rootInfo?.status === 'ready' && rootInfo.gitRoot ? (
                <button type="button" className="ql-plate" onClick={() => guarded(() => setAtGitRoot((value) => !value))}>
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
                  open={file?.path === row.path} dirty={dirty && file?.path === row.path}
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
                  facts={openedSearch ? matchLabel(openedMatch!, flat.length)
                    : envRows && ready.edit?.status === 'editable'
                      ? [`${envRows.keys} ${envRows.keys === 1 ? 'key' : 'keys'}`, readersOf(ready.edit.mode), ...(savedAt?.path === ready.path && !dirty ? [`Saved ${savedAt.at}`] : [])].join(' · ')
                      : [type?.label, `${quickLookCount(ready.lineCount)} ${ready.lineCount === 1 ? 'line' : 'lines'}`, quickLookSize(ready.byteLength),
                        ...(savedAt?.path === ready.path && !dirty ? [`Saved ${savedAt.at}`] : [])].join(' · ')}
                  actions={(
                    <>
                      {configEditing ? <span className="ql-editing-plate">EDITING</span> : null}
                      {openedSearch ? (
                        <span className="ql-match-nav" role="group" aria-label="Matches">
                          <button type="button" className="ql-icon-button" aria-label="Previous match" title="Previous match" onClick={() => stepResult(-1)}>
                            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                          <button type="button" className="ql-icon-button" aria-label="Next match" title="Next match" onClick={() => stepResult(1)}>
                            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                        </span>
                      ) : null}
                      {page ? (
                        <span className="ql-seg ql-mode" role="group" aria-label="Markdown view">
                          <button type="button" className={rendered ? 'on' : ''} aria-pressed={rendered} onClick={() => switchMarkdown('rendered')}>Rendered</button>
                          <button type="button" className={rendered ? '' : 'on'} aria-pressed={!rendered} onClick={() => switchMarkdown('source')}>Source</button>
                        </span>
                      ) : null}
                      <PathMenu open={menuOpen} sendable={sendable} onToggle={() => setMenuOpen((value) => !value)} onAction={menuAction} onDismiss={() => setMenuOpen(false)} />
                    </>
                  )} />
                {pageTooLarge ? <p className="ql-note">Over 512 KB, so shown as source.</p> : null}
                {readOnlyWords ? <p className="ql-note ql-read-only">{readOnlyWords}</p> : null}
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
                {configEditing && configFormat ? (
                  <>
                    <ConfigEditor key={ready.path} ref={configEditor} path={ready.path} canonicalPath={ready.canonicalPath} content={text} format={configFormat}
                      lineEnding={configEnding === '\r\n' ? '\r\n' : '\n'} focus={focusArea === 'file' && !asksQuestion(saveRow)}
                      onDraft={setConfigDraft} onNote={setFooterNote} onShown={setConfigShown} onFocus={() => setFocusArea('file')} />
                    {configDraft?.syntax ? <p className={`ql-syntax${configDraft.valid === false ? ' ql-refused' : ''}`} role="status">{configDraft.syntax}</p> : null}
                  </>
                ) : envRows ? (
                  <EnvView ref={envView} model={envRows} draft={envDraft} onDraft={setEnvDraft}
                    shown={envShown ? { row: envShown.row, secondsLeft: Math.min(REVEAL_SECONDS, Math.max(1, Math.ceil((envShown.until - now) / 1000))) } : null}
                    onReveal={toggleEnvValue} onStatus={setFeedback} focus={focusArea === 'file' && !asksQuestion(saveRow)}
                    onFocus={() => setFocusArea('file')} onEditing={setEnvField} />
                ) : ready.byteLength === 0 ? <p className="ql-message">Empty file. Nothing to show.</p> : rendered && page ? (
                  <MarkdownPageView ref={pageView} page={page} path={ready.path} ranges={secretRanges} revealed={revealed} secondsLeft={secondsLeft}
                    matches={shownMatches} current={find.open ? currentMatch : 0} line={file.line} heading={file.heading} topLine={file.topLine} focus={focusArea === 'file'}
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
                      } else if (view && searchMarkRef.current) showFindMatches(view, [searchMarkRef.current], 0, false)
                    }} onFocus={() => setFocusArea('file')} />
                )}
              </>
            ) : unavailable?.reason === 'missing' ? (
              <MissingFile path={file.path} root={root} line={file.line} words={missingWords(file.reference?.base ?? null)} onChooseFolder={chooseFolder} />
            ) : unavailable ? (
              <>
                <PathRow path={file.path} root={root} line={null}
                  eyebrow={unavailable.reason === 'too-large' ? 'Large' : unavailable.reason === 'binary' ? 'Binary' : undefined}
                  facts={unavailable.facts ? (unavailable.reason === 'too-large' ? `${quickLookSize(unavailable.facts.byteLength)} · over 2 MB, not shown`
                    : unavailable.reason === 'binary' ? `${quickLookSize(unavailable.facts.byteLength)} · no text preview` : null) : null}
                  actions={unavailable.facts ? <PathMenu open={menuOpen} sendable={false} onToggle={() => setMenuOpen((value) => !value)} onAction={menuAction} onDismiss={() => setMenuOpen(false)} /> : null} />
                <FileFacts result={unavailable} onFeedback={setFeedback} />
              </>
            ) : <PathRow path={file.path} root={root} line={file.line} facts="Reading…" />
          ) : <p className="ql-empty">{goneNote ?? (root ? 'Choose a file in the tree.' : rootInfo ? '' : 'Reading the project…')}</p>}
          {feedback ? <p className="ql-feedback" aria-live="polite">{feedback}</p> : null}
          {ready && (envRows || configEditing) && (dirty || saveRow) ? (
            <SaveBar path={ready.path} summary={envRows ? envDraftSummary(envRows, envDraft) : configDraft?.summary ?? ''} row={saveRow}
              onSave={saveOrAsk} onSaveInvalid={onSaveBarSave} onDiscard={onSaveBarDiscard} onKeep={keepEditing} onReview={reviewLatest} />
          ) : null}
        </section>
      </div>
      <footer className="ql-hints">
        {footer.map((hint) => <span key={hint.label}>{hint.keys.map((key) => <kbd key={key}>{key}</kbd>)}{hint.label}</span>)}
        <span className="ql-hint-right"><kbd>Hold F8</kbd>Show terminals</span>
      </footer>
    </dialog>
  )
}

function TreeRowView(props: { row: TreeRow; index: number; selected: boolean; open: boolean; dirty?: boolean; onClick(): void }): React.JSX.Element {
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
        {props.dirty ? <span className="ql-dirty" role="img" aria-label="unsaved edits" /> : null}
      </span>
    </div>
  )
}
