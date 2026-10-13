// MODULE: turn-changes-dialog.tsx - "Turn changes…": a session's kept turns, one opened to its labels and files, and a file's difference in place under its row (Story 69.5)
import { useEffect, useRef, useState } from 'react'
import {
  TURN_LIST_LIMIT,
  TURN_SHOWN_LIMITS,
  type TurnDetail,
  type TurnFileView,
  type TurnSessionView,
  type TurnShownDifference,
  type TurnShownHunk,
  type TurnShownLine,
  type TurnSummary
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Dialog } from './dialog'
import { guardPath } from './session-guard-card'
import {
  MINUS,
  turnBinarySizes,
  turnEndWord,
  turnFileLines,
  turnHeading,
  turnHunkRange,
  turnLabelShown,
  turnLineNumber,
  turnMoreWords,
  turnRecordingWords,
  turnResult,
  turnAppName,
  turnWhen
} from './turn-changes-presentation'
import './turn-changes.css'

export const TURNS_HEADING = `The latest ${TURN_LIST_LIMIT} turns still kept`
export const TURN_GONE_WORDS = 'No longer kept'
export const TURN_REMOVAL_PENDING_WORDS = 'Removal pending'
export const TURN_SECRET_CHANGED_WORDS = 'Secret value changed'
export const TURN_CUT_WORDS = `cut at ${TURN_SHOWN_LIMITS.lineCharacters.toLocaleString('en-US')} characters`

/** What stands under an opened file's row. */
export type TurnFileBody =
  | { state: 'reading' }
  | { state: 'shown'; difference: TurnShownDifference }
  | { state: 'unavailable'; words: string }

/** The place of the opened turn: still being read, read, or no longer kept. */
export type TurnOpened =
  | { state: 'reading'; turnId: string }
  | { state: 'read'; turnId: string; detail: TurnDetail }
  | { state: 'gone'; turnId: string }

/** A turn's totals with their mark, or the wording that says why there are none. Gold is only ever on the mark and the wording. */
function TurnResult(props: { turn: TurnSummary; whole?: boolean }): React.JSX.Element | null {
  const result = turnResult(props.turn)
  if (result.totals === null) return result.wording === null ? null : <span className="caveat">{result.wording}</span>
  // An opened turn says why in the whole wording; a row of the list has room for the mark.
  const caveat = props.whole ? result.wording : result.mark
  return (
    <>
      <span className="totals">{result.totals.files} <span className="ad">{result.totals.added}</span> <span className="rm">{result.totals.removed}</span></span>
      {caveat === null ? null : <span className="caveat">{caveat}</span>}
    </>
  )
}

/** One shown line's text: what may be read, copied and found. Where a secret value stood there is only the plate. */
function lineText(line: TurnShownLine): React.ReactNode {
  if (line.masks.length === 0) return line.text
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [start, end] of line.masks) {
    if (start > at) parts.push(line.text.slice(at, start))
    parts.push(<span key={start} className="msk">{line.text.slice(start, end)}</span>)
    at = end
  }
  if (at < line.text.length) parts.push(line.text.slice(at))
  return parts
}

const LINE_CLASS = { ' ': 'ctx', '-': 'del', '+': 'add' } as const
const LINE_SIGN = { ' ': '', '-': MINUS, '+': '+' } as const

function HunkLines(props: { hunk: TurnShownHunk }): React.JSX.Element {
  return (
    <>
      <div className="dl hunk">
        <span className="no" /><span className="no" /><span className="sg" />
        <span className="tx">{turnHunkRange(props.hunk)}{props.hunk.secret ? <span className="hunk-note">{TURN_SECRET_CHANGED_WORDS}</span> : null}</span>
      </div>
      {props.hunk.lines.map((line, index) => line.kind === '\\' ? (
        <div key={index} className="dl hunk">
          <span className="no" /><span className="no" /><span className="sg" /><span className="tx">No line ending at the end of the file</span>
        </div>
      ) : (
        <div key={index} className={`dl ${LINE_CLASS[line.kind]}${line.cut ? ' cutline' : ''}`}>
          <span className="no">{turnLineNumber(line.a)}</span><span className="no">{turnLineNumber(line.b)}</span>
          <span className="sg">{LINE_SIGN[line.kind]}</span>
          <span className="tx">{lineText(line)}{line.cut ? <span className="cut-mark">{TURN_CUT_WORDS}</span> : null}</span>
        </div>
      ))}
    </>
  )
}

