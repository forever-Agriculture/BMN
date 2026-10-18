// MODULE: quick-look-env-view.tsx - a .env file as rows of names and masked values: a value is replaced whole by typing or a paste into the focused field, a key is added at the end, and nothing is written before Save (Story 68.1)
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { envFileText, envNameProblem, type EnvModel, type EnvSaved } from './quick-look-env'

type EnvRows = Extract<EnvModel, { status: 'rows' }>

/** His edits, in memory only: new values by the line of the key they replace, and keys added at the end. */
export interface EnvDraft {
  changed: ReadonlyMap<number, string>
  added: ReadonlyArray<{ id: number; name: string; value: string }>
}

export const EMPTY_ENV_DRAFT: EnvDraft = { changed: new Map(), added: [] }

export function envDraftDirty(draft: EnvDraft): boolean {
  return draft.changed.size > 0 || draft.added.length > 0
}

/** What the Save bar says changed: "1 of 6 values changed", and the keys added. */
export function envDraftSummary(model: EnvRows, draft: EnvDraft): string {
  const parts: string[] = []
  if (draft.changed.size > 0 || draft.added.length === 0) parts.push(`${draft.changed.size} of ${model.keys} ${model.keys === 1 ? 'value' : 'values'} changed`)
  if (draft.added.length > 0) parts.push(`${draft.added.length} ${draft.added.length === 1 ? 'key' : 'keys'} added`)
  return parts.join(' · ')
}

/** The file's new text, or why it cannot be written: a new key needs a good name. */
export function envDraftText(text: string, model: EnvRows, draft: EnvDraft): EnvSaved {
  const taken = model.rows.flatMap((row) => (row.kind === 'key' ? [row.name] : []))
  for (const [index, key] of draft.added.entries()) {
    const others = [...taken, ...draft.added.filter((_, at) => at !== index).map((each) => each.name)]
    const problem = envNameProblem(key.name, others)
    if (problem) return { status: 'refused', message: `New key ${index + 1}: ${problem}`, line: null }
  }
  return envFileText(text, model, { changed: draft.changed, added: draft.added.map(({ name, value }) => ({ name, value })) })
}

/**
 * His draft carried onto the file as it is on disk now, after a blocked save: each changed value goes to the key of
 * the same name, and added keys stay added. Null when a key he changed is no longer in the file.
 */
export function rebaseEnvDraft(from: EnvRows, to: EnvRows, draft: EnvDraft): EnvDraft | null {
  const lines = new Map(to.rows.flatMap((row) => (row.kind === 'key' ? [[row.name, row.line] as const] : [])))
  const changed = new Map<number, string>()
  for (const [line, value] of draft.changed) {
    const row = from.rows.find((each) => each.kind === 'key' && each.line === line)
    const target = row?.kind === 'key' ? lines.get(row.name) : undefined
    if (target === undefined) return null
    changed.set(target, value)
  }
  return { changed, added: draft.added }
}

export interface EnvViewHandle {
  focus(): void
  /** A value or name field holds the focus. */
  inField(): boolean
  /** Leaves the field, keeping the draft; the row keeps the focus. */
  leaveField(): void
  /** The row the focus ring is on, for Ctrl+R: a key's line, or a new key's id below zero. */
  selectedRow(): number | null
}

export const PASTE_REFUSED = 'A value is one line; nothing was pasted'
const DOTS = '•'.repeat(12)

const chars = (count: number): string => `${count} ${count === 1 ? 'char' : 'chars'}`

