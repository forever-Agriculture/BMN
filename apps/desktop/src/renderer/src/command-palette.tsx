// MODULE: command-palette.tsx - searchable app commands, workspaces and sessions with explicit context
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileReferenceSearchResult, SessionRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { sessionProcessLive } from './session-presentation'

export interface PaletteCommand {
  id: string
  group: 'Sessions' | 'Workspaces' | 'Commands' | 'Files'
  label: string
  /** A `status-dot` class for a row that stands for something with a state, so the palette shows the mark too. */
  mark?: string | undefined
  live?: boolean | undefined
  context?: string | undefined
  shortcut?: string | undefined
  disabled?: boolean | undefined
  run(): void
}

export interface PaletteFileSearchSnapshot {
  query: string
  workspaceId: string
  sessionId: string | null
  rootLabel: string
  value: FileReferenceSearchResult
}

/** Directory the utility will address for this selected session. */
export function paletteFileSearchRootLabel(
  session: Pick<SessionRecord, 'cwd' | 'lastProcess'> | undefined,
  startup: { cwd: string; incarnationId: string } | undefined
): string {
  return session && sessionProcessLive(session, startup?.incarnationId)
    ? startup!.cwd : session?.cwd ?? 'unavailable'
}

/** A result belongs to exactly the query and directory that produced it. */
export function matchingPaletteFileSearch(
  snapshot: PaletteFileSearchSnapshot | null,
  address: { query: string; workspaceId: string | undefined; sessionId: string | null; rootLabel: string | undefined }
): FileReferenceSearchResult | null {
  return snapshot && snapshot.query === address.query.trim() && snapshot.workspaceId === address.workspaceId &&
    snapshot.sessionId === address.sessionId && snapshot.rootLabel === address.rootLabel ? snapshot.value : null
}

/** Every query word must appear in the label or context; nothing runs from a partial match without Enter. */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    if (command.disabled) return false
    const haystack = `${command.label} ${command.context ?? ''} ${command.group}`.toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

export function CommandPalette(props: {
  commands: PaletteCommand[]
  onClose(): void
  /** A narrower chooser built on the palette names its own purpose. */
  label?: string
  searchLabel?: string
  placeholder?: string
  fileSearch?: {
    workspaceId: string
    sessionId: string | null
    rootLabel: string
    open(path: string, sessionId: string | null): void
  } | undefined
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ownerId = useRef(crypto.randomUUID())
  const [fileResult, setFileResult] = useState<PaletteFileSearchSnapshot | null>(null)
  const [fileError, setFileError] = useState(false)
  const workspaceId = props.fileSearch?.workspaceId
  const sessionId = props.fileSearch?.sessionId ?? null
  const rootLabel = props.fileSearch?.rootLabel
  useEffect(() => {
    const trimmed = query.trim()
    if (!workspaceId || !trimmed) return
    const requestId = crypto.randomUUID()
    let current = true
    const timer = setTimeout(() => {
      void window.aiTerminal.searchFileReferences({
        ownerId: ownerId.current, requestId, workspaceId, sessionId, query: trimmed
      }).then((value) => {
        if (current && !value.cancelled) {
          setFileResult({ query: trimmed, workspaceId, sessionId, rootLabel: rootLabel!, value })
          setFileError(false)
        }
      }).catch(() => {
        if (current) setFileError(true)
      })
    }, 120)
    return () => {
      current = false
      clearTimeout(timer)
      void window.aiTerminal.cancelFileReferenceSearch(ownerId.current, requestId).catch(() => undefined)
    }
  }, [query, workspaceId, sessionId, rootLabel])
  const matchingFiles = matchingPaletteFileSearch(fileResult, { query, workspaceId, sessionId, rootLabel })
  const results = useMemo(() => [
    ...filterCommands(props.commands, query),
    ...(matchingFiles?.files.map((file, index): PaletteCommand => ({
      id: `file-${index}`,
      group: 'Files', label: file.name, context: file.directory,
      run: () => props.fileSearch?.open(file.path, fileResult?.sessionId ?? null)
    })) ?? [])
  ], [props.commands, query, matchingFiles, props.fileSearch, fileResult])
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))

  const invoke = (command: PaletteCommand | undefined): void => {
    if (!command) return
    props.onClose()
    // Run after the dialog closes so focus restoration never lands on top of the command's own focus.
    setTimeout(() => command.run(), 0)
  }

  let lastGroup = ''
  return (
    <Dialog label={props.label ?? 'Command palette'} className="command-palette" onClose={props.onClose}>
      <input
        autoFocus
        aria-label={props.searchLabel ?? 'Search commands, workspaces, sessions and files'}
        aria-controls="palette-results"
        aria-activedescendant={results[activeIndex] ? `palette-${results[activeIndex].id}` : undefined}
        placeholder={props.placeholder ?? 'Type a command, workspace, session or file'}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setFileResult(null)
          setFileError(false)
          setActive(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActive((activeIndex + step + results.length) % Math.max(1, results.length))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            invoke(results[activeIndex])
          }
        }}
      />
      <ul id="palette-results" className="palette-results" role="listbox" aria-label="Results">
        {results.length === 0 ? <li className="popover-empty">No matching results.</li> : null}
        {results.map((command, index) => {
          const heading = command.group !== lastGroup ? command.group : null
          lastGroup = command.group
          return [
            heading ? <li key={`group-${heading}`} className="group eyebrow" role="presentation">{heading}</li> : null,
            <li
              key={command.id}
              id={`palette-${command.id}`}
              role="option"
              data-group={command.group}
              data-live={command.live === undefined ? undefined : String(command.live)}
              aria-selected={index === activeIndex}
              onMouseMove={() => setActive(index)}
              onClick={() => invoke(command)}
            >
              {command.mark ? <span className={`status-dot ${command.mark}`} aria-hidden="true" /> : null}
              <span className="label">{command.label}</span>
              {command.context ? <span className="context">{command.context}</span> : null}
              {command.shortcut ? <span className="shortcut">{command.shortcut}</span> : null}
            </li>
          ]
        })}
      </ul>
      {props.fileSearch && query.trim() ? (
        <p className="palette-file-status" role="status">
          Files in {matchingFiles?.root ?? props.fileSearch.rootLabel}: {fileError || matchingFiles?.unavailable
            ? 'Directory unavailable.'
            : matchingFiles?.capped
              ? `Showing first ${matchingFiles.files.length} matches; search capped after ${matchingFiles.scanned} entries.`
              : matchingFiles
                ? `${matchingFiles.files.length} found.`
                : 'Searching…'}
        </p>
      ) : null}
    </Dialog>
  )
}