/**
 * One file's difference: unified, three lines of context, a sign at the start of a line and neutral tones. Every
 * number and count was taken from the original texts and every secret value was replaced by the plate before the
 * difference left BMN's worker thread, so nothing here can reveal one: not a copy, not Find, not a name read aloud.
 */
export function TurnDifference(props: { path: string; body: TurnFileBody }): React.JSX.Element {
  const body = props.body
  if (body.state === 'reading') return <p className="file-body"><small>Reading the difference…</small></p>
  if (body.state === 'unavailable') return <p className="file-body"><span>{body.words}</span></p>
  const difference = body.difference
  if (difference.state === 'binary') {
    return <p className="file-body"><span>Binary file changed</span><small>{turnBinarySizes(difference.sizeBefore, difference.sizeAfter)}</small></p>
  }
  const more = turnMoreWords(difference.more)
  const widest = difference.hunks.reduce((most, hunk) => Math.max(most, hunk.aStart + hunk.aLines, hunk.bStart + hunk.bLines), 0)
  return (
    <div className="turn-diff" role="region" aria-label={`Difference of ${props.path}`} tabIndex={0}
      style={{ '--no': `${Math.max(6, turnLineNumber(widest).length + 2)}ch` } as React.CSSProperties}>
      <div className="turn-diff-lines">
        {difference.hunks.length === 0 && more === null ? <div className="dl more"><span className="no" /><span className="no" /><span className="sg" /><span className="tx">No line differs</span></div> : null}
        {difference.hunks.map((hunk, index) => <HunkLines key={index} hunk={hunk} />)}
        {more === null ? null : <div className="dl more"><span className="no" /><span className="no" /><span className="sg" /><span className="tx">{more}</span></div>}
      </div>
    </div>
  )
}

function FileRow(props: { file: TurnFileView; body: TurnFileBody | undefined; onToggle(): void }): React.JSX.Element {
  const { file, body } = props
  const lines = turnFileLines(file)
  const open = body !== undefined
  return (
    <li className={open ? 'pinned' : undefined}>
      <button type="button" className="file-row" disabled={!file.opens} aria-expanded={file.opens ? open : undefined} onClick={props.onToggle}>
        <span className="chev" aria-hidden="true">{file.opens ? '›' : ''}</span>
        <span className="path" title={file.path}><bdi>{file.path}</bdi></span>
        <span className="state">{file.note === null ? file.state : `${file.state} · ${file.note}`}</span>
        <span className="lines">{lines === null ? null : <><span className="ad">{lines.added}</span><span className="rm">{lines.removed}</span></>}</span>
      </button>
      {open ? <TurnDifference path={file.path} body={body} /> : null}
    </li>
  )
}

function OpenedTurn(props: {
  opened: TurnOpened
  bodies: ReadonlyMap<string, TurnFileBody>
  home: string | null
  now: number
  onToggleFile(path: string): void
}): React.JSX.Element {
  if (props.opened.state === 'gone') return <p className="turn-gone" role="status">{TURN_GONE_WORDS}</p>
  if (props.opened.state === 'reading') return <p className="turn-gone">Reading the turn…</p>
  const detail = props.opened.detail
  const root = detail.workTree === null ? null : guardPath(detail.workTree, props.home)
  const count = detail.files.length + detail.moreFiles
  // The labels that are this turn's own stand first; the three every turn carries follow.
  const own = (label: string): boolean => !/^(Two scans of |Covered: |Anything written after )/.test(label)
  const labels = [...detail.labels.filter(own), ...detail.labels.filter((label) => !own(label))]
  return (
    <>
      <header className="turn-head">
        <h3>{turnHeading(detail.turn, props.now)}</h3>
        <TurnResult turn={detail.turn} whole />
      </header>
      <p className="dialog-note">
        What differs between two scans of {root === null ? 'the work tree' : <span className="mono" title={detail.workTree ?? undefined}>{root}</span>}. It is not a list of what the agent did.
      </p>
      {labels.length === 0 ? null : (
        <ul className="turn-labels" aria-label="What this turn's numbers cover">
          {labels.map((label) => <li key={label} className={own(label) ? 'own' : undefined}>{turnLabelShown(label, detail.workTree, root)}</li>)}
        </ul>
      )}
      {detail.unavailable !== null ? <p className="turn-gone">{detail.unavailable}</p> : detail.turn.totals === null ? null : (
        <>
          <span className="eyebrow">Files · {count.toLocaleString('en-US')}</span>
          {detail.files.length === 0 ? <p className="turn-gone">No file differs</p> : (
            <ul className="turn-files" aria-label="Files">
              {detail.files.map((file) => (
                <FileRow key={file.path} file={file} body={props.bodies.get(file.path)} onToggle={() => props.onToggleFile(file.path)} />
              ))}
            </ul>
          )}
          {detail.moreFiles > 0 ? <p className="dialog-note">{detail.moreFiles.toLocaleString('en-US')} more files not listed</p> : null}
        </>
      )}
    </>
  )
}

