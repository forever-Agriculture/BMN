// MODULE: select-menu.tsx - BMN's select (docs/design.md S1-S4): a plate opener showing the value and a muted chevron that opens popup-menu's list
import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { PopupMenu, type MenuAnchor } from './popup-menu'
import './select-menu.css'

export interface SelectOption<V extends string = string> {
  value: V
  label: string
  /** A muted second line, cut at its tail (a session's harness and path). */
  description?: string | undefined
  disabled?: boolean | undefined
}

/** The keys that open a closed, focused select (S3): Enter, Space, ArrowDown, ArrowUp, and Alt+ArrowDown. */
export function opensSelect(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp'
}

/**
 * The opener is a button with aria-haspopup="menu" and aria-expanded; its list is popup-menu's `menu` of
 * `menuitemradio` rows, so the roles stay the ones every other BMN menu uses. Its name is the field's name followed by
 * the value it shows. Choosing a row calls `onChange` with that row's value, only when it differs from the current one,
 * as a native select's change event does. Disabled, it cannot be focused or opened by mouse or key.
 */
export function SelectMenu<V extends string>(props: {
  value: V
  options: ReadonlyArray<SelectOption<V>>
  onChange(value: V): void
  disabled?: boolean | undefined
  id?: string | undefined
  className?: string | undefined
  'aria-label'?: string | undefined
  /** The id of the element naming the field (its label); the value shown is added to the name after it. */
  'aria-labelledby'?: string | undefined
  ref?: Ref<HTMLButtonElement> | undefined
}): React.JSX.Element {
  const opener = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  const current = useRef(props.value)
  current.current = props.value
  /** A choice can disable the field while it saves; focus that the browser then drops comes back once it is enabled. */
  const refocus = useRef(false)
  const ids = useId()
  const nameId = `${ids}name`
  const valueId = `${ids}value`
  const name = props['aria-label'] ?? ''
  const chosen = props.options.find((option) => option.value === props.value)

  const setOpener = (element: HTMLButtonElement | null): void => {
    opener.current = element
    const ref = props.ref
    if (typeof ref === 'function') ref(element)
    else if (ref) ref.current = element
  }

  const open = (): void => {
    const element = opener.current
    if (!element || props.disabled) return
    setAnchor({
      element,
      label: name || document.getElementById(props['aria-labelledby'] ?? '')?.textContent?.trim() || 'Choices',
      select: true,
      entries: [{
        group: name || 'Choices',
        selected: props.value,
        options: props.options,
        onChoose: (value) => {
          if (value === current.current) return
          refocus.current = true
          onChange.current(value as V)
        }
      }]
    })
  }

  // A field disabled while open (a save began elsewhere) closes its list.
  useEffect(() => {
    if (props.disabled) {
      setAnchor(null)
      return
    }
    if (!refocus.current) return
    refocus.current = false
    if (!document.activeElement || document.activeElement === document.body) opener.current?.focus()
  }, [props.disabled])

  return (
    <>
      <button
        ref={setOpener}
        type="button"
        id={props.id}
        className={`select-opener${props.className ? ` ${props.className}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-labelledby={`${props['aria-labelledby'] ?? nameId} ${valueId}`}
        data-label={props['aria-label']}
        data-value={props.value}
        data-empty={props.value === '' || undefined}
        disabled={props.disabled}
        onClick={() => {
          if (anchor) setAnchor(null)
          else open()
        }}
        onKeyDown={(event) => {
          if (anchor || !opensSelect(event.key)) return
          event.preventDefault()
          open()
        }}
      >
        {props['aria-labelledby'] ? null : <span id={nameId} hidden>{name}</span>}
        <span id={valueId} className="select-value">{chosen?.label ?? ''}</span>
        <svg className="select-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {/* The list goes beside the opener's dialog or window content, never inside the field's <label>, so a click on it
          is never the label's click; inside a modal dialog it must stay in the dialog to be reachable. */}
      {anchor ? createPortal(<PopupMenu anchor={anchor} onClose={() => setAnchor(null)} />,
        anchor.element.closest('dialog') ?? anchor.element.closest('.shell-window') ?? document.body) : null}
    </>
  )
}
