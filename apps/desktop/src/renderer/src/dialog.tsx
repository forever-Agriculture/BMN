// MODULE: dialog.tsx - labeled modal dialog with native focus containment and focus restore
import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A modal built on the native `<dialog>`: `showModal()` contains focus, Escape closes through the
 * `cancel` event, and the element that opened the dialog gets focus back on close.
 */
export function Dialog(props: {
  label: string
  onClose(): void
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const element = useRef<HTMLDialogElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useEffect(() => {
    const dialog = element.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // showModal() focuses the header close button; React's autoFocus does not survive that, so move
    // focus to the first control in the body.
    dialog.querySelector<HTMLElement>('.app-dialog-body :is(input, select, textarea, button):not([disabled])')?.focus()
    const cancel = (event: Event): void => {
      event.preventDefault()
      onClose.current()
    }
    dialog.addEventListener('cancel', cancel)
    return () => {
      dialog.removeEventListener('cancel', cancel)
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return (
    <dialog ref={element} className={`app-dialog${props.className ? ` ${props.className}` : ''}`} aria-label={props.label}>
      <header className="app-dialog-heading">
        <h2>{props.label}</h2>
        <button type="button" className="icon-button" aria-label={`Close ${props.label}`} onClick={() => props.onClose()}>×</button>
      </header>
      <div className="app-dialog-body">{props.children}</div>
    </dialog>
  )
}
