// MODULE: quick-look.tsx - Quick look: one sheet over the window to walk the project and read a file (Epic 67)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  quickLookCount,
  quickLookFileType,
  quickLookHomePath,
  quickLookName,
  quickLookPathParts,
  quickLookSize,
  type QuickLookReadResult,
  type QuickLookRootResult,
  type QuickLookSource
} from '@bmn/protocol'
import { createCodeView } from './quick-look-code'
import { treeKey, treeRows, type TreeListing, type TreeRow } from './quick-look-tree'
import { quickLookFooter, type QuickLookFocus } from './quick-look-keys'
import './quick-look.css'

/** Below this sheet width the tree starts folded, so that the file keeps 80 columns. */
export const QUICK_LOOK_TREE_FOLD_WIDTH = 940

export interface QuickLookRequest {
  source: QuickLookSource
  /** A file to show at once, at its place. */
  open?: { path: string; line: number | null; column: number | null } | null
}

interface OpenFile {
  path: string
  line: number | null
  column: number | null
  result: QuickLookReadResult | null
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
function PathRow(props: { path: string; root: string | null; line: number | null; facts: string | null; eyebrow?: string | undefined }): React.JSX.Element {
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
  line: number | null
  column: number | null
  focus: boolean
  onView(view: EditorView | null): void
  onFocus(): void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const onView = useRef(props.onView)
  onView.current = props.onView
  const focus = useRef(props.focus)
  focus.current = props.focus
  useEffect(() => {
    if (!host.current) return
    const type = quickLookFileType(props.result.path)
    const view = createCodeView(host.current, {
      content: props.result.content, language: type.language, line: props.line, column: props.column,
      label: `${quickLookName(props.result.path)}, read only`
    })
    onView.current(view)
    if (focus.current) view.focus()
    return () => {
      onView.current(null)
      view.destroy()
    }
  }, [props.result, props.line, props.column])
  return <div className="ql-code" ref={host} onFocus={props.onFocus} />
}

export function QuickLook(props: {
  request: QuickLookRequest
  onClose(): void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
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
  const source = props.request.source
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  const root = rootInfo?.status === 'ready' ? (atGitRoot && rootInfo.gitRoot ? rootInfo.gitRoot : rootInfo.sessionFolder) : null
  const rows = useMemo(() => (root ? treeRows(root, listings, expanded) : []), [root, listings, expanded])

  const list = useCallback((folder: string): void => {
    setListings((current) => new Map(current).set(folder, current.get(folder) ?? { entries: null, more: 0, unavailable: null }))
    void window.aiTerminal.listQuickLookFolder({ ...source, folder })
      .then((result) => setListings((current) => new Map(current).set(folder, result.status === 'ready'
        ? { entries: result.entries, more: result.more, unavailable: null }
        : { entries: [], more: 0, unavailable: result.message })))
      .catch((error: unknown) => setListings((current) => new Map(current).set(folder, { entries: [], more: 0, unavailable: failureText(error, 'This folder is unavailable') })))
  }, [source])

  const open = useCallback((path: string, line: number | null = null, column: number | null = null, focus = true): void => {
    setFile({ path, line, column, result: null })
    setFeedback('')
    if (focus) setFocusArea('file')
    void window.aiTerminal.readQuickLookFile({ ...source, path })
      .then((result) => setFile((current) => (current?.path === path && current.line === line && current.column === column ? { ...current, result } : current)))
      .catch((error: unknown) => setFile((current) => current?.path === path ? {
        ...current, result: { status: 'unavailable', path, canonicalPath: null, reason: 'unreadable', message: failureText(error, 'The file could not be read.'), facts: null }
      } : current))
  }, [source])

  // The sheet is a native modal: the window dims behind it, focus stays inside, and no layout changes, so no
  // terminal is resized. Esc arrives as the dialog's cancel event and closes the innermost thing first.
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    const cancel = (event: Event): void => {
      event.preventDefault()
      cancelRef.current()
    }
    element.addEventListener('cancel', cancel)
    return () => {
      element.removeEventListener('cancel', cancel)
      if (element.open) element.close()
    }
  }, [])

  useEffect(() => {
    let current = true
    void window.aiTerminal.quickLookRoot(source)
      .then((result) => { if (current) setRootInfo(result) })
      .catch((error: unknown) => { if (current) setRootError(failureText(error, 'This folder is unavailable')) })
    if (props.request.open) open(props.request.open.path, props.request.open.line, props.request.open.column)
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!root) return
    setExpanded(new Set())
    setSelected(null)
    setTyped('')
    list(root)
  }, [root])

  // Focus follows the area the keys belong to: the open file, or the tree when none is open.
  useEffect(() => {
    if (focusArea === 'tree' && !folded) tree.current?.focus()
    else if (focusArea === 'file') codeView.current?.focus()
    else field.current?.focus()
  }, [focusArea, folded])

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

  const expand = (path: string): void => {
    setExpanded((current) => new Set(current).add(path))
    if (!listings.has(path)) list(path)
  }
  const collapse = (path: string): void => setExpanded((current) => {
    const next = new Set(current)
    next.delete(path)
    return next
  })

  const cancelRef = useRef<() => void>(() => undefined)
  cancelRef.current = () => {
    if (typed) {
      setTyped('')
      return
    }
    onClose.current()
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

  const onSheetKey = (event: React.KeyboardEvent): void => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyE') {
      event.preventDefault()
      onClose.current()
      return
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyB') {
      event.preventDefault()
      setFolded((value) => {
        if (!value && focusArea === 'tree') setFocusArea(file ? 'file' : 'field')
        return !value
      })
      return
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      const order: QuickLookFocus[] = [...(folded ? [] : ['tree' as const]), ...(file?.result?.status === 'ready' ? ['file' as const] : [])]
      if (order.length === 0) return
      const index = order.indexOf(focusArea)
      setFocusArea(order[(index + (event.shiftKey ? order.length - 1 : 1)) % order.length]!)
    }
  }

  const rootName = root ? quickLookName(root) || root : null
  const home = rootInfo?.home ?? null
  const ready = file?.result?.status === 'ready' ? file.result : null
  const unavailable = file?.result?.status === 'unavailable' ? file.result : null
  const type = file ? quickLookFileType(file.path) : null
  const footer = quickLookFooter({ focus: focusArea, fileOpen: !!ready, typed: typed.length > 0, folded })

  return (
    <dialog ref={dialog} className="app-dialog quick-look" aria-label="Quick look" onKeyDown={onSheetKey}>
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
                  facts={[type?.label, `${quickLookCount(ready.lineCount)} ${ready.lineCount === 1 ? 'line' : 'lines'}`, quickLookSize(ready.byteLength)].join(' · ')} />
                {ready.canonicalPath !== ready.path ? <p className="ql-note">Through symlink · {ready.canonicalPath}</p> : null}
                {ready.byteLength === 0 ? <p className="ql-message">Empty file. Nothing to show.</p> : (
                  <CodeView result={ready} line={file.line} column={file.column} focus={focusArea === 'file'}
                    onView={(view) => { codeView.current = view }} onFocus={() => setFocusArea('file')} />
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
          ) : <p className="ql-empty">{root ? 'Choose a file in the tree.' : rootInfo ? '' : 'Reading the project…'}</p>}
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
