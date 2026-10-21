// MODULE: popup-menu.tsx - keyboard-operable action menu anchored to the control that opened it
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuEntry =
  | {
      label: string
      onSelect(): void
      disabled?: boolean | undefined
      title?: string | undefined
      danger?: boolean | undefined
      shortcut?: string | undefined
      /** A switch inside the menu: set, the item is a checkbox that carries a check while it is on. */
      checked?: boolean | undefined
    }
  /** One exclusive choice inside the menu: a named group whose options carry the current selection. */
  | {
      group: string
      selected: string
      options: ReadonlyArray<{ value: string; label: string; mark?: React.JSX.Element | undefined; description?: string | undefined; disabled?: boolean | undefined }>
      onChoose(value: string): void
    }
  | 'separator'

export interface MenuAnchor {
  element: HTMLElement
  label: string
  entries: MenuEntry[]
  /** Select fields start on their current row and keep the list within the field's column. */
  select?: boolean | undefined
}

/** Find the next matching row; repeated single letters cycle, longer prefixes keep the matching current row. */
export function typeAheadIndex(labels: string[], current: number, buffer: string): number {
  const text = buffer.toLocaleLowerCase()
  const repeated = text.length > 1 && [...text].every((letter) => letter === text[0])
  const prefix = repeated ? text[0]! : text
  for (let offset = prefix.length > 1 ? 0 : 1; offset <= labels.length; offset += 1) {
    const index = (current + offset + labels.length) % labels.length
    if (labels[index]?.toLocaleLowerCase().startsWith(prefix)) return index
  }
  return -1
}

/**
 * Arrow keys move between items, outside clicks close, and Escape *or* choosing an item returns focus
 * to the anchor. Selecting must return it too: React commits the close and the action together, so an
 * action that opens a dialog would otherwise find the chosen item already gone and capture `body` as
 * the element to restore focus to when it closes.
 */
export function PopupMenu(props: { anchor: MenuAnchor; onClose(): void }): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  const typed = useRef({ text: '', at: 0 })

  useLayoutEffect(() => {
    const rect = props.anchor.element.getBoundingClientRect()
    if (props.anchor.select && menu.current) {
      const columnRight = props.anchor.element.parentElement?.getBoundingClientRect().right ?? window.innerWidth - 8
      const ceiling = Math.max(0, Math.min(columnRight, window.innerWidth - 8) - rect.left)
      menu.current.style.minWidth = `${Math.min(rect.width, ceiling)}px`
      menu.current.style.maxWidth = `${ceiling}px`
    }
    const width = menu.current?.offsetWidth ?? 200
    const height = menu.current?.offsetHeight ?? 200
    const left = Math.max(8, Math.min(props.anchor.select ? rect.left : rect.right - width, window.innerWidth - width - 8))
    const below = rect.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below
    setPosition({ top, left })
    const chosen = props.anchor.select
      ? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
      : null
    const first = menu.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
    )
    ;(chosen ?? first)?.focus()
    chosen?.scrollIntoView({ block: 'nearest' })
  }, [props.anchor])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !props.anchor.element.contains(target)) {
        if (props.anchor.select) props.anchor.element.focus()
        onClose.current()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [props.anchor])

  const items = (): HTMLButtonElement[] =>
    [...(menu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
    ) ?? [])]

  return (
    <div
      ref={menu}
      className={`popup-menu${props.anchor.select ? ' select-list' : ''}`}
      role="menu"
      aria-label={props.anchor.label}
      style={{ top: position.top, left: position.left }}
      onKeyDown={(event) => {
        const list = items()
        const index = list.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
          props.anchor.element.focus()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          list[(index + step + list.length) % list.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          ;(event.key === 'Home' ? list[0] : list.at(-1))?.focus()
        } else if (event.key === 'Tab') {
          if (props.anchor.select) {
            event.preventDefault()
            const scope = props.anchor.element.closest('dialog') ?? document.body
            const controls = [...scope.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')]
              .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') &&
                !menu.current?.contains(element) && element.getClientRects().length > 0)
            const anchorIndex = controls.indexOf(props.anchor.element)
            const next = (anchorIndex + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
            ;(controls[next] ?? props.anchor.element).focus()
          }
          props.onClose()
        } else if (props.anchor.select && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const now = performance.now()
          typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + event.key, at: now }
          const match = typeAheadIndex(list.map((item) => item.dataset.label ?? item.textContent ?? ''), index, typed.current.text)
          list[match]?.focus()
        }
        if (props.anchor.select) (document.activeElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
      }}
    >
      {props.anchor.entries.map((entry, index) => entry === 'separator'
        ? <hr key={`separator-${index}`} />
        : 'group' in entry
          ? (
              <div key={entry.group} className="menu-group" role="group" aria-label={entry.group}>
                {props.anchor.select ? null : <span className="menu-group-label" aria-hidden="true">{entry.group}</span>}
                {entry.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === entry.selected}
                    disabled={option.disabled}
                    data-value={option.value}
                    data-label={option.label}
                    onClick={() => {
                      props.anchor.element.focus()
                      props.onClose()
                      entry.onChoose(option.value)
                    }}
                  >
                    {props.anchor.select ? <span className="select-row">
                      <span>{option.mark}{option.label}</span>
                      {option.description ? <span className="select-row-description">{option.description}</span> : null}
                    </span> : <span>{option.mark}{option.label}</span>}
                  </button>
                ))}
              </div>
            )
          : (
            <button
              key={entry.label}
              type="button"
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={entry.checked}
              className={entry.danger ? 'danger' : undefined}
              disabled={entry.disabled}
              title={entry.title}
              onClick={() => {
                props.anchor.element.focus()
                props.onClose()
                entry.onSelect()
              }}
            >
              <span>{entry.label}</span>
              {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
            </button>
          ))}
    </div>
  )
}
