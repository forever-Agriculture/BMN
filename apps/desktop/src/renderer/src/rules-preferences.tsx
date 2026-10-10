// MODULE: rules-preferences.tsx - Epic 60.6: Preferences › Rules: the master editor with what each app reads, install and earlier versions; Health with each rules file and agent app
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ROSTER_APP_NAMES,
  ROSTER_HARNESSES,
  type AgentAppView,
  type RosterDataShape,
  type RosterHarness,
  type RosterIssueShape,
  type RulesMasterPlan,
  type RulesOutcome,
  type RulesPlan,
  type RulesPlanTarget,
  type RulesProbeView,
  type RulesRenderingKind,
  type RulesRenderingView,
  type RulesRevertPlan,
  type RulesSnapshot,
  type RulesTargetState
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { Segmented } from './history-preferences'
import { Dot } from './roster-marks'
import { acceptVersion, diffBody, diffSummary, revokeVersion, setDestination, undoWords } from './roster-staging'
import { displayPath } from './session-presentation'
import { Issues, PageHead, TargetPath, shortDate } from './team-preferences'
import type { TeamState } from './team-state'

export { diffSummary, undoWords }

export type RulesPage = 'editor' | 'health'

const PLAN_DELAY_MS = 300

/** What Insert adds: a section's two marker lines with the cursor between them, or the Team phrase where the cursor is. */
export const INSERTS: ReadonlyArray<{ id: 'apps' | 'public' | 'team'; label: string; line: string; text: string; caret: number; inline: boolean }> = [
  { id: 'apps', label: 'Section for some apps', line: 'Only the apps you name read it', text: '<!-- bmn:apps claude codex -->\n\n<!-- /bmn:apps -->\n', caret: 31, inline: false },
  { id: 'public', label: 'Public section', line: 'Also given to public-only agents', text: '<!-- bmn:public -->\n\n<!-- /bmn:public -->\n', caret: 20, inline: false },
  { id: 'team', label: 'Team', line: 'Your approved agents, named by app', text: '<!-- bmn:team -->', caret: 17, inline: true }
]

/** The text with `insert` placed at the selection, and where the cursor goes; a section starts on its own line. */
export function insertAt(text: string, start: number, end: number, insert: (typeof INSERTS)[number]): { text: string; caret: number } {
  const before = text.slice(0, start)
  const lead = insert.inline || before === '' || before.endsWith('\n') ? '' : '\n'
  return { text: `${before}${lead}${insert.text}${text.slice(end)}`, caret: start + lead.length + insert.caret }
}

const MARKER = /<!--\s*\/?bmn:[^>]*-->/g

/** A master line split into plain text and markers, so the editor can dim the markers. */
export function markerParts(line: string): { text: string; marker: boolean }[] {
  const parts: { text: string; marker: boolean }[] = []
  let at = 0
  for (const match of line.matchAll(MARKER)) {
    if (match.index > at) parts.push({ text: line.slice(at, match.index), marker: false })
    parts.push({ text: match[0], marker: true })
    at = match.index + match[0].length
  }
  if (at < line.length || parts.length === 0) parts.push({ text: line.slice(at), marker: false })
  return parts
}

export function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export const KIND_WORDS: Readonly<Record<RulesRenderingKind, string>> = { full: 'Full rules', public: 'Public sections only' }

export const STATE_WORDS: Readonly<Record<RulesTargetState, string>> = {
  current: 'Current',
  stale: 'Differs from the rules',
  'edited-outside': 'Edited outside BMN',
  unmanaged: 'Not installed',
  link: 'Link',
  missing: 'Missing',
  unreadable: 'Cannot be read'
}

export const TEST_WORDS: Readonly<Record<NonNullable<RulesProbeView['outcome']>, string>> = {
  pass: 'Passed',
  fail: 'Failed',
  inconclusive: 'Inconclusive',
  unavailable: 'Unavailable'
}

