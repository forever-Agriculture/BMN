import { useEffect, useRef, useState } from 'react'
import type { LaunchSetEntry, LaunchSetRecord, LaunchTemplateRecord, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Dialog } from './dialog'
import {
  entryForm, exactCommand, launchSetParams, matchingLiveCommands, seededEntry,
  type LaunchSetEntryForm
} from './launch-set-editor'
import { RepositoryIdentityView, identityChanged, useRepositoryIdentity } from './repository-identity'

type StartResult = Awaited<ReturnType<Window['aiTerminal']['startLaunchSet']>>
type Mode = 'manage' | 'edit' | 'preview' | 'result'

export function LaunchSetsDialog({
  workspace, templates, sessions, liveSessionIds, initialMode, onClose, onStarted, onOpenSession
}: {
  workspace: WorkspaceRecord
  templates: readonly LaunchTemplateRecord[]
  sessions: readonly SessionRecord[]
  liveSessionIds: ReadonlySet<string>
  initialMode: 'manage' | 'launch'
  onClose(): void
  onStarted(result: StartResult): void
  onOpenSession(sessionId: string): void
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('manage')
  const [sets, setSets] = useState<LaunchSetRecord[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editRevision, setEditRevision] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [forms, setForms] = useState<LaunchSetEntryForm[]>([])
  const [seedTemplateId, setSeedTemplateId] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [directory, setDirectory] = useState(workspace.defaultCwd ?? '')
  const [result, setResult] = useState<StartResult | null>(null)
  const [duplicates, setDuplicates] = useState<{ key: string; names: string[]; unavailable: boolean } | null>(null)
  const selected = sets.find((set) => set.setId === selectedId)
  const previewKey = `${selected?.setId ?? ''}:${selected?.revision ?? ''}:${directory}`
  const repository = useRepositoryIdentity(mode === 'preview' && directory ? directory : null, previewKey)
  const actionKey = useRef(crypto.randomUUID())
  const actionGeneration = useRef(0)
  const mounted = useRef(true)
  const currentMode = useRef(mode)
  currentMode.current = mode
  const latest = useRef({ selectedId, directory, revision: selected?.revision })
  latest.current = { selectedId, directory, revision: selected?.revision }
  const liveSessions = sessions.filter((session) => liveSessionIds.has(session.sessionId))
  const duplicateKey = JSON.stringify({ previewKey, entries: selected?.entries,
    sessions: liveSessions.map((session) => [session.sessionId, session.cwd, session.executable, session.argv]) })

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; actionGeneration.current += 1 }
  }, [])

  useEffect(() => {
    let active = true
    void window.aiTerminal.listLaunchSets(workspace.workspaceId).then((records) => {
      if (!active) return
      setSets(records)
      setSelectedId(records[0]?.setId ?? '')
      setLoading(false)
      if (initialMode === 'launch' && records.length > 0) setMode('preview')
    }).catch((error: unknown) => {
      if (!active) return
      setMessage(failureDetail(error, 'Launch sets could not be loaded'))
      setLoading(false)
    })
    return () => { active = false }
  }, [workspace.workspaceId, initialMode])

  useEffect(() => { actionKey.current = crypto.randomUUID() }, [previewKey])

  useEffect(() => {
    if (mode !== 'preview' || !selected || !directory) return
    let active = true
    const paths = [directory, ...liveSessions.map((session) => session.cwd)]
    void window.aiTerminal.normalizeLaunchDirectories(paths).then((normalized) => {
      if (!active || normalized.length !== paths.length) return
      const normalizedByPath = new Map(paths.map((path, index) => [path, normalized[index]!]))
      setDuplicates({ key: duplicateKey, unavailable: false,
        names: matchingLiveCommands(directory, selected.entries, liveSessions, liveSessionIds,
          (path) => normalizedByPath.get(path) ?? path) })
    }).catch(() => {
      if (active) setDuplicates({ key: duplicateKey, unavailable: true, names: [] })
    })
    return () => { active = false }
  }, [duplicateKey, directory, mode, selected, sessions, liveSessionIds])

  const replace = (record: LaunchSetRecord): void => {
    setSets((current) => [...current.filter((item) => item.setId !== record.setId), record]
      .sort((a, b) => a.name.localeCompare(b.name)))
    setSelectedId(record.setId)
  }
  const newSet = (): void => {
    setEditId(null)
    setEditRevision(null)
    setName('')
    setForms([{ entryId: crypto.randomUUID(), name: 'Shell', executable: '/bin/bash',
      argvJson: '[]', backgroundChoice: null }])
    setMessage('')
    setMode('edit')
  }
  const editSet = (record: LaunchSetRecord): void => {
    setEditId(record.setId)
    setEditRevision(record.revision)
    setName(record.name)
    setForms(record.entries.map(entryForm))
    setMessage('')
    setMode('edit')
  }
  const updateEntry = (index: number, change: Partial<LaunchSetEntryForm>): void => {
    setForms((current) => current.map((entry, position) => position === index ? { ...entry, ...change } : entry))
  }
  const moveEntry = (index: number, offset: number): void => {
    setForms((current) => {
      const next = [...current]
      const target = index + offset
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
  }
  const save = async (): Promise<void> => {
    setMessage('')
    setBusy(true)
    try {
      const params = launchSetParams(workspace.workspaceId, name, forms)
      const saved = editId && editRevision
        ? await window.aiTerminal.updateLaunchSet({ ...params, setId: editId, expectedRevision: editRevision })
        : await window.aiTerminal.createLaunchSet(params)
      replace(saved)
      setMode('manage')
      setMessage(`Saved ${saved.name}. No sessions were started.`)
    } catch (error) {
      setMessage(failureDetail(error, 'Launch set could not be saved'))
    } finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      await window.aiTerminal.deleteLaunchSet({
        workspaceId: workspace.workspaceId, setId: selected.setId, expectedRevision: selected.revision
      })
      const remaining = sets.filter((item) => item.setId !== selected.setId)
      setSets(remaining)
      setSelectedId(remaining[0]?.setId ?? '')
      setConfirmDelete(false)
      setMessage(`Removed ${selected.name}. Existing sessions and templates are unchanged.`)
    } catch (error) {
      setMessage(failureDetail(error, 'Launch set could not be removed'))
    } finally { setBusy(false) }
  }
  const openPreview = (record: LaunchSetRecord): void => {
    actionGeneration.current += 1
    setSelectedId(record.setId)
    setDirectory(workspace.defaultCwd ?? '')
    actionKey.current = crypto.randomUUID()
    setMessage('')
    setMode('preview')
  }
  const cancelPreview = (): void => {
    actionGeneration.current += 1
    currentMode.current = 'manage'
    setBusy(false)
    setMode('manage')
  }
  const close = (): void => {
    actionGeneration.current += 1
    onClose()
  }
  const start = async (): Promise<void> => {
    if (!selected || !directory || !repository.identity || repository.loading || duplicates?.key !== duplicateKey) return
    const snapshot = { selectedId, directory, revision: selected.revision }
    const action = ++actionGeneration.current
    const isCurrent = (): boolean => mounted.current && currentMode.current === 'preview' &&
      actionGeneration.current === action && latest.current.selectedId === snapshot.selectedId &&
      latest.current.directory === snapshot.directory && latest.current.revision === snapshot.revision
    setBusy(true)
    setMessage('')
    try {
      const current = await window.aiTerminal.getLaunchSet(workspace.workspaceId, selected.setId)
      if (!isCurrent()) return
      if (current.revision !== selected.revision) {
        replace(current)
        setMessage('The set changed. Review its updated commands before starting.')
        return
      }
      const refreshed = await repository.refresh()
      if (!isCurrent()) return
      if (!refreshed) {
        setMessage('The launch details changed. Review them before starting.')
        return
      }
      if (identityChanged(repository.identity, refreshed)) {
        setMessage('Repository identity changed. Review the new value before starting.')
        return
      }
      const started = await window.aiTerminal.startLaunchSet({
        workspaceId: workspace.workspaceId, setId: selected.setId, expectedRevision: selected.revision,
        directory, idempotencyKey: actionKey.current, cols: 80, rows: 24
      })
      if (!isCurrent()) return
      onStarted(started)
      setResult(started)
      setMode('result')
    } catch (error) {
      if (isCurrent()) setMessage(failureDetail(error, 'Launch set could not be started'))
    } finally { if (mounted.current && actionGeneration.current === action) setBusy(false) }
  }
  const duplicateNames = duplicates?.key === duplicateKey ? duplicates.names : []
  const checkingDuplicates = !!selected && !!directory && duplicates?.key !== duplicateKey

  return <Dialog label={`Launch sets in ${workspace.name}`} onClose={close} className="launch-sets-dialog">
    <p>Workspace: <strong>{workspace.name}</strong></p>
    {loading ? <p role="status">Loading saved sets…</p> : null}
    {mode === 'manage' && !loading ? <>
      {sets.length === 0 ? <p>No saved sets yet.</p> : <label>Saved set
        <select aria-label="Saved launch set" value={selectedId} onChange={(event) => {
          setSelectedId(event.target.value)
          setConfirmDelete(false)
        }}>{sets.map((set) => <option key={set.setId} value={set.setId}>{set.name}</option>)}</select>
      </label>}
      {selected ? <ol>{selected.entries.map((entry) => <li key={entry.entryId}>
        {entry.name} <code>{exactCommand(entry.executable, entry.argv)}</code>
      </li>)}</ol> : null}
      <div className="actions">
        <button type="button" onClick={newSet}>New set</button>
        {selected ? <button type="button" onClick={() => editSet(selected)}>Edit set</button> : null}
        {selected ? <button type="button" onClick={() => openPreview(selected)}>Launch set…</button> : null}
        {selected && !confirmDelete ? <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>Delete set…</button> : null}
        {selected && confirmDelete ? <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>Confirm delete</button> : null}
        {confirmDelete ? <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>Keep set</button> : null}
      </div>
    </> : null}
    {mode === 'edit' ? <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>Set name <input aria-label="Set name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      {forms.map((entry, index) => <fieldset key={entry.entryId}>
        <legend>Entry {index + 1}</legend>
        <label>Name <input aria-label={`Entry ${index + 1} name`} value={entry.name}
          onChange={(event) => updateEntry(index, { name: event.target.value })} /></label>
        <label>Executable <input aria-label={`Entry ${index + 1} executable`} value={entry.executable}
          onChange={(event) => updateEntry(index, { executable: event.target.value })} /></label>
        <label>Arguments (JSON array) <textarea aria-label={`Entry ${index + 1} arguments`} value={entry.argvJson}
          onChange={(event) => updateEntry(index, { argvJson: event.target.value })} /></label>
        <label>When windows close <select aria-label={`Entry ${index + 1} background`} value={entry.backgroundChoice ?? ''}
          onChange={(event) => updateEntry(index, {
            backgroundChoice: event.target.value === 'hide' || event.target.value === 'stop'
              ? event.target.value : null
          })}>
          <option value="">Ask</option><option value="hide">Keep running</option><option value="stop">Stop</option>
        </select></label>
        <div className="actions">
          <button type="button" disabled={index === 0} onClick={() => moveEntry(index, -1)}>Move up</button>
          <button type="button" disabled={index === forms.length - 1} onClick={() => moveEntry(index, 1)}>Move down</button>
          <button type="button" disabled={forms.length <= 1} onClick={() => setForms((current) => current.filter((item) => item.entryId !== entry.entryId))}>Remove entry</button>
        </div>
      </fieldset>)}
      <div className="actions">
        <button type="button" disabled={forms.length >= 8} onClick={() => setForms((current) => [...current, {
          entryId: crypto.randomUUID(), name: 'Shell', executable: '/bin/bash', argvJson: '[]', backgroundChoice: null
        }])}>Add entry</button>
        <select aria-label="Copy from template" value={seedTemplateId} disabled={forms.length >= 8}
          onChange={(event) => {
            const template = templates.find((item) => item.templateId === event.target.value)
            if (template && !template.launchDisabledReason) {
              setForms((current) => [...current, seededEntry(template, crypto.randomUUID())])
            }
            setSeedTemplateId('')
          }}><option value="">Copy from template…</option>{templates.map((template) => <option
            key={template.templateId} value={template.templateId} disabled={!!template.launchDisabledReason}
          >{template.name}</option>)}</select>
      </div>
      <div className="actions"><button type="submit" className="primary" disabled={busy}>Save set</button>
        <button type="button" className="ghost" onClick={() => setMode('manage')}>Cancel</button></div>
    </form> : null}
    {mode === 'preview' && selected ? <>
      <h3>{selected.name}</h3>
      <p>{selected.entries.length} fresh sessions in {workspace.name}. Existing sessions stay open.</p>
      <ol>{selected.entries.map((entry: LaunchSetEntry) => <li key={entry.entryId}>
        <strong>{entry.name}</strong> <code>{exactCommand(entry.executable, entry.argv)}</code>
      </li>)}</ol>
      <label>One directory for every entry <input aria-label="Set launch directory" value={directory}
        onChange={(event) => setDirectory(event.target.value)} /></label>
      {directory ? <RepositoryIdentityView directory={directory} identity={repository.identity}
        loading={repository.loading} onRefresh={() => void repository.refresh()} /> :
        <p role="status">Choose a launch directory.</p>}
      {duplicateNames.length > 0 ? <p className="inline-warning" role="status">
        Similar live sessions already use this directory and command: {duplicateNames.join(', ')}. Starting creates new sessions.
      </p> : null}
      {checkingDuplicates ? <p role="status">Checking for matching live sessions…</p> : null}
      {duplicates?.key === duplicateKey && duplicates.unavailable ? <p className="inline-warning" role="status">
        Could not check for matching live sessions. Review existing sessions before starting.
      </p> : null}
      <div className="actions">
        <button type="button" className="primary" disabled={busy || !directory || repository.loading ||
          !repository.identity || checkingDuplicates}
          onClick={() => void start()}>Start {selected.entries.length} new sessions</button>
        <button type="button" className="ghost" onClick={cancelPreview}>Cancel</button>
      </div>
    </> : null}
    {mode === 'result' && result ? <>
      <h3>Launch results</h3>
      <ol>{result.entries.map((entry) => <li key={entry.entryId}>
        {entry.name}: {entry.outcome === 'not-started' ? 'Not started' : entry.outcome === 'failed' ? 'Failed' : 'Started'}
        {entry.error ? ` — ${entry.error}` : null}
        {entry.sessionId ? <button type="button" className="ghost" onClick={() => onOpenSession(entry.sessionId!)}>Open session</button> : null}
      </li>)}</ol>
      <div className="actions"><button type="button" onClick={() => {
        actionKey.current = crypto.randomUUID()
        setResult(null)
        setMode('preview')
      }}>Review a fresh launch</button><button type="button" className="ghost" onClick={close}>Close</button></div>
    </> : null}
    {message ? <p className="inline-error" role="alert">{message}</p> : null}
  </Dialog>
}
