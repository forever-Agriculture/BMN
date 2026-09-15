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
    }
  | 'separator'

export interface MenuAnchor {
  element: HTMLElement
  label: string
  entries: MenuEntry[]
}

/** Arrow keys move between items, Escape closes and returns focus to the anchor, outside clicks close. */
export function PopupMenu(props: { anchor: MenuAnchor; onClose(): void }): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useLayoutEffect(() => {
    const rect = props.anchor.element.getBoundingClientRect()
    const width = menu.current?.offsetWidth ?? 200
    const height = menu.current?.offsetHeight ?? 200
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = rect.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below
    setPosition({ top, left })
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [props.anchor])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !props.anchor.element.contains(target)) onClose.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [props.anchor])

  const items = (): HTMLButtonElement[] =>
    [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  return (
    <div
      ref={menu}
      className="popup-menu"
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
          props.onClose()
        }
      }}
    >
      {props.anchor.entries.map((entry, index) => entry === 'separator'
        ? <hr key={`separator-${index}`} />
        : (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              className={entry.danger ? 'danger' : undefined}
              disabled={entry.disabled}
              title={entry.title}
              onClick={() => {
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
