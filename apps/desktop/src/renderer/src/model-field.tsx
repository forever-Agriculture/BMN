// MODULE: model-field.tsx - Epic 60.5: the Model field on Team › an agent and New agent: any text, with names from the team and from open sessions offered under it
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { pickerKey, type ModelSuggestionGroup, type PickerState } from './model-suggestions'

/** The panel under the field: each name once, under the first place BMN knows it from. */
export function ModelList(props: { id: string; groups: readonly ModelSuggestionGroup[]; active: number; onPick(name: string): void; onActive(index: number): void }): React.JSX.Element {
  let index = -1
  return (
    <div className="model-list" id={props.id} role="listbox" aria-label="Model suggestions">
      {props.groups.map((group) => (
        <div key={group.source} role="group" aria-label={group.label}>
          <div className="model-group" aria-hidden="true">{group.label}</div>
          {group.rows.map((row) => {
            index += 1
            const at = index
            return (
              // The field keeps the focus; a press on a row must not take it, or the panel would close before the pick.
              <div key={row.name} id={`${props.id}-${at}`} role="option" aria-selected={at === props.active} className={at === props.active ? 'model-option active' : 'model-option'}
                onMouseDown={(event) => { event.preventDefault(); props.onPick(row.name) }} onMouseMove={() => { if (at !== props.active) props.onActive(at) }}>
                <span className="mono">{row.name}</span>
                <small>{row.context}</small>
              </div>
            )
          })}
        </div>
      ))}
      {props.groups.length === 0 ? <div className="model-none">No suggestion matches. The name stays as you typed it.</div> : null}
    </div>
  )
}

/**
 * A field that takes any model name and offers the ones BMN already knows for this app. Opening it
 * reads only what the window holds: no app is started and nothing is asked over the network.
 * `suggest(null)` lists every name, `suggest(text)` the ones that text narrows to.
 */
export function ModelField(props: {
  value: string
  placeholder?: string
  /** Where the current name came from, with what BMN cannot promise about it. */
  hint: string
  suggest(query: string | null): ModelSuggestionGroup[]
  onChange(next: string): void
}): React.JSX.Element {
  const listId = useId()
  const hintId = useId()
  const [state, setState] = useState<PickerState>({ open: false, active: -1 })
  // Opened by a click or an arrow, the panel lists everything; typing narrows it.
  const [narrowing, setNarrowing] = useState(false)
  const any = props.suggest(null).length > 0
  const groups = state.open ? props.suggest(narrowing ? props.value : null) : []
  const rows = groups.flatMap((group) => group.rows)
  // The row the arrows reach stays in view inside the panel.
  useEffect(() => {
    if (state.open && state.active >= 0) document.getElementById(`${listId}-${state.active}`)?.scrollIntoView({ block: 'nearest' })
  }, [listId, state])
  const pick = (name: string): void => {
    props.onChange(name)
    setState({ open: false, active: -1 })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const count = state.open ? rows.length : props.suggest(null).flatMap((group) => group.rows).length
    const next = pickerKey(state, event.key, count)
    if (!next.handled) return
    event.preventDefault()
    // Escape closes the panel only; the dialog around it stays open.
    event.stopPropagation()
    if (!state.open && next.state.open) setNarrowing(false)
    setState(next.state)
    const picked = next.pick === null ? undefined : rows[next.pick]
    if (picked) props.onChange(picked.name)
  }
  return (
    <div className="model-field">
      <input className="field mono" role="combobox" aria-label="Model" aria-autocomplete="list" aria-expanded={state.open} aria-controls={listId} aria-describedby={hintId}
        aria-activedescendant={state.open && state.active >= 0 ? `${listId}-${state.active}` : undefined} autoComplete="off" spellCheck={false} maxLength={128}
        placeholder={props.placeholder} value={props.value}
        onChange={(event) => {
          props.onChange(event.currentTarget.value)
          setNarrowing(true)
          setState({ open: any, active: -1 })
        }}
        onClick={() => { if (!state.open && any) { setNarrowing(false); setState({ open: true, active: -1 }) } }}
        onBlur={() => setState({ open: false, active: -1 })}
        onKeyDown={onKeyDown} />
      {state.open ? <ModelList id={listId} groups={groups} active={state.active} onPick={pick} onActive={(active) => setState({ open: true, active })} /> : null}
      <p className="preferences-help" id={hintId} aria-live="polite">{props.hint}</p>
    </div>
  )
}
