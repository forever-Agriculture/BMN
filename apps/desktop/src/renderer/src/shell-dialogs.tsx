// MODULE: shell-dialogs.tsx - small shell dialogs: workspace name, conversation reference and destructive confirmation
import { useState } from 'react'
import { Dialog } from './dialog'

export function WorkspaceDialog(props: {
  mode: 'create' | 'rename'
  initialName: string
  onSubmit(values: { name: string; directory: string }): Promise<void>
  onClose(): void
}): React.JSX.Element {
  const [name, setName] = useState(props.initialName)
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const label = props.mode === 'create' ? 'New workspace' : 'Rename workspace'
  return (
    <Dialog label={label} onClose={props.onClose}>
      <form className="dialog-form" onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) {
          setError('Enter a workspace name.')
          return
        }
        setBusy(true)
        setError(undefined)
        props.onSubmit({ name: name.trim(), directory: directory.trim() })
          .then(() => props.onClose())
          .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setBusy(false))
      }}>
        <label>Name<input autoFocus aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        {props.mode === 'create' ? (
          <label>Default directory (optional)
            <input aria-label="Optional workspace directory" className="mono" placeholder="/home/…/project" value={directory} onChange={(event) => setDirectory(event.target.value)} />
          </label>
        ) : null}
        {error ? <span className="inline-error" role="alert">{error}</span> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{props.mode === 'create' ? 'Create workspace' : 'Rename'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function ConversationReferenceDialog(props: {
  sessionName: string
  onSubmit(reference: string): Promise<void>
  onClose(): void
}): React.JSX.Element {
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string>()
  return (
    <Dialog label="Locate chat" onClose={props.onClose}>
      <form className="dialog-form" onSubmit={(event) => {
        event.preventDefault()
        if (!reference.trim()) {
          setError('Enter the conversation reference.')
          return
        }
        props.onSubmit(reference.trim())
          .then(() => props.onClose())
          .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      }}>
        <p>Bind <strong>{props.sessionName}</strong> to an existing agent conversation. Resume uses this reference.</p>
        <label>Conversation reference<input autoFocus aria-label="Conversation reference" className="mono" value={reference} onChange={(event) => setReference(event.target.value)} /></label>
        {error ? <span className="inline-error" role="alert">{error}</span> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="primary">Bind conversation</button>
        </div>
      </form>
    </Dialog>
  )
}

export function ConfirmDialog(props: {
  label: string
  message: string
  confirmLabel: string
  onConfirm(): void
  onClose(): void
}): React.JSX.Element {
  return (
    <Dialog label={props.label} onClose={props.onClose}>
      <p>{props.message}</p>
      <div className="dialog-actions">
        <button type="button" className="ghost" autoFocus onClick={props.onClose}>Cancel</button>
        <button type="button" className="danger" onClick={() => {
          props.onClose()
          props.onConfirm()
        }}>{props.confirmLabel}</button>
      </div>
    </Dialog>
  )
}