export const EnvView = forwardRef<EnvViewHandle, {
  model: EnvRows
  draft: EnvDraft
  onDraft(next: EnvDraft): void
  /** The row whose value is shown, and the seconds left; one at a time, for ten seconds (67.3's rule). */
  shown: { row: number; secondsLeft: number } | null
  onReveal(row: number): void
  onStatus(text: string): void
  focus: boolean
  onFocus(): void
  /** A value or name field took or left the focus. */
  onEditing(editing: boolean): void
}>(function EnvView(props, ref) {
  const list = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const keyRows = props.model.rows.flatMap((row) => (row.kind === 'key' ? [row] : []))
  const order = [...keyRows.map((row) => row.line), ...props.draft.added.map((each) => -each.id)]
  const [selected, setSelected] = useState<number | null>(order[0] ?? null)
  const [editing, setEditing] = useState<{ row: number; part: 'name' | 'value' } | null>(null)
  const nextId = useRef(1)
  const current = selected !== null && order.includes(selected) ? selected : order[0] ?? null

  useImperativeHandle(ref, () => ({
    focus: () => (editing ? field.current : list.current)?.focus(),
    inField: () => editing !== null,
    leaveField: () => {
      setEditing(null)
      list.current?.focus()
    },
    selectedRow: () => current
  }), [editing, current])

  useEffect(() => {
    if (props.focus && !editing) list.current?.focus()
  }, [props.focus])

  useEffect(() => {
    props.onEditing(editing !== null)
    if (!editing) return
    field.current?.focus()
    field.current?.select()
  }, [editing])

  const draftValue = (row: number): string | undefined => (row >= 0 ? props.draft.changed.get(row) : props.draft.added.find((each) => each.id === -row)?.value)
  const setValue = (row: number, value: string): void => {
    if (row >= 0) props.onDraft({ ...props.draft, changed: new Map(props.draft.changed).set(row, value) })
    else props.onDraft({ ...props.draft, added: props.draft.added.map((each) => (each.id === -row ? { ...each, value } : each)) })
  }
  const setName = (row: number, name: string): void => {
    props.onDraft({ ...props.draft, added: props.draft.added.map((each) => (each.id === -row ? { ...each, name } : each)) })
  }

  const addKey = (): void => {
    const id = nextId.current
    nextId.current += 1
    props.onDraft({ ...props.draft, added: [...props.draft.added, { id, name: '', value: '' }] })
    setSelected(-id)
    setEditing({ row: -id, part: 'name' })
  }

  const onListKey = (event: React.KeyboardEvent): void => {
    if (editing || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (order.length === 0) return
      const at = current === null ? -1 : order.indexOf(current)
      setSelected(order[Math.max(0, Math.min(order.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!)
    } else if (event.key === 'Enter' && current !== null) {
      event.preventDefault()
      const added = current < 0 ? props.draft.added.find((each) => each.id === -current) : undefined
      setEditing({ row: current, part: added && added.name === '' ? 'name' : 'value' })
    }
  }

  const onFieldKey = (event: React.KeyboardEvent<HTMLInputElement>, row: number, part: 'name' | 'value'): void => {
    if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey) return
    event.preventDefault()
    if (part === 'name') setEditing({ row, part: 'value' })
    else {
      setEditing(null)
      list.current?.focus()
    }
  }

  /** A paste replaces the whole value, masked; one with a line break is refused and changes nothing (AC2). */
  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>, row: number): void => {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text/plain')
    if (/[\r\n]/u.test(pasted)) {
      props.onStatus(PASTE_REFUSED)
      return
    }
    setValue(row, pasted)
    props.onStatus('Pasted, masked')
  }

  const valueCell = (row: number, original: string | null): React.JSX.Element => {
    const value = draftValue(row)
    const shown = props.shown?.row === row
    const isEditing = editing?.row === row && editing.part === 'value'
    if (isEditing) {
      return (
        <input ref={field} className="ql-env-field" type={shown ? 'text' : 'password'} value={value ?? ''} spellCheck={false} autoComplete="off"
          aria-label="New value, hidden" placeholder={original === null ? 'Value' : `${DOTS} type or paste to replace`}
          onChange={(event) => setValue(row, event.target.value)} onPaste={(event) => onPaste(event, row)} onKeyDown={(event) => onFieldKey(event, row, 'value')} />
      )
    }
    const text = value ?? original ?? ''
    if (shown) return <span className="ql-env-shown">{text}</span>
    return <span className="ql-secret" role="img" aria-label={`hidden value, ${chars(text.length)}`}>{DOTS}</span>
  }

  const statusCell = (row: number, original: string | null): React.JSX.Element => {
    const value = draftValue(row)
    const shown = props.shown?.row === row
    return (
      <span className="ql-env-state">
        {shown ? <span>Shown · hides in {props.shown!.secondsLeft} s</span>
          : value !== undefined ? <span><b className="ql-unsaved">Unsaved</b> · {chars(value.length)}</span>
            : <span>{chars((original ?? '').length)}</span>}
        <button type="button" className="ql-eye" aria-label="Show this value for 10 seconds" aria-pressed={shown} tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()} onClick={() => props.onReveal(row)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
      </span>
    )
  }

  const taken = keyRows.map((row) => row.name)
  return (
    <div className="ql-env" onFocus={props.onFocus}>
      <div ref={list} className="ql-env-rows" role="listbox" aria-label=".env keys" tabIndex={0} onKeyDown={onListKey}
        aria-activedescendant={current === null ? undefined : `ql-env-${current < 0 ? `n${-current}` : current}`}>
        {props.model.rows.map((row) => row.kind === 'comment' ? <div key={`c${row.line}`} className="ql-env-comment">{row.text}</div>
          : row.kind === 'blank' ? <div key={`b${row.line}`} className="ql-env-blank" />
            : (
              <div key={row.line} id={`ql-env-${row.line}`} role="option" aria-selected={current === row.line}
                className={`ql-env-row${current === row.line ? ' sel' : ''}${props.draft.changed.has(row.line) ? ' changed' : ''}`}
                onMouseDown={() => setSelected(row.line)} onDoubleClick={() => setEditing({ row: row.line, part: 'value' })}>
                <span className="ql-env-name">{row.name}</span>
                <span className="ql-env-value">{valueCell(row.line, row.value)}</span>
                {statusCell(row.line, row.value)}
              </div>
            ))}
        {props.draft.added.map((each) => {
          const row = -each.id
          const problem = each.name === '' ? null : envNameProblem(each.name, [...taken, ...props.draft.added.filter((other) => other.id !== each.id).map((other) => other.name)])
          return (
            <div key={`n${each.id}`} id={`ql-env-n${each.id}`} role="option" aria-selected={current === row}
              className={`ql-env-row added${current === row ? ' sel' : ''}`} onMouseDown={() => setSelected(row)}>
              <span className="ql-env-name">
                {editing?.row === row && editing.part === 'name'
                  ? <input ref={field} className="ql-env-field ql-env-name-in" value={each.name} spellCheck={false} autoComplete="off" aria-label="New key name" placeholder="NEW_KEY"
                    onChange={(event) => setName(row, event.target.value)} onKeyDown={(event) => onFieldKey(event, row, 'name')} />
                  : each.name || <span className="ql-env-unnamed">unnamed</span>}
              </span>
              <span className="ql-env-value">{valueCell(row, null)}</span>
              {problem ? <span className="ql-env-state ql-env-problem">{problem}</span> : statusCell(row, null)}
            </div>
          )
        })}
      </div>
      <div className="ql-env-add">
        <button type="button" className="ql-plate" onClick={addKey}>+ Add key</button>
        <span className="ql-env-hint">A paste goes into the selected field, never into a terminal.</span>
      </div>
    </div>
  )
})