/** The last loading test in words: its result and date, and whether the rules or the app changed since. */
export function testLine(test: RulesProbeView | undefined): string {
  if (!test || test.outcome === null) return 'Never tested'
  return `Test ${TEST_WORDS[test.outcome].toLowerCase()} ${shortDate(test.at)}${test.stale ? ' · stale' : ''}`
}

/** What an install does to one file, in words: what it replaces, then the size of the change. */
export function changeWords(target: Pick<RulesPlanTarget, 'change' | 'diff'>): string {
  const what = target.change === 'link' ? 'Replaces a link'
    : target.change === 'edited-outside' ? 'Replaces an edit made outside BMN'
      : target.change === 'unmanaged' ? 'Replaces a file BMN did not write'
        : target.change === 'missing' ? 'New file' : null
  const size = diffSummary(target.diff)
  return what === null ? size : target.change === 'missing' ? what : `${what} · ${size}`
}

/** Where an app sends data as BMN inspected it, in words. */
export function destinationWords(app: Pick<AgentAppView, 'basis' | 'provider' | 'host'>, providerName: (id: string) => string): string {
  if (app.basis === 'default' && app.provider) return `Sends data to ${providerName(app.provider)}'s own servers`
  if (app.basis === 'explicit' && app.host) return `Sends data to a custom host, ${app.host}`
  return 'Where it sends data is unknown'
}

export const VERSION_WORDS: Readonly<Record<AgentAppView['versionState'], string>> = { tested: 'tested', accepted: 'accepted', new: 'new', unknown: 'not checked' }

/** Installs and saves, newest first, as Earlier versions lists them. */
export type Earlier =
  | { kind: 'install'; id: string; at: string | undefined; title: string; detail: string; usable: boolean }
  | { kind: 'save'; revision: number; at: string; title: string; detail: string; usable: boolean }

