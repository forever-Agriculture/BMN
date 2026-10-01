import { useEffect, useRef, useState } from 'react'
import type { WorkspaceRecord } from '@bmn/protocol'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'

export function WorkspacePinsDialog(props: {
  workspace: WorkspaceRecord
  onUpdated(workspace: WorkspaceRecord): void
  onOpen(path: string): void
  onClose(): void
}): React.JSX.Element {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const pending = useRef(false)
  useEffect(() => () => { mounted.current = false }, [])
  const update = async (paths: string[], added = false): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    const source = props.workspace
    try {
      const result = await window.aiTerminal.updateWorkspace({ workspaceId: source.workspaceId,
        expectedRevision: source.revision, pinnedFilePaths: paths })
      if (!mounted.current || result.workspaceId !== source.workspaceId || result.archivedAt !== null) return
      props.onUpdated(result)
      if (added) setPath('')
    } catch (cause) { if (mounted.current) setError(failureDetail(cause, 'Pins could not be saved. Reopen this workspace and try again.')) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const pins = props.workspace.pinnedFilePaths
  return <Dialog label={`Pinned files — ${props.workspace.name}`} onClose={props.onClose} className="workspace-pins-dialog">
    <p>Relative paths use <code>{props.workspace.defaultCwd ?? 'no default folder; enter an absolute path'}</code>.</p>
    <form onSubmit={event => { event.preventDefault(); if (path.trim()) void update([...pins, path], true) }}>
      <label>Add path <input aria-label="Pinned file path" value={path} maxLength={4096}
        onChange={event => setPath(event.target.value)} disabled={busy || pins.length >= 8} /></label>
      <button type="submit" disabled={busy || pins.length >= 8 || !path.trim()}>Add path</button>
    </form>
    {pins.length === 0 ? <p>No pinned files. Add a path you chose.</p> : <ol>
      {pins.map((pin, index) => <li key={pin}>
        <code>{pin}</code>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => props.onOpen(pin)} aria-label={`Open ${pin}`}>Open</button>
          <button type="button" disabled={busy} onClick={() => void update(pins.filter(value => value !== pin))} aria-label={`Remove ${pin}`}>Remove</button>
          {([-1, 1] as const).map(direction => <button type="button" key={direction}
            disabled={busy || index + direction < 0 || index + direction >= pins.length}
            aria-label={`Move ${pin} ${direction < 0 ? 'up' : 'down'}`} onClick={() => {
              const next = [...pins]; [next[index], next[index + direction]] = [next[index + direction]!, next[index]!]
              void update(next)
            }}>{direction < 0 ? 'Up' : 'Down'}</button>)}
        </div>
      </li>)}
    </ol>}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </Dialog>
}
