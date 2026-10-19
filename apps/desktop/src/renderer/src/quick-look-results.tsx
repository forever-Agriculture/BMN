// MODULE: quick-look-results.tsx - the left column while the top field searches: files by name, or matching lines grouped by file with what the search covered (Story 67.5)
import { useEffect, useRef } from 'react'
import { quickLookCount, type QuickLookContentsResult, type QuickLookSearchResult } from '@bmn/protocol'
import { contentsHeader, filesHeader, resultFolder, rowPieces, type QuickLookSearchMode } from './quick-look-search'

interface SearchView {
  mode: QuickLookSearchMode
  /** Why there is nothing to search yet ("Type at least 2 characters"), or null. */
  waiting: string | null
  searching: boolean
  result: QuickLookSearchResult | null
  failure: string | null
}

function Chevron(): React.JSX.Element {
  return (
    <svg className="ql-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The results of the top field; `picked` is the file (by name) or the match (by contents) ↑ ↓ are on. */
export function SearchResults(props: {
  search: SearchView
  root: string | null
  picked: number
  /** The results answer an earlier text of the field: dimmed, and none of them opens. */
  stale: boolean
  onOpen(index: number): void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-picked="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.picked, props.search.result])
  const { search } = props
  const result = search.result
  const status = search.failure ?? search.waiting ?? (search.searching && !result ? 'Searching… · Esc stops it' : null)
  return (
    <div className={`ql-results${props.stale ? ' ql-stale' : ''}`} aria-label={search.mode === 'files' ? 'Files found' : 'Matching lines'} aria-busy={props.stale}>
      {status ? <p className="ql-results-status" role="status">{status}</p> : null}
      {!status && result?.mode === 'files' ? (
        <>
          <div className="ql-results-head" role="status"><span>{search.searching || props.stale ? 'Searching… · Esc stops it' : filesHeader(result)}</span></div>
          <div ref={list} className="ql-results-list" role="listbox" aria-label="Files">
            {result.files.map((file, index) => (
              <div key={file.path} className={`ql-rf${index === props.picked ? ' sel' : ''}`} role="option" aria-selected={index === props.picked}
                data-picked={index === props.picked} onClick={() => props.onOpen(index)}>
                <span className="ql-rf-name">{file.name}</span>
                <span className="ql-rf-dir"><bdi>{resultFolder(file.path, props.root)}</bdi></span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {!status && result?.mode === 'contents' ? (
        <ContentsResults result={result} searching={search.searching || props.stale} root={props.root} picked={props.picked} listRef={list} onOpen={props.onOpen} />
      ) : null}
    </div>
  )
}

function ContentsResults(props: {
  result: QuickLookContentsResult
  searching: boolean
  root: string | null
  picked: number
  listRef: React.RefObject<HTMLDivElement | null>
  onOpen(index: number): void
}): React.JSX.Element {
  const header = contentsHeader(props.result)
  let index = -1
  return (
    <>
      <div className="ql-results-head" role="status">
        <span>{props.searching ? 'Searching… · Esc stops it' : props.result.unavailable ?? header.count}</span>
        {props.result.unavailable ? null : <span className="ql-results-read">{header.read}</span>}
      </div>
      {header.notes.map((note) => <p key={note} className="ql-results-note">{note}</p>)}
      <div ref={props.listRef} className="ql-results-list" role="listbox" aria-label="Matching lines">
        {props.result.files.map((file) => {
          const folder = resultFolder(file.path, props.root)
          const name = file.path.slice(file.path.lastIndexOf('/') + 1)
          return (
            <div key={file.path} className="ql-rg" role="group" aria-label={`${name}, ${file.lines.length} ${file.lines.length === 1 ? 'match' : 'matches'}`}>
              <div className="ql-rg-head">
                <span className="ql-tr-chev"><Chevron /></span>
                <span className="ql-rg-name">{name}</span>
                <span className="ql-rg-dir" title={folder}><bdi>{folder}</bdi></span>
                <span className="ql-rg-count">{quickLookCount(file.lines.length)}</span>
              </div>
              {file.lines.map((line) => {
                index += 1
                const at = index
                const pieces = rowPieces(line)
                return (
                  <div key={`${line.line}:${line.column}`} className={`ql-rl${at === props.picked ? ' sel' : ''}`} role="option" aria-selected={at === props.picked}
                    data-picked={at === props.picked} onClick={() => props.onOpen(at)}>
                    <span className="ql-rl-no">{line.line}</span>
                    <span className="ql-rl-text">{pieces.before}<mark>{pieces.match}</mark>{pieces.after}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