export function earlierVersions(snapshot: Pick<RulesSnapshot, 'transactions' | 'history'>): Earlier[] {
  const installs: Earlier[] = snapshot.transactions.map((entry) => ({
    kind: 'install', id: entry.id, at: entry.createdAt, usable: entry.valid && entry.state === 'complete',
    title: !entry.valid ? 'An install that cannot be read' : entry.reason === 'team update' ? 'Team line updated' : 'Installed',
    detail: (entry.targets ?? []).map((harness) => ROSTER_APP_NAMES[harness]).join(', ') + (entry.valid && entry.state !== 'complete' ? ' · did not finish' : '')
  }))
  const saves: Earlier[] = (snapshot.history ?? []).map((entry) => ({
    kind: 'save', revision: entry.revision, at: entry.at, usable: entry.intact, title: entry.intact ? 'Saved' : 'A saved version that cannot be read', detail: kilobytes(entry.bytes)
  }))
  return [...installs, ...saves].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

type Pending =
  | { kind: 'save'; text: string; plan: RulesMasterPlan }
  | { kind: 'install'; plan: RulesPlan }
  | { kind: 'undo'; transaction: string; plan: RulesPlan }
  | { kind: 'restore'; revision: number; plan: RulesRevertPlan }
  | { kind: 'test'; harness: RosterHarness }

export interface RulesState {
  snapshot: RulesSnapshot | null
  loadError: string | null
  draft: string
  dirty: boolean
  /** The unsaved draft as a save would check it; null while clean or being computed. */
  draftPlan: RulesMasterPlan | null
  busy: boolean
  notice: { ok: boolean; text: string } | null
  pending: Pending | null
  setDraft(text: string): void
  setNotice(notice: { ok: boolean; text: string } | null): void
  /** Reads the rules once; later calls are the owner's Check now. */
  ensure(): void
  /** Reads them again if they were read before: an approval changes what each app may read. */
  refresh(): void
  load(): Promise<void>
  beginSave(): Promise<void>
  beginInstall(): Promise<void>
  beginUndo(transaction: string): Promise<void>
  beginRestore(revision: number): Promise<void>
  beginTest(harness: RosterHarness): void
  confirm(): Promise<void>
  cancel(): void
}

/** The Rules pages' state, held once by the Preferences dialog so an unsaved draft survives a look at Health. */
export function useRulesState(): RulesState {
  const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftPlan, setDraftPlan] = useState<RulesMasterPlan | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const asked = useRef(false)

  const adopt = useCallback((next: RulesSnapshot): void => {
    setSnapshot(next)
    setDraft(next.master.text ?? '')
    setDraftPlan(null)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.aiTerminal.rulesSnapshot()
      // Check now never throws away an unsaved draft.
      setSnapshot((current) => {
        setDraft((text) => (current !== null && text !== (current.master.text ?? '') ? text : next.master.text ?? ''))
        return next
      })
      setLoadError(null)
    } catch (error) {
      setLoadError(failureDetail(error, 'Could not read the rules'))
    } finally {
      setBusy(false)
    }
  }, [])

  const ensure = useCallback((): void => {
    if (asked.current) return
    asked.current = true
    void load()
  }, [load])

  const refresh = useCallback((): void => {
    if (asked.current) void load()
  }, [load])

  const saved = snapshot?.master.text ?? ''
  const dirty = snapshot !== null && draft !== saved

  // A dirty draft is checked as a save would check it, and previewed with its own renderings.
  useEffect(() => {
    if (!dirty) {
      setDraftPlan(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.aiTerminal.planRulesMaster(draft)
        .then((plan) => { if (!cancelled) setDraftPlan(plan) })
        .catch(() => { if (!cancelled) setDraftPlan(null) })
    }, PLAN_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draft, dirty])

  async function begin(prepare: () => Promise<Pending | string>): Promise<void> {
    setNotice(null)
    setBusy(true)
    try {
      const next = await prepare()
      if (typeof next === 'string') setNotice({ ok: false, text: next })
      else setPending(next)
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'Could not prepare that') })
    } finally {
      setBusy(false)
    }
  }

  async function confirm(): Promise<void> {
    if (pending === null) return
    let run: () => Promise<RulesOutcome>
    if (pending.kind === 'save') {
      // The text the diff was shown for, never the editor's later state.
      const { text, plan } = pending
      run = () => window.aiTerminal.saveRulesMaster(text, plan.expectedHash, plan.expectedLink)
    } else if (pending.kind === 'install') {
      const { planHash } = pending.plan
      if (planHash === null) return
      run = () => window.aiTerminal.installRules(planHash)
    } else if (pending.kind === 'undo') {
      const { transaction, plan } = pending
      if (plan.planHash === null) return
      const planHash = plan.planHash
      run = () => window.aiTerminal.restoreRules(transaction, planHash)
    } else if (pending.kind === 'restore') {
      const { text, expectedHash, expectedLink } = pending.plan
      if (text === undefined) return
      run = () => window.aiTerminal.saveRulesMaster(text, expectedHash, expectedLink ?? null)
    } else {
      const { harness } = pending
      run = () => window.aiTerminal.probeRules(harness)
    }
    setBusy(true)
    try {
      const outcome = await run()
      adopt(outcome.snapshot)
      setNotice({
        ok: outcome.ok,
        text: outcome.ok ? (pending.kind === 'restore' ? 'Restored · not installed yet' : outcome.message)
          : outcome.code === 'REVISION_CONFLICT' ? 'Something changed since this was shown. Reloaded without writing.' : outcome.message
      })
      setPending(null)
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'That could not be done') })
    } finally {
      setBusy(false)
    }
  }

  return {
    snapshot, loadError, draft, dirty, draftPlan, busy, notice, pending, setDraft, setNotice, ensure, refresh, load,
    beginSave: () => {
      const text = draft
      return begin(async () => ({ kind: 'save', text, plan: await window.aiTerminal.planRulesMaster(text) }))
    },
    beginInstall: () => begin(async () => {
      const plan = await window.aiTerminal.planRulesInstall()
      return plan.ok ? { kind: 'install', plan } : plan.message ?? 'Install cannot run now'
    }),
    beginUndo: (transaction) => begin(async () => {
      const plan = await window.aiTerminal.planRulesRestore(transaction)
      return plan.ok ? { kind: 'undo', transaction, plan } : plan.message ?? 'That install cannot be undone'
    }),
    beginRestore: (revision) => begin(async () => {
      const plan = await window.aiTerminal.planRulesRevertMaster(revision)
      return plan.ok ? { kind: 'restore', revision, plan } : plan.message ?? 'That version cannot be read'
    }),
    beginTest: (harness) => { setNotice(null); setPending({ kind: 'test', harness }) },
    confirm,
    cancel: () => setPending(null)
  }
}

