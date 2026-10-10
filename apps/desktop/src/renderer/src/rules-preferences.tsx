// MODULE: rules-preferences.tsx - Epic 60.6: Preferences › Rules: the master editor with what each app reads, install and earlier versions; Health with each rules file and agent app
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ROSTER_APP_NAMES,
  ROSTER_APP_UPDATE_ARGUMENTS,
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
import { quoteArgv } from './launch-template'
import { Dot } from './roster-marks'
import { diffBody, diffSummary, revokeVersion, setDestination, undoWords } from './roster-staging'
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

export const VERSION_WORDS: Readonly<Record<AgentAppView['versionState'], string>> = { tested: 'tested', newer: 'newer than tested', other: 'not tested', unknown: 'not checked' }

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
  /** Carries out what the sheet shows. With `then: 'install'`, a save is followed by the sheet that shows what each app would get. */
  confirm(then?: 'install'): Promise<void>
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

  async function confirm(then?: 'install'): Promise<void> {
    if (pending === null) return
    let run: () => Promise<RulesOutcome>
    if (pending.kind === 'save') {
      // The text the diff was shown for, never the editor's later state.
      const { text, plan } = pending
      run = () => window.aiTerminal.saveRulesMaster(text, plan.expectedHash, plan.expectedLink, plan.expectedDirectory)
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
      const { text, expectedHash, expectedLink, expectedDirectory } = pending.plan
      if (text === undefined) return
      run = () => window.aiTerminal.saveRulesMaster(text, expectedHash, expectedLink ?? null, expectedDirectory ?? null)
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
      // Save and install…: the saved rules go straight to the sheet that shows each app's file. Nothing is written there before Install.
      if (then === 'install' && outcome.ok && pending.kind === 'save') {
        try {
          const plan = await window.aiTerminal.planRulesInstall()
          if (plan.ok) {
            // The install sheet under it says what is still to do.
            setNotice({ ok: true, text: 'Saved' })
            setPending({ kind: 'install', plan })
          } else setNotice({ ok: false, text: `Saved, not installed. ${plan.message ?? 'Install cannot run now'}` })
        } catch (error) {
          setNotice({ ok: false, text: `Saved, not installed. ${failureDetail(error, 'Could not prepare the install')}` })
        }
      }
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
function Sheet(props: {
  title: string; note?: string | undefined; action: string; ready?: boolean | undefined; busy: boolean; onConfirm(): void; onCancel(): void; children?: ReactNode
  /** A second way to go on, beside the main one. */
  also?: { label: string; onClick(): void } | undefined
}): React.JSX.Element {
  return (
    <div className="sheet" role="group" aria-label={props.title}>
      <div className="sheet-head"><b>{props.title}</b>{props.note ? <span className="muted">{props.note}</span> : null}</div>
      {props.children}
      <div className="inline">
        <button type="button" className="primary" disabled={props.busy || props.ready === false} onClick={props.onConfirm}>{props.busy ? 'Working…' : props.action}</button>
        {props.also ? <button type="button" disabled={props.busy || props.ready === false} onClick={props.also.onClick}>{props.also.label}</button> : null}
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

/** Saving writes a regular file in place of a link, never through it (R60-NFR2): say so before it happens. */
export function LinkNote(props: { link: string | null | undefined; home: string | null; what: string }): React.JSX.Element | null {
  if (props.link === null || props.link === undefined) return null
  return (
    <p className="preferences-help">
      {props.what} is a link to <span className="path mono" title={props.link}>{displayPath(props.link, props.home)}</span>. This replaces the link with a regular file here; the file it points to stays as it is.
    </p>
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
          note={pending.plan.valid ? 'The text before this save is kept under Earlier versions.' : 'An app could not read them as written.'}
          also={pending.plan.valid ? { label: 'Save and install…', onClick: () => void rules.confirm('install') } : undefined}>
          <Issues issues={pending.plan.errors} />
          <LinkNote link={pending.plan.expectedLink} home={home} what="The rules file" />
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
          <LinkNote link={pending.plan.expectedLink} home={home} what="The rules file" />
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

type AppAction = { kind: 'destination'; harness: RosterHarness } | { kind: 'update'; harness: RosterHarness }

/** How many running sessions BMN recognises as each app. */
export type RecognisedSessions = Readonly<Partial<Record<RosterHarness, number>>>

/** The app's own update command, exactly as the owner would run it: the program by its full path, then its arguments. */
export function updateCommand(app: Pick<AgentAppView, 'harness' | 'program'>): string | null {
  return app.program === null ? null : quoteArgv([app.program, ...ROSTER_APP_UPDATE_ARGUMENTS[app.harness]])
}

/** What BMN can say about sessions of an app while it is updated: only the ones it recognises, and never their versions. */
export function sessionsWords(name: string, count: number): string {
  if (count === 0) return `BMN recognises no ${name} session right now. A session it cannot recognise keeps running what it started with.`
  return count === 1 ? `BMN currently recognises 1 ${name} session. Restart it to use the updated installation; its running version is not checked.`
    : `BMN currently recognises ${count} ${name} sessions. Restart them to use the updated installation; their running versions are not checked.`
}

/** What a check after an update read, said as only that: what the selected program reports now and before. */
export function recheckWords(before: string | null, after: string | null): string {
  if (after === null) return 'BMN could not read the installed version.'
  if (before === null) return `The program now reports ${after}.`
  return before === after ? `The program still reports ${after}.` : `The program now reports ${after}; before it reported ${before}.`
}

/**
 * What each app's program reported when its update command was copied, or a check was asked from
 * its sheet, and the check that read it. Kept while BMN runs: the owner runs the command in a
 * terminal, often with Preferences closed, and the answer is there when he comes back.
 */
const updateWatches = new Map<RosterHarness, { before: string | null; checkedAt: string }>()

/** Remembers what `app` reports now, unless an update of it is already being watched. */
export function watchUpdate(app: Pick<AgentAppView, 'harness' | 'version'>, checkedAt: string): void {
  if (!updateWatches.has(app.harness)) updateWatches.set(app.harness, { before: app.version, checkedAt })
}

/** What a later check read for a watched app, in words; null before any later check, and for an app not watched. */
export function watchedWords(app: Pick<AgentAppView, 'harness' | 'version'>, checkedAt: string): string | null {
  const watch = updateWatches.get(app.harness)
  return watch === undefined || watch.checkedAt === checkedAt ? null : recheckWords(watch.before, app.version)
}

/** Ends the watch of the given apps, or of all of them. */
export function forgetUpdateWatches(apps?: Iterable<RosterHarness>): void {
  if (apps === undefined) updateWatches.clear()
  else for (const harness of apps) updateWatches.delete(harness)
}

/** Health reads the machine again by itself when it was last read longer ago than this. */
const HEALTH_STALE_MS = 15_000

/**
 * The app's own updater, shown before anything runs: which program, the exact command, what BMN
 * knows about open sessions and what it reads again afterwards. BMN runs nothing here.
 */
export function UpdateSheet(props: {
  app: AgentAppView; home: string | null; sessions: number; hasTest: boolean; busy: boolean
  /** What a check after the command was copied read, or null before one. */
  result: string | null
  onCopied(): void; onCheck(): void; onClose(): void
}): React.JSX.Element {
  const { app } = props
  const name = ROSTER_APP_NAMES[app.harness]
  const command = updateCommand(app)
  const [copied, setCopied] = useState<string | null>(null)
  const sheet = useRef<HTMLDivElement | null>(null)
  useEffect(() => sheet.current?.focus(), [])
  const copy = (): void => {
    if (command === null) return
    props.onCopied()
    window.aiTerminal.writeClipboardText(command).then(() => setCopied('Copied'), () => setCopied('Could not copy the command.'))
  }
  return (
    <div className="sheet" ref={sheet} role="group" aria-label={`Update ${name}`} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose() } }}>
      <div className="sheet-head"><b>Update {name}</b><span className="muted">{name}'s own updater does this, not BMN.</span></div>
      <div className="facts">
        <span>Installed</span><span className="mono">{app.version ?? 'version not read'}</span>
        <span>Program</span>
        <span>
          <span className="mono wrap">{app.program ? displayPath(app.program, props.home) : 'not found'}</span>
          {app.programTarget ? <span className="preferences-help">A link to <span className="mono wrap">{displayPath(app.programTarget, props.home)}</span></span> : null}
          {app.harness === 'codex' ? <span className="preferences-help">In BMN's sessions, <span className="mono">codex</span> is BMN's own command; it hands over to this program, and this is the one updated.</span> : null}
        </span>
        <span>Command</span><span className="mono wrap">{command ?? 'no program found'}</span>
        <span>Open in BMN</span><span>{sessionsWords(name, props.sessions)}</span>
        <span>Afterwards</span>
        <span>Run the command in a terminal. When you come back to Health, BMN reads the version and where {name} sends data again.{props.hasTest ? ' A loading test made before the update needs to be run again.' : ''}</span>
      </div>
      <p className="preferences-help">The updater decides what it downloads and replaces, and may ask questions; BMN does not see that in advance and cannot undo it. BMN does not know whether a newer version exists.</p>
      {props.result ? <p role="status">{props.result}</p> : null}
      <div className="inline">
        <button type="button" className="primary" disabled={command === null} onClick={copy}>Copy command</button>
        {/* The button turns off while BMN checks and would drop the focus with it; the sheet keeps it, so Escape still closes only the sheet. */}
        <button type="button" disabled={props.busy} onClick={() => { sheet.current?.focus(); props.onCheck() }}>{props.busy ? 'Checking…' : 'Check now'}</button>
        <button type="button" onClick={props.onClose}>Close</button>
        {copied ? <span className="muted" role="status">{copied}</span> : null}
      </div>
    </div>
  )
}

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
        {/* The inspected provider on the owner's word would only take private work away from the app; it is offered once, as inspected. */}
        {data.providers.filter((provider) => provider.id !== inspected?.id).map((provider) => (
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

function HealthPage(props: { rules: RulesState; team: TeamState; recognised: RecognisedSessions }): React.JSX.Element {
  const { rules, team } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const [action, setAction] = useState<AppAction | null>(null)
  const [, redraw] = useState(0)
  // Apps whose before-and-now line was shown on this visit: said once, their watch ends when the owner leaves Health.
  const told = useRef(new Set<RosterHarness>())
  useEffect(() => {
    const shown = told.current
    return () => forgetUpdateWatches(shown)
  }, [])
  const top = useRef<HTMLHeadingElement | null>(null)
  const { load } = rules
  const checkedAt = snapshot.health.checkedAt
  // What Health shows is read from this machine, so BMN reads it again when the owner comes back: on opening
  // the page after a while and when the window gets the focus. Never under an unsaved draft or an open confirmation.
  const quiet = !rules.busy && rules.pending === null && !rules.dirty
  const arrived = useRef(false)
  useEffect(() => {
    if (arrived.current) return
    arrived.current = true
    if (quiet && Date.now() - Date.parse(checkedAt) > HEALTH_STALE_MS) void load()
  }, [quiet, checkedAt, load])
  useEffect(() => {
    if (!quiet) return
    // The page stays mounted, hidden, while the owner is elsewhere in Preferences.
    const onFocus = (): void => { if (top.current !== null && top.current.offsetParent !== null) void load() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [quiet, load])
  const opener = useRef<HTMLButtonElement | null>(null)
  // Update… is off while its sheet is open, so the focus can go back to it only once the sheet has gone.
  useEffect(() => {
    if (action !== null || opener.current === null) return
    opener.current.focus()
    opener.current = null
  }, [action])
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
      <h4 className="group-head" ref={top}>Rules files</h4>
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
        A loading test starts the app once and sends it the rules.{withheld.length > 0 ? ` It is off for ${withheld.join(' and ')}, which ${withheld.length === 1 ? 'gets' : 'get'} only the public sections.` : ''}
      </p>

      <h4 className="group-head">Agent apps<span className="caption">the program BMN finds, its version and where it sends data</span></h4>
      {snapshot.ownEnvironment ? (
        <p className="page-note" role="status"><Dot label="Needs you" />BMN could not read your shell's settings ({snapshot.ownEnvironment}), so it looked for the apps with its own. A session may find a program that BMN does not.</p>
      ) : null}
      {snapshot.apps.map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const route = data?.harness_routes.find((entry) => entry.harness === app.harness)
        const accepted = route?.accepted_versions ?? []
        const updating = action?.kind === 'update' && action.harness === app.harness
        const reports = watchedWords(app, health.checkedAt)
        if (reports !== null) told.current.add(app.harness)
        return (
          <div key={app.harness} className="app-block">
            <div className="health-row">
              <span>{name}</span>
              <span className="health-state">
                {app.version === null
                  ? <span className="mono" title={app.versionNote}>{app.program ? 'version not read' : 'not found'}</span>
                  : <span><span className="mono">{app.version}</span> <span className="muted" title={app.versionNote}>· {VERSION_WORDS[app.versionState]}</span></span>}
                {app.program ? <span className="path mono wrap" title={app.program}>{displayPath(app.program, snapshot.home)}</span> : null}
              </span>
              <span className="health-state">
                <span>{destinationWords(app, providerName)}</span>
                <span className="faint">{route ? `Recorded: ${providerName(route.provider)}, ${route.basis === 'observed-default' ? 'as inspected' : 'on your word'}` : 'No destination recorded'}</span>
              </span>
              <span className="app-actions">
                <button type="button" className="small" disabled={app.program === null || action !== null} aria-label={`Update ${name}`} aria-expanded={updating}
                  title={app.program === null ? `BMN finds no ${name} program to update` : undefined}
                  onClick={(event) => { opener.current = event.currentTarget; setAction({ kind: 'update', harness: app.harness }) }}>Update…</button>
                <button type="button" className="small" disabled={data === null || action !== null} aria-label={`Set the destination of ${name}`} onClick={() => setAction({ kind: 'destination', harness: app.harness })}>Set destination…</button>
              </span>
            </div>
            {accepted.length > 0 && data ? (
              <div className="accepted">
                <span className="muted">Accepted earlier, no longer needed</span>
                {accepted.map((version) => (
                  <span key={version} className="chip on mono">{version}
                    <button type="button" className="chip-remove" aria-label={`Remove accepted version ${version} of ${name}`} title="Remove it from the team file…" onClick={() => team.stage(revokeVersion(data, app.harness, version))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            {action?.kind === 'destination' && action.harness === app.harness && data
              ? <DestinationSheet app={app} data={data} onDone={(next) => { setAction(null); if (next) team.stage(next) }} /> : null}
            {updating ? (
              <UpdateSheet app={app} home={snapshot.home} sessions={props.recognised[app.harness] ?? 0} busy={rules.busy}
                hasTest={snapshot.probes.some((entry) => entry.harness === app.harness && entry.outcome !== null)} result={reports}
                onCopied={() => watchUpdate(app, health.checkedAt)}
                onCheck={() => { watchUpdate(app, health.checkedAt); redraw((count) => count + 1); void rules.load() }}
                onClose={() => setAction(null)} />
            ) : reports !== null ? <p className="app-note" role="status">{reports}</p> : null}
          </div>
        )
      })}
      <p className="preferences-help">Tested versions are the ones BMN was checked against. Every installed version is supported: BMN works out where an app sends data the same way on each and notes the version with every check.</p>
    </>
  )
}

export function RulesPreferences(props: { rules: RulesState; team: TeamState; page: RulesPage; recognised?: RecognisedSessions }): React.JSX.Element {
  const { rules } = props
  const { ensure, setNotice } = rules
  useEffect(() => ensure(), [ensure])
  // A notice reports what was done on one page; it does not follow the owner to the other.
  const shown = useRef(props.page)
  useEffect(() => {
    if (shown.current === props.page) return
    shown.current = props.page
    setNotice(null)
  }, [props.page, setNotice])
  const title = props.page === 'editor' ? 'Rules' : 'Health'
  if (rules.loadError && rules.snapshot === null) return <><PageHead title={title} /><p className="preferences-error" role="alert">{rules.loadError}</p></>
  if (rules.snapshot === null) return <><PageHead title={title} /><p className="page-note">Reading the rules…</p></>
  return props.page === 'editor' ? <EditorPage rules={rules} /> : <HealthPage rules={rules} team={props.team} recognised={props.recognised ?? {}} />
}
