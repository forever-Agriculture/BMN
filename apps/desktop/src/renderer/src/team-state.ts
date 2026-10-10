// MODULE: team-state.ts - Epic 60.5: the Team and Rules › Health pages' shared staged edits, review and approval, held once by the Preferences dialog
import { useCallback, useEffect, useState } from 'react'
import type {
  AgentsApprovalRequest,
  AgentsOutcome,
  AgentsPreview,
  AgentsShownRevision,
  AgentsSnapshot,
  RosterDataShape,
  RosterIssueShape
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { changedSections, groupDifferences, sameData, type DiffGroup, type RosterSection } from './roster-staging'

const PREVIEW_DELAY_MS = 250
/** How long a message that something worked stays; one offering Undo stays longer, and that undo remains under Rules › Editor › Earlier versions. */
const NOTICE_MS = 5_000
const UNDO_NOTICE_MS = 12_000

export interface TeamNotice {
  ok: boolean
  text: string
  issues?: RosterIssueShape[]
  /** The rules transaction an approval ran, for Undo. */
  undo?: string
}

/** An approving control waiting for the owner to confirm it, with what it would approve. */
export interface TeamConfirmation {
  request: AgentsApprovalRequest
  title: string
  action: string
  preview: AgentsPreview
}

export interface TeamState {
  snapshot: AgentsSnapshot | null
  loadError: string | null
  /** The team file's data, the staged data over it, and the approved data. */
  base: RosterDataShape | null
  data: RosterDataShape | null
  approved: RosterDataShape | null
  hasStaged: boolean
  /** The staged data as an approval would publish it; null while it is being computed. */
  preview: AgentsPreview | null
  /** What the team file holds that was never approved: changed outside BMN. */
  outside: { groups: DiffGroup[]; general: string[] }
  /** Sections carrying an unapproved difference, staged or outside. */
  changed: Set<RosterSection>
  busy: boolean
  notice: TeamNotice | null
  confirmation: TeamConfirmation | null
  /** True when anything on the Team pages waits for the owner. */
  needsOwner: boolean
  stage(next: RosterDataShape): void
  discard(): void
  reload(): Promise<void>
  setNotice(notice: TeamNotice | null): void
  /** Asks to approve; shows the confirmation when the approval also updates rules files or `always` is set, otherwise commits. */
  requestApproval(request: AgentsApprovalRequest, words: { title: string; action: string }, always?: boolean): Promise<void>
  commit(): Promise<void>
  cancelConfirmation(): void
  revert(scope: string[] | null): Promise<void>
  saveNotes(agent: string, text: string): Promise<void>
  /** Notes written for an agent the team file does not hold yet; saved once the agent is approved into it. */
  pendingNotes: Readonly<Record<string, string>>
  setPendingNote(agent: string, text: string): void
  undoRulesUpdate(transaction: string): Promise<void>
}

/** "Rules updated in 2 apps", with what was left for Install when a file changed meanwhile. */
export function rulesUpdateWords(update: NonNullable<Extract<AgentsOutcome, { ok: true }>['rulesUpdate']>): string {
  const written = update.written.length
  const parts = [written > 0 ? `Rules updated in ${written} app${written === 1 ? '' : 's'}` : 'No rules file was updated']
  if (update.skipped.length > 0) parts.push(`${update.skipped.length} changed meanwhile and wait${update.skipped.length === 1 ? 's' : ''} for Install`)
  if (update.failed !== undefined) parts.push(`stopped: ${update.failed}`)
  return parts.join(' · ')
}

export function useTeamState(): TeamState {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [staged, setStaged] = useState<RosterDataShape | null>(null)
  // The preview remembers the staged data it was computed for, so the footer never offers a stale diff.
  const [computed, setComputed] = useState<{ data: RosterDataShape; result: AgentsPreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TeamNotice | null>(null)
  const [confirmation, setConfirmation] = useState<TeamConfirmation | null>(null)
  const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({})

  const reload = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await window.aiTerminal.agentsSnapshot())
      setLoadError(null)
    } catch (error) {
      setLoadError(failureDetail(error, 'Could not read the team file'))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // A message that something worked leaves by itself; a refusal waits to be dismissed.
  useEffect(() => {
    if (notice === null || !notice.ok) return
    const timer = setTimeout(() => setNotice(null), notice.undo === undefined ? NOTICE_MS : UNDO_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // An edit made outside BMN shows when the window comes back. Never under staged edits or an open
  // confirmation: those are approved against the file as it was shown, and a reload would hide a conflict.
  const idle = staged === null && confirmation === null && !busy
  useEffect(() => {
    if (!idle) return
    const onFocus = (): void => { void reload() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [idle, reload])

  const base = snapshot?.file.data ?? null
  const approved = snapshot?.approved?.data ?? null
  const data = staged ?? base
  const shown: AgentsShownRevision | null = snapshot?.file.hash
    ? { generation: snapshot.approved?.generation ?? null, fileHash: snapshot.file.hash, link: snapshot.file.link } : null
  const preview = computed !== null && computed.data === staged ? computed.result : null

  useEffect(() => {
    if (staged === null) {
      setComputed(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.aiTerminal.previewAgents({ kind: 'staged', data: staged })
        .then((result) => { if (!cancelled) setComputed({ data: staged, result }) })
        .catch((error: unknown) => { if (!cancelled) setNotice({ ok: false, text: failureDetail(error, 'Could not preview the change') }) })
    }, PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [staged])

  const outsideDiffs = snapshot?.approved ? snapshot.differences ?? [] : []
  const outside = groupDifferences(outsideDiffs, base, approved, snapshot?.approved ? snapshot.consequences : [])
  const changed = changedSections(staged !== null ? preview?.differences ?? [] : outsideDiffs)

  function discard(): void {
    setStaged(null)
    setComputed(null)
    setConfirmation(null)
    setPendingNotes({})
  }

  function stage(next: RosterDataShape): void {
    setNotice(null)
    setConfirmation(null)
    if (outsideDiffs.length > 0) {
      // An approval takes the whole team, so edits made here never ride on changes nobody reviewed.
      setNotice({ ok: false, text: 'Keep or revert the changes made outside BMN first.' })
      return
    }
    setStaged(sameData(next, base) ? null : next)
  }

  async function settle(run: () => Promise<AgentsOutcome>, failure: string): Promise<AgentsOutcome | null> {
    setBusy(true)
    setNotice(null)
    try {
      const result = await run()
      setSnapshot(result.snapshot)
      if (result.ok) {
        discard()
        const update = result.rulesUpdate
        setNotice({
          ok: update?.failed === undefined, text: update === undefined ? result.message : `${result.message} · ${rulesUpdateWords(update)}`,
          ...(update?.transaction ? { undo: update.transaction } : {})
        })
      } else if (result.code === 'REVISION_CONFLICT') {
        discard()
        setNotice({ ok: false, text: 'The team file changed meanwhile. Reloaded without saving.' })
      } else {
        setConfirmation(null)
        setNotice({ ok: false, text: result.message, ...(result.errors ? { issues: result.errors } : {}) })
      }
      return result
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, failure) })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function run(request: AgentsApprovalRequest, teamUpdate: AgentsPreview['teamUpdate']): Promise<void> {
    if (shown === null) return
    const bindings = teamUpdate.length === 0 ? undefined : teamUpdate.map((target) => ({ harness: target.harness, binding: target.binding }))
    const notes = Object.entries(pendingNotes).filter(([, text]) => text.trim() !== '')
    const result = await settle(() => request.kind === 'staged' ? window.aiTerminal.saveAgents(shown, request.data, bindings)
      : request.kind === 'restore' ? window.aiTerminal.restoreAgents(shown, request.number, bindings)
        : window.aiTerminal.approveAgents(shown, request.kind === 'sections' ? request.scope : undefined, bindings), 'The team could not be changed')
    if (request.kind !== 'staged' || result?.ok !== true) return
    // The new agents are in the file now, so their notes have a section to live in.
    let latest = result.snapshot
    for (const [agent, text] of notes) {
      if (latest.file.hash === null) break
      try {
        const saved = await window.aiTerminal.saveAgentNotes({ generation: latest.approved?.generation ?? null, fileHash: latest.file.hash, link: latest.file.link }, agent, text)
        latest = saved.snapshot
      } catch {
        break
      }
    }
    setSnapshot(latest)
  }

  async function requestApproval(request: AgentsApprovalRequest, words: { title: string; action: string }, always = false): Promise<void> {
    if (shown === null || busy) return
    setBusy(true)
    setNotice(null)
    let result: AgentsPreview
    try {
      result = request.kind === 'staged' && preview !== null ? preview : await window.aiTerminal.previewAgents(request)
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'Could not preview the change') })
      setBusy(false)
      return
    }
    setBusy(false)
    if (!result.valid) {
      setNotice({ ok: false, text: 'This would not be a valid team; nothing was changed.', issues: result.errors })
      return
    }
    if (always || result.teamUpdate.length > 0) setConfirmation({ request, preview: result, ...words })
    else await run(request, [])
  }

  async function commit(): Promise<void> {
    if (confirmation === null) return
    await run(confirmation.request, confirmation.preview.teamUpdate)
  }

  async function revert(scope: string[] | null): Promise<void> {
    if (shown === null) return
    await settle(() => window.aiTerminal.revertAgents(shown, scope), 'The team file could not be put back')
  }

  async function saveNotes(agent: string, text: string): Promise<void> {
    if (shown === null) return
    setBusy(true)
    try {
      const result = await window.aiTerminal.saveAgentNotes(shown, agent, text)
      setSnapshot(result.snapshot)
      if (!result.ok) setNotice({ ok: false, text: result.code === 'REVISION_CONFLICT' ? 'The team file changed meanwhile. Reloaded without saving.' : result.message })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'The notes could not be saved') })
    } finally {
      setBusy(false)
    }
  }

  async function undoRulesUpdate(transaction: string): Promise<void> {
    setBusy(true)
    try {
      const plan = await window.aiTerminal.planRulesRestore(transaction)
      if (!plan.ok || plan.planHash === null) {
        setNotice({ ok: false, text: plan.message ?? 'The rules files could not be put back' })
        return
      }
      const result = await window.aiTerminal.restoreRules(transaction, plan.planHash)
      setNotice({ ok: result.ok, text: result.message })
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'The rules files could not be put back') })
    } finally {
      setBusy(false)
    }
  }

  return {
    snapshot, loadError, base, data, approved, hasStaged: staged !== null, preview, outside, changed, busy, notice, confirmation,
    needsOwner: staged !== null || outsideDiffs.length > 0 || (snapshot !== null && snapshot.file.exists && snapshot.approved === null),
    stage, discard, reload, setNotice, requestApproval, commit, cancelConfirmation: () => setConfirmation(null), revert, saveNotes, undoRulesUpdate,
    pendingNotes, setPendingNote: (agent, text) => setPendingNotes((notes) => ({ ...notes, [agent]: text }))
  }
}