/** A confirmation in place: what would happen, the files or diff it touches, then the one action and Cancel. */
function Sheet(props: { title: string; note?: string | undefined; action: string; ready?: boolean | undefined; busy: boolean; onConfirm(): void; onCancel(): void; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="sheet" role="group" aria-label={props.title}>
      <div className="sheet-head"><b>{props.title}</b>{props.note ? <span className="muted">{props.note}</span> : null}</div>
      {props.children}
      <div className="inline">
        <button type="button" className="primary" disabled={props.busy || props.ready === false} onClick={props.onConfirm}>{props.busy ? 'Working…' : props.action}</button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function Targets(props: { targets: readonly RulesPlanTarget[]; home: string | null; words(target: RulesPlanTarget): string }): React.JSX.Element {
  return (
    <>
      {props.targets.map((target) => (
        <details key={target.path} className="target">
          <summary>
            <span>{ROSTER_APP_NAMES[target.harness]}</span>
            <span className="target-file"><TargetPath target={target} home={props.home} /><span className="muted">{props.words(target)}</span></span>
            <span className="muted">{target.rendering ? KIND_WORDS[target.rendering] : ''}</span>
          </summary>
          <pre className="diff">{diffBody(target.diff) || 'No change.'}</pre>
        </details>
      ))}
    </>
  )
}

function PendingSheet(props: { rules: RulesState }): React.JSX.Element | null {
  const { rules } = props
  const pending = rules.pending
  const home = rules.snapshot?.home ?? null
  if (pending === null) return null
  const common = { busy: rules.busy, onConfirm: () => void rules.confirm(), onCancel: rules.cancel }
  switch (pending.kind) {
    case 'save':
      return (
        <Sheet {...common} title={pending.plan.valid ? `Save the rules · ${diffSummary(pending.plan.diff)}` : 'These rules cannot be saved'} action="Save" ready={pending.plan.valid && pending.plan.diff !== ''}
          note={pending.plan.valid ? 'The text before this save is kept under Earlier versions. Nothing is installed.' : 'An app could not read them as written.'}>
          <Issues issues={pending.plan.errors} />
          {pending.plan.diff ? <pre className="diff">{diffBody(pending.plan.diff)}</pre> : null}
        </Sheet>
      )
    case 'install': {
      const count = pending.plan.targets.length
      return (
        <Sheet {...common} title={count === 0 ? 'Every app already has the current rules' : `Install to ${count} agent app${count === 1 ? '' : 's'}`} action="Install"
          ready={count > 0 && pending.plan.planHash !== null} note={count === 0 ? undefined : 'Undo install, under Earlier versions, puts the files back.'}>
          <Targets targets={pending.plan.targets} home={home} words={changeWords} />
        </Sheet>
      )
    }
    case 'undo':
      return (
        <Sheet {...common} title="Undo this install" action="Undo install" ready={pending.plan.planHash !== null} note="Each file goes back to what it was before that install.">
          <Targets targets={pending.plan.targets} home={home} words={undoWords} />
        </Sheet>
      )
    case 'restore':
      return (
        <Sheet {...common} title={`Restore this version · ${diffSummary(pending.plan.diff)}`} action="Restore" ready={pending.plan.text !== undefined && pending.plan.diff !== ''}
          note="The current text is kept under Earlier versions. Nothing is installed.">
          {pending.plan.diff ? <pre className="diff">{diffBody(pending.plan.diff)}</pre> : null}
        </Sheet>
      )
    case 'test':
      return (
        <Sheet {...common} title={`Test whether ${ROSTER_APP_NAMES[pending.harness]} loads the rules`} action="Send test"
          note={`Starts ${ROSTER_APP_NAMES[pending.harness]} once and sends the rules to its provider. The result is Passed, Failed, Inconclusive or Unavailable.`} />
      )
  }
}

function Notice(props: { rules: RulesState }): React.JSX.Element | null {
  const notice = props.rules.notice
  if (notice === null) return null
  return <p className={notice.ok ? 'preferences-success' : 'preferences-error'} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>
}

// ---------------------------------------------------------------------------------------------
// Rules › Editor

/**
 * The master with line numbers. A transparent textarea sits exactly over a painted copy of the same
 * text, so marker lines can be dimmed while typing, selection and the caret stay the browser's own.
 */
export function RulesEditor(props: { value: string; readOnly: boolean; labelledBy: string; onChange(text: string): void; area: React.RefObject<HTMLTextAreaElement | null> }): React.JSX.Element {
  const lines = props.value.split('\n')
  return (
    <div className="rules-editor">
      <div className="rules-editor-text" aria-hidden="true">
        {lines.map((line, index) => (
          <div key={index} className="editor-line">
            <span className="line-number">{index + 1}</span>
            {markerParts(line).map((part, at) => (part.marker ? <span key={at} className="marker">{part.text}</span> : part.text))}
            {line === '' ? '​' : null}
          </div>
        ))}
      </div>
      <textarea ref={props.area} aria-labelledby={props.labelledBy} value={props.value} spellCheck={false} readOnly={props.readOnly} wrap="soft"
        onChange={(event) => props.onChange(event.currentTarget.value)} />
    </div>
  )
}

function InsertMenu(props: { disabled: boolean; onInsert(insert: (typeof INSERTS)[number]): void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
      return
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + step + items.length) % items.length]?.focus()
  }
  return (
    <div className="insert" ref={root} onKeyDown={onKeyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <button ref={button} type="button" className="small" aria-haspopup="menu" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen(!open)}>Insert ▾</button>
      {open ? (
        <div className="insert-menu" role="menu" aria-label="Insert">
          {INSERTS.map((insert, index) => (
            <button key={insert.id} type="button" role="menuitem" autoFocus={index === 0} onClick={() => { setOpen(false); props.onInsert(insert) }}>
              <span>{insert.label}</span><small>{insert.line}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function EditorPage(props: { rules: RulesState }): React.JSX.Element {
  const { rules } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const area = useRef<HTMLTextAreaElement | null>(null)
  const pathId = useId()
  const previewId = useId()
  const [previewApp, setPreviewApp] = useState<RosterHarness>('claude')
  const pending = rules.pending
  const targets = snapshot.health.state === 'checked' ? snapshot.health.targets : []
  const differ = targets.filter((target) => target.state !== 'current').length
  const installed = snapshot.transactions.find((entry) => entry.valid && entry.state === 'complete' && entry.reason !== 'team update')?.createdAt
  const renderings: readonly RulesRenderingView[] = rules.dirty && rules.draftPlan?.valid ? rules.draftPlan.renderings : snapshot.renderings
  const rendering = renderings.find((entry) => entry.harness === previewApp)
  const errors: readonly RosterIssueShape[] = rules.dirty ? rules.draftPlan?.errors ?? [] : snapshot.master.errors
  const earlier = earlierVersions(snapshot)
  const status = !snapshot.master.exists ? 'No rules yet'
    : `Saved ${shortDate(snapshot.master.savedAt ?? undefined)} · ${installed ? `last installed ${shortDate(installed)}` : 'never installed'}`
  return (
    <>
      <PageHead title="Rules" status={status}>
        {snapshot.master.exists && differ > 0 ? (
          <>
            <Dot label="Needs you" />
            <span className="muted">{differ} app{differ === 1 ? '' : 's'} differ{differ === 1 ? 's' : ''}</span>
            <button type="button" className={pending?.kind === 'install' ? undefined : 'primary'} disabled={rules.busy || rules.dirty || pending !== null}
              title={rules.dirty ? 'Save or discard your edits first' : undefined} onClick={() => void rules.beginInstall()}>Install…</button>
          </>
        ) : null}
      </PageHead>
      <Notice rules={rules} />
      {pending?.kind === 'install' ? <PendingSheet rules={rules} /> : null}
      <div className="editor-head">
        <span className="faint mono" id={pathId} title={snapshot.masterPath}>{displayPath(snapshot.masterPath, snapshot.home)}</span>
        <span className="faint">· {kilobytes(new TextEncoder().encode(rules.draft).length)} · {lineCount(rules.draft)} lines{rules.dirty ? ' · unsaved' : ''}</span>
        <span className="spacer" />
        <InsertMenu disabled={rules.busy || pending !== null} onInsert={(insert) => {
          const element = area.current
          const next = insertAt(rules.draft, element?.selectionStart ?? rules.draft.length, element?.selectionEnd ?? rules.draft.length, insert)
          rules.setDraft(next.text)
          requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(next.caret, next.caret) })
        }} />
      </div>
      <RulesEditor value={rules.draft} readOnly={pending !== null} labelledBy={pathId} area={area} onChange={rules.setDraft} />
      {errors.length > 0 ? <div role="alert"><p className="preferences-error">An app could not read these rules as written:</p><Issues issues={errors} /></div> : null}
      <div className="inline editor-actions">
        <button type="button" disabled={rules.busy || !rules.dirty || errors.length > 0 || pending !== null} onClick={() => void rules.beginSave()}>Save…</button>
        <button type="button" disabled={rules.busy || !rules.dirty || pending !== null} onClick={() => rules.setDraft(snapshot.master.text ?? '')}>Discard</button>
      </div>
      {pending?.kind === 'save' ? <PendingSheet rules={rules} /> : null}

      <details className="advanced" open>
        <summary>What each app reads</summary>
        <span id={previewId} hidden>Agent app</span>
        <Segmented<RosterHarness> labelledBy={previewId} fit options={ROSTER_HARNESSES} value={previewApp} optionLabel={(harness) => ROSTER_APP_NAMES[harness]} onChange={setPreviewApp} />
        {rendering ? (
          <>
            <p className="preferences-help">
              {KIND_WORDS[rendering.kind]}{rendering.kind === 'public' && rendering.reason ? `: ${rendering.reason}` : ''} · {kilobytes(rendering.bytes)}{rules.dirty ? ' · with your unsaved edits' : ''}
            </p>
            <pre className="reads" tabIndex={0} aria-label={`What ${ROSTER_APP_NAMES[previewApp]} reads`}>{rendering.text}</pre>
          </>
        ) : <p className="preferences-help">{snapshot.master.exists || rules.dirty ? 'Nothing to show while the rules have errors.' : 'Write the rules to see what each app reads.'}</p>}
      </details>

      <details className="advanced">
        <summary>Earlier versions</summary>
        {earlier.length === 0 ? <p className="preferences-help">Nothing yet. Every save and install is kept here.</p> : null}
        {earlier.map((entry) => (
          <div key={entry.kind === 'install' ? entry.id : `save-${entry.revision}`} className="list-line">
            <div><b>{entry.title}</b> <span className="line-detail">{shortDate(entry.at)}{entry.detail ? ` · ${entry.detail}` : ''}</span></div>
            {entry.kind === 'install'
              ? <button type="button" className="small" disabled={rules.busy || !entry.usable || pending !== null} aria-label={`Undo the install of ${shortDate(entry.at)}`} onClick={() => void rules.beginUndo(entry.id)}>Undo install…</button>
              : <button type="button" className="small" disabled={rules.busy || !entry.usable || rules.dirty || pending !== null} aria-label={`Restore the version saved ${shortDate(entry.at)}`}
                  title={rules.dirty ? 'Save or discard your edits first' : undefined} onClick={() => void rules.beginRestore(entry.revision)}>Restore…</button>}
          </div>
        ))}
        {pending?.kind === 'undo' || pending?.kind === 'restore' ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Rules › Health

type AppAction = { kind: 'destination'; harness: RosterHarness } | { kind: 'accept'; harness: RosterHarness; version: string }

/** Where an app sends data: its provider's own servers as BMN inspected them, or the owner's word for it. */
function DestinationSheet(props: { app: AgentAppView; data: RosterDataShape; onDone(next: RosterDataShape | null): void }): React.JSX.Element {
  const { app, data } = props
  const name = ROSTER_APP_NAMES[app.harness]
  const inspected = app.basis === 'default' && app.provider ? data.providers.find((provider) => provider.id === app.provider) ?? { id: app.provider, name: app.provider } : null
  const recorded = data.harness_routes.find((route) => route.harness === app.harness)
  const [choice, setChoice] = useState<string>(inspected ? 'inspected' : recorded?.provider ?? data.providers[0]?.id ?? '')
  const declared = data.providers.find((provider) => provider.id === choice)
  return (
    <Sheet title={`Where ${name} sends data`} action="Set destination" busy={false} ready={choice === 'inspected' ? inspected !== null : declared !== undefined}
      note="This waits for your approval like any other change to the team."
      onCancel={() => props.onDone(null)}
      onConfirm={() => props.onDone(choice === 'inspected' && inspected ? setDestination(data, app.harness, inspected, 'observed-default')
        : declared ? setDestination(data, app.harness, declared, 'owner-declared') : null)}>
      <div className="choice-list" role="radiogroup" aria-label={`Where ${name} sends data`}>
        {inspected ? (
          <label className="choice">
            <input type="radio" name={`destination-${app.harness}`} checked={choice === 'inspected'} onChange={() => setChoice('inspected')} />
            {inspected.name}'s own servers <span className="choice-line">as BMN inspected it just now; checked again when you approve</span>
          </label>
        ) : <p className="preferences-help">BMN can't confirm where {name} sends data{app.reason ? ` (${app.reason})` : ''}, so only your word can be recorded.</p>}
        {data.providers.map((provider) => (
          <label key={provider.id} className="choice">
            <input type="radio" name={`destination-${app.harness}`} checked={choice === provider.id} onChange={() => setChoice(provider.id)} />
            {provider.name} <span className="choice-line">on your word</span>
          </label>
        ))}
      </div>
      <p className="preferences-help">Anything on your word is not checked by BMN: {name} then gets public sections only and its agents public work only.</p>
    </Sheet>
  )
}

function HealthPage(props: { rules: RulesState; team: TeamState }): React.JSX.Element {
  const { rules, team } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const [action, setAction] = useState<AppAction | null>(null)
  const health = snapshot.health
  const data = team.data
  const pending = rules.pending
  const providerName = (id: string): string => data?.providers.find((provider) => provider.id === id)?.name ?? id
  const withheld = health.state === 'checked' ? health.targets.filter((target) => target.kind === 'public').map((target) => ROSTER_APP_NAMES[target.harness]) : []
  return (
    <>
      <PageHead title="Health" status={`Checked ${shortDate(health.checkedAt)}`}>
        <button type="button" disabled={rules.busy} onClick={() => void rules.load()}>{rules.busy && pending === null ? 'Checking…' : 'Check now'}</button>
      </PageHead>
      <Notice rules={rules} />
      <h4 className="group-head">Rules files</h4>
      {health.state === 'failed' ? <p className="preferences-error" role="alert">{health.reason}</p> : health.targets.map((target) => {
        const test = snapshot.probes.find((entry) => entry.harness === target.harness)
        return (
          <div key={target.harness} className="health-row" data-state={target.state}>
            <span>{ROSTER_APP_NAMES[target.harness]}</span>
            <span className="path mono" title={target.path}>{displayPath(target.path, snapshot.home)}</span>
            <span className="health-state">
              <span>{target.state === 'current' ? null : <Dot label="Needs you" />}{STATE_WORDS[target.state]} <span className="muted">· {KIND_WORDS[target.kind]}</span></span>
              <span className="faint">{target.kind === 'full' ? testLine(test) : 'No loading test'}</span>
            </span>
            {target.kind === 'full'
              ? <button type="button" className="small" disabled={rules.busy || pending !== null} aria-label={`Test ${ROSTER_APP_NAMES[target.harness]}`} onClick={() => rules.beginTest(target.harness)}>Test…</button>
              : <span />}
          </div>
        )
      })}
      {pending?.kind === 'test' ? <PendingSheet rules={rules} /> : null}
      <p className="preferences-help">
        A loading test starts the app once and sends it the rules.{withheld.length > 0 ? ` It is off for ${withheld.join(' and ')}: BMN can't confirm where ${withheld.length === 1 ? 'it sends' : 'they send'} data.` : ''}
      </p>

      <h4 className="group-head">Agent apps<span className="caption">where each app sends data</span></h4>
      {snapshot.apps.map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const route = data?.harness_routes.find((entry) => entry.harness === app.harness)
        const accepted = route?.accepted_versions ?? []
        return (
          <div key={app.harness} className="app-block">
            <div className="health-row">
              <span>{name}</span>
              <span><span className="mono">{app.version ?? 'not found'}</span> <span className="muted">· {VERSION_WORDS[app.versionState]}</span></span>
              <span className="health-state">
                <span>{destinationWords(app, providerName)}</span>
                <span className="faint">{route ? `Recorded: ${providerName(route.provider)}, ${route.basis === 'observed-default' ? 'as inspected' : 'on your word'}` : 'No destination recorded'}</span>
              </span>
              <span className="app-actions">
                <button type="button" className="small" disabled={data === null || action !== null} aria-label={`Set the destination of ${name}`} onClick={() => setAction({ kind: 'destination', harness: app.harness })}>Set destination…</button>
                {app.acceptable && app.version && data ? (
                  <button type="button" className="small" disabled={action !== null} aria-label={`Accept version ${app.version} of ${name}`}
                    onClick={() => setAction({ kind: 'accept', harness: app.harness, version: app.version as string })}>Accept version…</button>
                ) : null}
              </span>
            </div>
            {accepted.length > 0 && data ? (
              <div className="accepted">
                <span className="muted">Accepted</span>
                {accepted.map((version) => (
                  <span key={version} className="chip on mono">{version}
                    <button type="button" className="chip-remove" aria-label={`Remove accepted version ${version} of ${name}`} title="Remove accepted version…" onClick={() => team.stage(revokeVersion(data, app.harness, version))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            {action?.kind === 'destination' && action.harness === app.harness && data
              ? <DestinationSheet app={app} data={data} onDone={(next) => { setAction(null); if (next) team.stage(next) }} /> : null}
            {action?.kind === 'accept' && action.harness === app.harness && data ? (
              <Sheet title={`Accept version ${action.version} of ${name}`} action="Accept version" busy={false}
                note={`BMN was not tested with this version. ${app.comparison} Accepting it lets private work go through it; BMN inspects it again when you approve.`}
                onCancel={() => setAction(null)} onConfirm={() => { setAction(null); team.stage(acceptVersion(data, app.harness, action.version)) }} />
            ) : null}
            {app.versionState === 'new' && !app.acceptable ? <p className="preferences-help">{app.comparison}</p> : null}
          </div>
        )
      })}
      <p className="preferences-help">Tested versions are the ones BMN was checked against. Private work goes only through a tested or accepted version.</p>
    </>
  )
}

export function RulesPreferences(props: { rules: RulesState; team: TeamState; page: RulesPage }): React.JSX.Element {
  const { rules } = props
  const { ensure } = rules
  useEffect(() => ensure(), [ensure])
  const title = props.page === 'editor' ? 'Rules' : 'Health'
  if (rules.loadError && rules.snapshot === null) return <><PageHead title={title} /><p className="preferences-error" role="alert">{rules.loadError}</p></>
  if (rules.snapshot === null) return <><PageHead title={title} /><p className="page-note">Reading the rules…</p></>
  return props.page === 'editor' ? <EditorPage rules={rules} /> : <HealthPage rules={rules} team={props.team} />
}