/**
 * The dialog's whole content, drawn from what it is given: the list beside the opened turn and, in a dialog under
 * 900 px wide, the opened turn in place of the list (the stylesheet decides which; both are always here).
 */
export function TurnChangesView(props: {
  view: TurnSessionView | null
  /** Null until the first read has answered. */
  turns: readonly TurnSummary[] | null
  opened: TurnOpened | null
  /** The opened files of the opened turn, by path. */
  bodies: ReadonlyMap<string, TurnFileBody>
  home: string | null
  now: number
  onOpenTurn(turnId: string): void
  onBack(): void
  onToggleFile(path: string): void
}): React.JSX.Element {
  const recording = turnRecordingWords(props.view)
  const state = props.view?.removalPending ? `${recording} · ${TURN_REMOVAL_PENDING_WORDS}` : recording
  return (
    <div className="turns-layout" data-opened={props.opened !== null || undefined}>
      <section className="turns-side" aria-label="Turns">
        <h3>{TURNS_HEADING}</h3>
        <p className="turn-recording" role="status">{state}</p>
        {props.turns === null ? <p className="turn-gone">Reading the turns…</p> : props.turns.length === 0 ? <p className="turn-gone">No turns yet</p> : (
          <ul className="turn-list">
            {props.turns.map((turn) => (
              <li key={turn.turnId}>
                <button type="button" className="turn-row" data-turn={turn.turnId} aria-current={props.opened?.turnId === turn.turnId ? 'true' : undefined}
                  onClick={() => props.onOpenTurn(turn.turnId)}>
                  <span className="l1">
                    <span className="when">{turnWhen(turn.startedAt, props.now)}</span>
                    <span className="app">{turnAppName(turn.app)}</span>
                    <span className="end">{turnEndWord(turn)}</span>
                  </span>
                  <span className="l2"><TurnResult turn={turn} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="turn-detail" aria-label="Opened turn">
        <div className="back-row">
          <button type="button" className="ghost" onClick={props.onBack}>‹ Back</button>
          <span className="turn-recording">{state}</span>
        </div>
        {props.opened === null
          ? <p className="turn-gone">{props.turns !== null && props.turns.length > 0 ? 'Open a turn to read what differs' : ''}</p>
          : <OpenedTurn opened={props.opened} bodies={props.bodies} home={props.home} now={props.now} onToggleFile={props.onToggleFile} />}
      </section>
    </div>
  )
}

/** A dialog this wide shows the list beside the opened turn, so the latest turn may open with it. */
const BESIDE_MIN_WINDOW = 948

/**
 * The session's kept turns. It reads through the window's own channels only, starts nothing, types nothing into a
 * terminal and changes no pane's size: it is a modal dialog for the reason the progress detail is one. Whenever
 * turns change anywhere it reads its list again; a turn that went while it was open says "No longer kept".
 */
export function TurnChangesDialog(props: {
  sessionId: string
  sessionName: string
  /** Where recording stands now, from the shell's own list. */
  view: TurnSessionView | null
  /** Rises whenever a turn was stored, removed or recording changed. */
  revision: number
  home: string | null
  now: number
  onClose(): void
  onFailure(message: string): void
}): React.JSX.Element {
  const [turns, setTurns] = useState<TurnSummary[] | null>(null)
  const [opened, setOpened] = useState<TurnOpened | null>(null)
  const [bodies, setBodies] = useState<ReadonlyMap<string, TurnFileBody>>(new Map())
  const openedRef = useRef(opened)
  openedRef.current = opened
  const onFailure = useRef(props.onFailure)
  onFailure.current = props.onFailure
  /** What the opened turn's detail was read for: when its row changes, the detail is read again. */
  const readFor = useRef<string | null>(null)
  const first = useRef(true)
  const { sessionId } = props

  const stamp = (turn: TurnSummary): string => JSON.stringify([turn.state, turn.end, turn.endedAt, turn.totalsState, turn.totals, turn.wording])

  const readTurn = (turnId: string, turn: TurnSummary | null, quiet: boolean): void => {
    readFor.current = turn === null ? null : stamp(turn)
    if (!quiet) {
      setOpened({ state: 'reading', turnId })
      setBodies(new Map())
    }
    void window.aiTerminal.readTurn(sessionId, turnId).then((answer) => {
      if (openedRef.current?.turnId !== turnId) return
      if (!answer.kept) {
        setBodies(new Map())
        setOpened({ state: 'gone', turnId })
        return
      }
      // A turn that was compared again may list other files: what was open under the old ones goes.
      if (quiet) setBodies(new Map())
      setOpened({ state: 'read', turnId, detail: answer.detail })
    }).catch((error: unknown) => {
      if (openedRef.current?.turnId === turnId) setOpened(null)
      onFailure.current(failureDetail(error, 'The turn could not be read'))
    })
  }

  useEffect(() => {
    let current = true
    void window.aiTerminal.listTurns(sessionId).then((list) => {
      if (!current) return
      setTurns(list)
      const now = openedRef.current
      if (first.current) {
        first.current = false
        const latest = list.find((turn) => turn.state !== 'open')
        if (latest && window.innerWidth >= BESIDE_MIN_WINDOW) readTurn(latest.turnId, latest, false)
        return
      }
      if (now === null || now.state === 'gone') return
      const row = list.find((turn) => turn.turnId === now.turnId)
      if (!row) {
        // Removed while it was open: its row is gone and its place says so.
        setBodies(new Map())
        setOpened({ state: 'gone', turnId: now.turnId })
      } else if (now.state === 'read' && readFor.current !== stamp(row)) {
        readTurn(row.turnId, row, true)
      }
    }).catch((error: unknown) => {
      if (current) onFailure.current(failureDetail(error, 'The turns could not be read'))
    })
    return () => { current = false }
  }, [sessionId, props.revision])

  const toggleFile = (path: string): void => {
    const turn = openedRef.current
    if (turn?.state !== 'read') return
    if (bodies.has(path)) {
      setBodies((current) => new Map([...current].filter(([key]) => key !== path)))
      return
    }
    const turnId = turn.turnId
    const put = (body: TurnFileBody): void => setBodies((current) => {
      // An answer for a file the owner closed again, or of another turn, is dropped.
      if (openedRef.current?.turnId !== turnId || (body.state !== 'reading' && !current.has(path))) return current
      return new Map(current).set(path, body)
    })
    put({ state: 'reading' })
    void window.aiTerminal.readTurnDifference(sessionId, turnId, path).then((answer) => {
      if (openedRef.current?.turnId !== turnId) return
      if (!answer.kept) {
        setBodies(new Map())
        setOpened({ state: 'gone', turnId })
      } else if ('difference' in answer) put({ state: 'shown', difference: answer.difference })
      else put({ state: 'unavailable', words: answer.unavailable })
    }).catch((error: unknown) => {
      setBodies((current) => new Map([...current].filter(([key]) => key !== path)))
      onFailure.current(failureDetail(error, 'The difference could not be read'))
    })
  }

  return (
    <Dialog label={`Turn changes — ${props.sessionName}`} onClose={props.onClose} className="turn-changes-dialog">
      <TurnChangesView view={props.view} turns={turns} opened={opened} bodies={bodies} home={props.home} now={props.now}
        onOpenTurn={(turnId) => {
          if (opened?.turnId === turnId && opened.state !== 'gone') return
          readTurn(turnId, turns?.find((turn) => turn.turnId === turnId) ?? null, false)
        }}
        onBack={() => { setOpened(null); setBodies(new Map()) }}
        onToggleFile={toggleFile} />
    </Dialog>
  )
}
