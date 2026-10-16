// MODULE: rules-preferences.tsx - Epic 60.6: Preferences › Rules: the master editor with what each app reads, install and earlier versions; Skills and Tools with each one's apps and state; Health with each rules file and agent app
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { takesPress, type CommandPress, type CommandStart, type RunInSession } from './session-command'
import {
  RETIRED_APP_LINE,
  ROSTER_APP_NAMES,
  ROSTER_APP_UPDATE_ARGUMENTS,
  ROSTER_HARNESSES,
  appDisplayName,
  type AgentAppView,
  type ContextAgentLimit,
  type ContextLimitApp,
  type ContextLimitPlan,
  type ContextLimitView,
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
  type RulesTargetState,
  type SkillStateName,
  type SkillView,
  type SkillsAppView,
  type SkillsPlan,
  type RosterToolShape,
  type ToolProposalView,
  type ToolView,
  type ToolsAppView,
  type ToolsPlan
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { createMachineReads, endedSince, type MachineReads } from './machine-reads'
import { Segmented } from './history-preferences'
import { quoteArgv } from './launch-template'
import { Dot } from './roster-marks'
import { destinationProviders, diffBody, diffSummary, listedRoles, revokeVersion, setDestination, setSkillPublic, skillForApp, skillMark, thousands, toggleSkillApp, undoWords } from './roster-staging'
import { displayPath } from './session-presentation'
import { Issues, NumberField, PageHead, Row, Switch, TargetPath, shortDate } from './team-preferences'
import type { TeamState } from './team-state'
import {
  EMPTY_DRAFT, MAX_TOOLS, SCOPE_WORDS, addable, draftFrom, idFromName, removeTool, setTool, setToolPublic, toggleToolAgent, toggleToolApp, toolForApp, toolFrom, toolStateHint, toolStateWords,
  toolVariables, toolsTestLine, transportWords, withProposals, type ToolDraft, type ToolScope
} from './tools-view'

export { diffSummary, endedSince, undoWords }

export type RulesPage = 'editor' | 'skills' | 'tools' | 'health'

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

/** The reason a skills install records, which tells it from a rules install. */
const SKILLS_INSTALL = 'skills install'
/** The reason a tools install records. */
const TOOLS_INSTALL = 'tools install'

/** Installs and saves, newest first, as Earlier versions lists them. */
export type Earlier =
  | { kind: 'install'; id: string; at: string | undefined; title: string; detail: string; usable: boolean }
  | { kind: 'save'; revision: number; at: string; title: string; detail: string; usable: boolean }

export function earlierVersions(snapshot: Pick<RulesSnapshot, 'transactions' | 'history'>): Earlier[] {
  // A skills or tools install is undone on its own page, where it was made.
  const installs: Earlier[] = snapshot.transactions.filter((entry) => entry.reason !== SKILLS_INSTALL && entry.reason !== TOOLS_INSTALL).map((entry) => ({
    kind: 'install', id: entry.id, at: entry.createdAt, usable: entry.valid && entry.state === 'complete',
    title: !entry.valid ? 'An install that cannot be read' : entry.reason === 'team update' ? 'Team line updated' : 'Installed',
    detail: (entry.targets ?? []).map(appDisplayName).join(', ') + (entry.valid && entry.state !== 'complete' ? ' · did not finish' : '')
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
  | { kind: 'skills'; plan: SkillsPlan }
  | { kind: 'tools'; plan: ToolsPlan }

export interface RulesState {
  snapshot: RulesSnapshot | null
  /** When the read whose answer is shown was asked for; what is shown is judged fresh by this, not by a time inside it (63.4). */
  began: number | null
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
  /** Reads the rules once; later reads are Health's rule (Story 75.7). */
  ensure(): void
  /** Reads them again if they were read before: an approval changes what each app may read. */
  refresh(): void
  load(): Promise<void>
  beginSave(): Promise<void>
  beginInstall(): Promise<void>
  /** Shows what a skills install would link, copy or remove in each app. */
  beginSkillsInstall(): Promise<void>
  /** Shows the entries a tools install would set or remove in each app's settings; `removeUnlisted` adds the entries that are not on the list. */
  beginToolsInstall(removeUnlisted: boolean): Promise<void>
  beginUndo(transaction: string): Promise<void>
  beginRestore(revision: number): Promise<void>
  beginTest(harness: RosterHarness): void
  /** Carries out what the sheet shows. With `then: 'install'`, a save is followed by the sheet that shows what each app would get. */
  confirm(then?: 'install'): Promise<void>
  cancel(): void
  /** Carries out one Health action and shows what came of it; resolves to whether it was done. An unsaved draft stays. */
  run(task: () => Promise<RulesOutcome>): Promise<boolean>
}

/** The Rules pages' state, held once by the Preferences dialog so an unsaved draft survives a look at Health. */
export function useRulesState(): RulesState {
  const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftPlan, setDraftPlan] = useState<RulesMasterPlan | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [began, setBegan] = useState<number | null>(null)
  // A read of the machine and an action are told apart, so the end of one never says the other is over.
  const [reading, setReading] = useState(false)
  const [acting, setBusy] = useState(false)
  const busy = reading || acting
  const asked = useRef(false)

  /** What was read replaces the page, never an unsaved draft. */
  const show = useCallback((next: RulesSnapshot): void => {
    setSnapshot((current) => {
      setDraft((text) => (current !== null && text !== (current.master.text ?? '') ? text : next.master.text ?? ''))
      return next
    })
  }, [])

  // Reads go one at a time and only the answer of the one begun last is shown (63.4 AC1, AC3).
  const reads = useRef<MachineReads | null>(null)
  reads.current ??= createMachineReads<RulesSnapshot>({
    fetch: () => window.aiTerminal.rulesSnapshot(),
    adopt: (next, at) => {
      show(next)
      setBegan(at)
      setLoadError(null)
    },
    failed: (error) => setLoadError(failureDetail(error, 'Could not read the rules')),
    reading: setReading
  })

  const adopt = useCallback((next: RulesSnapshot): void => {
    // What an action left behind is newer than a read begun while it ran.
    setBegan((reads.current as MachineReads).shownElsewhere())
    setSnapshot(next)
    setDraft(next.master.text ?? '')
    setDraftPlan(null)
  }, [])

  const load = useCallback((): Promise<void> => (reads.current as MachineReads).read(), [])

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
    } else if (pending.kind === 'skills') {
      const { planHash } = pending.plan
      if (planHash === null) return
      run = () => window.aiTerminal.installSkills(planHash)
    } else if (pending.kind === 'tools') {
      const { planHash, removeUnlisted } = pending.plan
      if (planHash === null) return
      run = () => window.aiTerminal.installTools(planHash, removeUnlisted)
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

  async function run(task: () => Promise<RulesOutcome>): Promise<boolean> {
    setNotice(null)
    setBusy(true)
    try {
      const outcome = await task()
      // Like a read by Health's rule: what was read again replaces the page, never an unsaved draft.
      setBegan((reads.current as MachineReads).shownElsewhere())
      show(outcome.snapshot)
      setNotice({ ok: outcome.ok, text: outcome.ok || outcome.code !== 'REVISION_CONFLICT' ? outcome.message : 'Something changed since this was shown. Reloaded without writing.' })
      return outcome.ok
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'That could not be done') })
      return false
    } finally {
      setBusy(false)
    }
  }

  // BMN is running a context (63.1) or skills test by itself: what it found is read once it has ended, never under an open confirmation.
  const testing = snapshot !== null && (snapshot.contextAuto.running !== null || snapshot.skills.apps.some((app) => app.testing === true)) ? snapshot : null
  const confirming = pending !== null
  useEffect(() => {
    if (testing === null || confirming) return
    let cancelled = false
    Promise.all([window.aiTerminal.contextAuto(false), window.aiTerminal.skillsAuto(false)]).then(() => { if (!cancelled) void load() }).catch(() => undefined)
    return () => { cancelled = true }
  }, [testing, confirming, load])

  return {
    snapshot, began, loadError, draft, dirty, draftPlan, busy, notice, pending, setDraft, setNotice, ensure, refresh, load, run,
    beginSave: () => {
      const text = draft
      return begin(async () => ({ kind: 'save', text, plan: await window.aiTerminal.planRulesMaster(text) }))
    },
    beginInstall: () => begin(async () => {
      const plan = await window.aiTerminal.planRulesInstall()
      return plan.ok ? { kind: 'install', plan } : plan.message ?? 'Install cannot run now'
    }),
    beginSkillsInstall: () => begin(async () => {
      const plan = await window.aiTerminal.planSkillsInstall()
      return plan.ok ? { kind: 'skills', plan } : plan.message ?? 'The skills cannot be installed now'
    }),
    beginToolsInstall: (removeUnlisted) => begin(async () => {
      const plan = await window.aiTerminal.planToolsInstall(removeUnlisted)
      return plan.ok ? { kind: 'tools', plan } : plan.message ?? 'The tools cannot be installed now'
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
      {props.targets.map((target, index) => (
        // Several entries of one settings file share its path.
        <details key={`${target.path}:${index}`} className="target">
          <summary>
            <span>{ROSTER_APP_NAMES[target.harness]}</span>
            <span className="target-file"><TargetPath target={target} home={props.home} /><span className="muted">{target.entry === undefined ? '' : `${target.entry} · `}{props.words(target)}</span></span>
            <span className="muted">{target.rendering ? KIND_WORDS[target.rendering] : ''}</span>
          </summary>
          {target.note !== undefined && target.diff === '' ? <p className="preferences-help">{target.note}</p> : <pre className="diff">{diffBody(target.diff) || 'No change.'}</pre>}
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
    case 'skills': {
      const count = pending.plan.targets.length
      const open = pending.plan.exposed
      return (
        <Sheet {...common} title={count === 0 ? 'Every app already has its skills' : `Change ${count} skill entr${count === 1 ? 'y' : 'ies'}`} action="Install"
          ready={count > 0 && pending.plan.planHash !== null} note={count === 0 ? undefined : 'Undo install, under Earlier installs, puts every entry back.'}>
          <Targets targets={pending.plan.targets} home={home} words={(target) => `${(target as SkillsPlan['targets'][number]).skill} · ${target.kind}`} />
          {open.length > 0 ? (
            <div role="status">
              <p className="preferences-help"><Dot label="Needs you" />{open.length === 1 ? 'One skill stays' : `${open.length} skills stay`} exposed whatever is installed:</p>
              {open.map((entry) => <p key={`${entry.harness}:${entry.skill}`} className="preferences-help">{entry.fix}</p>)}
            </div>
          ) : null}
        </Sheet>
      )
    }
    case 'tools': {
      const count = pending.plan.targets.length
      const { exposed, blocked } = pending.plan
      return (
        <Sheet {...common} title={count === 0 ? 'Every app already has its tools' : `Change ${count} tool entr${count === 1 ? 'y' : 'ies'}`} action="Install"
          ready={count > 0 && pending.plan.planHash !== null} note={count === 0 ? undefined : 'Only these entries change in each file. Undo install, under Earlier installs, puts them back.'}>
          {pending.plan.targets.map((target) => (
            <details key={`${target.harness}:${target.tool}`} className="target">
              <summary>
                <span>{ROSTER_APP_NAMES[target.harness]}</span>
                <span className="target-file"><TargetPath target={{ path: target.path }} home={home} /><span className="muted">{target.tool} · {target.words}</span></span>
                <span className="muted" />
              </summary>
              <pre className="diff">{[...(target.before?.split('\n').map((line) => `-${line}`) ?? []), ...(target.after?.split('\n').map((line) => `+${line}`) ?? [])].join('\n')}</pre>
            </details>
          ))}
          {exposed.length > 0 ? (
            <div role="status">
              <p className="preferences-help"><Dot label="Needs you" />{exposed.length === 1 ? 'One entry stays' : `${exposed.length} entries stay`} exposed whatever is installed:</p>
              {exposed.map((entry) => <p key={`${entry.harness}:${entry.tool}`} className="preferences-help">{entry.tool}: {entry.fix}</p>)}
            </div>
          ) : null}
          {blocked.length > 0 ? (
            <div role="status">
              <p className="preferences-help"><Dot label="Needs you" />{blocked.length === 1 ? 'One entry is' : `${blocked.length} entries are`} not changed:</p>
              {blocked.map((entry) => <p key={`${entry.harness}:${entry.tool}`} className="preferences-help">{ROSTER_APP_NAMES[entry.harness]}, {entry.tool}: {entry.fix}</p>)}
            </div>
          ) : null}
        </Sheet>
      )
    }
    case 'undo':
      return (
        <Sheet {...common} title="Undo this install" action="Undo install" ready={pending.plan.planHash !== null} note="Each file goes back to what it was before that install.">
          <Targets targets={pending.plan.targets} home={home} words={undoWords} />
          {(pending.plan.left ?? []).map((target) => (
            <p key={target.path} className="preferences-help">
              {RETIRED_APP_LINE} <span className="path mono" title={target.path}>{displayPath(target.path, home)}</span> is left as it is.
            </p>
          ))}
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
  const installed = snapshot.transactions.find((entry) => entry.valid && entry.state === 'complete' && entry.reason !== 'team update' && entry.reason !== SKILLS_INSTALL && entry.reason !== TOOLS_INSTALL)?.createdAt
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
  | { kind: 'context-test'; harness: ContextLimitApp } | { kind: 'context-change'; harness: ContextLimitApp } | { kind: 'skills-test'; harness: RosterHarness } | { kind: 'skills-loading-test'; harness: RosterHarness }
  | { kind: 'tools-test'; harness: RosterHarness }

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

/** Remembers what `app` reports now, unless an update of it is already being watched; `afresh` for an update BMN starts now. */
export function watchUpdate(app: Pick<AgentAppView, 'harness' | 'version'>, checkedAt: string, afresh = false): void {
  if (afresh || !updateWatches.has(app.harness)) updateWatches.set(app.harness, { before: app.version, checkedAt })
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

/** When a command BMN typed for an update last ended in its session, and who wants to hear of the next. */
let updateEndedAt: number | null = null
const updateEndListeners = new Set<() => void>()

/** The shell an update command was typed into reads a line again, or its session ended: Health, open now or later, reads the machine after it. */
export function updateEnded(at: number = Date.now()): void {
  updateEndedAt = at
  for (const listener of [...updateEndListeners]) {
    try {
      listener()
    } catch {
      // One listener that fails does not keep the others from hearing of the end.
    }
  }
}

/** Hears of each end of an update command; returns how to stop listening. */
export function onUpdateEnded(listener: () => void): () => void {
  updateEndListeners.add(listener)
  return () => { updateEndListeners.delete(listener) }
}

/** An update command BMN typed has ended: Health reads the machine after it, and BMN looks for a new app version to test (63.1 AC1, and skills). */
function updateRunEnded(): void {
  updateEnded()
  void window.aiTerminal.contextAuto(true).catch(() => undefined)
  void window.aiTerminal.skillsAuto(true).catch(() => undefined)
}

/** What the sheet says about a press on Update now that did not run the command; null while there is nothing to say. */
export function pressWords(press: CommandPress, session: string): string | null {
  if (press === 'opening') return `Opening ${session} and waiting for its shell…`
  if (press === 'not-reading') return `The shell in ${session} did not get ready for a command, so BMN typed nothing there. Copy the command and run it yourself.`
  return press === 'failed' ? 'BMN could not open a session, so nothing ran. Press Update now again, or copy the command.' : null
}

/** Health reads the machine again by itself when it was last read longer ago than this. */
const HEALTH_STALE_MS = 15_000

/**
 * The app's own updater, shown before anything runs: which program, the exact command, what BMN
 * knows about open sessions and what it reads again afterwards. Nothing starts before the owner
 * presses Update now, which runs that exact command in a new session he can see.
 */
export function UpdateSheet(props: {
  app: AgentAppView; home: string | null; sessions: number; hasTest: boolean; busy: boolean
  /** What a check after the command was copied read, or null before one. */
  result: string | null
  onCopied(): void; onClose(): void
  /** Runs the command in a new shell session and shows it, answering how that went; `left` tells it the sheet was closed. Absent where no session can be opened. */
  onRun?: ((name: string, command: string, left: AbortSignal) => Promise<CommandStart>) | undefined
  /** Where a press on Update now stands when the sheet opens; `idle` unless a test says otherwise. */
  press?: CommandPress | undefined
}): React.JSX.Element {
  const { app } = props
  const name = ROSTER_APP_NAMES[app.harness]
  const command = updateCommand(app)
  const [copied, setCopied] = useState<string | null>(null)
  // One press, one run: a second press while the session opens would start a second updater beside the first.
  // The ref answers the second press of a double click, which comes before the sheet is drawn again.
  const pressed = useRef<CommandPress>(props.press ?? 'idle')
  const [press, setPress] = useState<CommandPress>(pressed.current)
  const sheet = useRef<HTMLDivElement | null>(null)
  useEffect(() => sheet.current?.focus(), [])
  // Closing the sheet while BMN still waits for the new session's shell takes the press back: nothing is typed afterwards.
  const leaving = useRef<AbortController | null>(null)
  useEffect(() => () => leaving.current?.abort(), [])
  const stands = (next: CommandPress): void => {
    pressed.current = next
    setPress(next)
  }
  const run = (): void => {
    if (command === null || props.onRun === undefined || !takesPress(pressed.current)) return
    // The button turns off with the press and would drop the focus with it; the sheet keeps it, so Escape still closes only the sheet.
    sheet.current?.focus()
    stands('opening')
    leaving.current = new AbortController()
    void props.onRun(`Update ${name}`, command, leaving.current.signal).then(stands, () => stands('failed'))
  }
  const said = pressWords(press, `Update ${name}`)
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
        <span>{props.onRun
          ? `Update now opens a new session and, once its shell shows its prompt, types the command there and presses Enter; you see what the updater does and answer what it asks. Or run it in any terminal. BMN reads the version and where ${name} sends data again each time that session's shell is back at its prompt, and whenever you come back to Health.`
          : `Run the command in a terminal. When you come back to Health, BMN reads the version and where ${name} sends data again.`}{props.hasTest ? ' A loading test made before the update needs to be run again.' : ''}</span>
      </div>
      <p className="preferences-help">The updater decides what it downloads and replaces, and may ask questions; BMN does not see that in advance and cannot undo it. BMN does not know whether a newer version exists.{props.onRun ? ' BMN knows the prompt by the sign the shell\'s line editor gives; a question that one of your shell\'s start-up files asks with line editing gives the same sign and would get the command as its answer.' : ''}</p>
      {props.result ? <p role="status">{props.result}</p> : null}
      {said ? <p role="status">{said}</p> : null}
      <div className="inline">
        {/* Where the shell never got ready, copying is what is left to do, so it becomes the main action. */}
        {props.onRun ? (
          <button type="button" className={press === 'not-reading' ? undefined : 'primary'} disabled={command === null || !takesPress(press)} onClick={run}>Update now</button>
        ) : null}
        <button type="button" className={props.onRun && press !== 'not-reading' ? undefined : 'primary'} disabled={command === null} onClick={copy}>Copy command</button>
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
  // A provider only a retired app's lines name is not offered as anyone's destination (Epic 71).
  const providers = destinationProviders(data)
  const [choice, setChoice] = useState<string>(inspected ? 'inspected' : recorded?.provider ?? providers[0]?.id ?? '')
  const declared = providers.find((provider) => provider.id === choice)
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
        {providers.filter((provider) => provider.id !== inspected?.id).map((provider) => (
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

/** "Opus, Fable and Sonnet". */
function named(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}

/** An app's default for the owner's own sessions, as its file holds it. */
export function contextValueWords(row: Pick<ContextLimitView, 'limit' | 'compact' | 'unreadable'>): string {
  if (row.unreadable) return "Can't be read"
  if (row.limit === null) return 'App default'
  return `${thousands(row.limit)} tokens${row.compact === null ? '' : ` · summarises at ${thousands(row.compact)}`}`
}

/**
 * Whether BMN may use the app's setting on the installed version, and why not when it may not (60.9 AC1).
 * A test BMN ran by itself says so, with its day, the version and what came of it (63.1 AC5).
 */
export function contextStateWords(row: Pick<ContextLimitView, 'limitProven' | 'version' | 'test'>): string {
  if (row.version === null) return 'Not supported yet · the app is not found'
  const last = row.test !== null && row.test.version === row.version ? row.test : null
  if (last?.by === 'bmn') {
    return `BMN tested ${row.version} by itself ${shortDate(last.at)} · ${last.outcome === 'pass' ? 'it takes the setting' : last.outcome === 'fail' ? 'the test failed' : 'the test showed nothing'}`
  }
  if (row.limitProven) return `Setting tested on ${row.version}`
  return `Not supported yet · ${last?.outcome === 'fail' ? `the test failed on ${row.version}` : last?.outcome === 'inconclusive' ? `the test was inconclusive on ${row.version}` : `not tested on ${row.version}`}`
}

/**
 * What Health says while the approved team holds no role to read-only although BMN proposes some (63.2 AC4):
 * a team from before the mark reads as before, and the owner is told what that leaves open. Null otherwise.
 */
export function notHeldWords(roles: RulesSnapshot['readOnlyRoles']): string | null {
  if (roles === null || roles.held.length > 0 || roles.proposed.length === 0) return null
  return `No role is held to read-only yet, so the check passes a reviewer started with write access. Team › Roles proposes ${listedRoles(roles.proposed)}.`
}

/** What becomes of an agent's own limit in a run BMN checks, in one line (63.1 AC4). */
export function agentLimitWords(entry: ContextAgentLimit): string {
  const size = thousands(entry.limit)
  if (entry.state === 'applied') return `${entry.agent}: its own limit of ${size} is applied to each run.`
  if (entry.state === 'refused') return `${entry.agent}: runs are refused, because its own limit of ${size} cannot be applied.`
  return `${entry.agent}: its own limit of ${size} is not applied, so a run gets the app's own size.`
}

const AUTO_TEST = 'Test context limits after an app update'

const PLAN_PENDING: ContextLimitPlan = { ok: false, code: 'PENDING', diff: '', planHash: null }

/**
 * Change… for one app's default: the two sizes, then exactly what would be written to which file,
 * before the one button that writes it (R60-NFR2). The diff is made again whenever a size changes.
 */
function ContextSheet(props: { row: ContextLimitView; home: string | null; busy: boolean; onDone(): void; run: RulesState['run'] }): React.JSX.Element {
  const { row } = props
  const name = ROSTER_APP_NAMES[row.harness]
  const [limit, setLimit] = useState<number | undefined>(row.limit ?? undefined)
  const [compact, setCompact] = useState<number | undefined>(row.compactProven ? row.compact ?? undefined : undefined)
  const [plan, setPlan] = useState<{ limit: number | undefined; compact: number | undefined; plan: ContextLimitPlan }>({ limit, compact, plan: PLAN_PENDING })
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      window.aiTerminal.planContextLimit(row.harness, limit ?? null, limit === undefined ? null : compact ?? null)
        .then((next) => { if (!cancelled) setPlan({ limit, compact, plan: next }) })
        .catch((error: unknown) => { if (!cancelled) setPlan({ limit, compact, plan: { ok: false, code: 'IO_ERROR', message: failureDetail(error, 'The change could not be prepared'), diff: '', planHash: null } }) })
    }, PLAN_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [row.harness, limit, compact])
  const current = plan.limit === limit && plan.compact === compact ? plan.plan : PLAN_PENDING
  const ready = current.ok && current.planHash !== null && current.diff !== ''
  return (
    <Sheet title={`${name}'s default context limit`} note="For sessions you start yourself." action="Change" busy={props.busy} ready={ready} onCancel={props.onDone}
      onConfirm={() => {
        const hash = current.planHash
        if (hash !== null) void props.run(() => window.aiTerminal.applyContextLimit(row.harness, limit ?? null, limit === undefined ? null : compact ?? null, hash)).then((done) => { if (done) props.onDone() })
      }}>
      <div className="facts">
        <span>File</span>
        <span>
          <span className="mono wrap">{displayPath(row.path, props.home)}</span>
          {current.resolvedPath && current.resolvedPath !== row.path ? <span className="preferences-help">Written at <span className="mono wrap">{displayPath(current.resolvedPath, props.home)}</span></span> : null}
          <LinkNote link={row.linkTarget} home={props.home} what="This file" />
        </span>
        <span>Context limit</span>
        <span>
          <span className="inline"><NumberField label={`${name} context limit`} value={limit} placeholder="App default" onChange={setLimit}
            refuse={(value) => (row.min !== undefined && row.max !== undefined && (value < row.min || value > row.max) ? `${name} takes ${thousands(row.min)} to ${thousands(row.max)}` : null)} /><span className="faint">tokens</span></span>
        </span>
        {row.compactProven && limit !== undefined ? (
          <>
            <span>Compact at</span>
            <span><span className="inline"><NumberField label={`${name} compact at`} value={compact} placeholder="App default" onChange={setCompact}
              refuse={(value) => (value >= limit ? `Must be below ${thousands(limit)}` : null)} /><span className="faint">tokens</span></span></span>
          </>
        ) : null}
        {row.agents.length > 0 ? (
          <>
            <span>Shared by</span>
            <span>{named(row.agents)}{row.harness === 'claude' ? <span className="preferences-help">Each of them then runs with this limit. A run BMN checks is refused while an agent's own limit differs from it.</span> : null}</span>
          </>
        ) : null}
      </div>
      {current.code === 'PENDING' ? null : !current.ok ? <p className="preferences-error" role="alert">{current.message ?? 'This change cannot be made'}</p>
        : current.diff === '' ? <p className="preferences-help">The file already holds this.</p>
          : <pre className="diff">{diffBody(current.diff)}</pre>}
    </Sheet>
  )
}

/** Rules › Health › Context limits: one row per app BMN has a setting for (60.9 AC3). */
function ContextLimits(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const auto = snapshot.contextAuto
  const idle = !rules.busy && action === null && rules.pending === null
  return (
    <>
      <h4 className="group-head">Context limits<span className="caption">how large a conversation may grow in sessions you start yourself</span></h4>
      <div className="health-row auto-test">
        <span id="context-auto-test">{AUTO_TEST}</span>
        <span className="faint">{auto.enabled
          ? 'When an app has a new version and an agent on it has a limit of its own, BMN starts that app once in an empty folder: Claude Code is asked for its context report, Codex gets one short request to its provider. Nothing of yours is in it.'
          : 'Off: BMN starts no app. After an update an agent\'s own limit waits until you run Test… for that app.'}</span>
        <Switch labelledBy="context-auto-test" on={auto.enabled} disabled={!idle} onChange={(next) => void rules.run(() => window.aiTerminal.setContextAuto(next))} />
      </div>
      {snapshot.context.map((row) => {
        const name = ROSTER_APP_NAMES[row.harness]
        return (
          <div key={row.harness} className="limit-block">
            <div className="health-row">
              <span>{name}</span>
              <span className="health-state">
                <span className="path mono" title={row.path}>{displayPath(row.path, snapshot.home)}</span>
                {row.agents.length > 0 ? <span className="faint">Shared by {named(row.agents)}</span> : null}
              </span>
              <span className="health-state">
                <span title={row.unreadable}>{row.unreadable ? <Dot label="Needs you" /> : null}{contextValueWords(row)}</span>
                <span className="faint" title={row.test?.detail}>{auto.running === row.harness ? `BMN is testing ${name} by itself now…` : contextStateWords(row)}</span>
              </span>
              <span className="app-actions">
                <button type="button" className="small" disabled={!idle || row.version === null} aria-label={`Context test for ${name}`} onClick={() => props.setAction({ kind: 'context-test', harness: row.harness })}>Test…</button>
                <button type="button" className="small" disabled={!idle || !row.limitProven || row.unreadable !== undefined} aria-label={`Change the default context limit of ${name}`}
                  title={row.limitProven ? undefined : `Not supported yet: run the test for ${name} first`} onClick={() => props.setAction({ kind: 'context-change', harness: row.harness })}>Change…</button>
              </span>
            </div>
            {row.limits.map((entry) => (
              <p key={entry.agent} className="limit-note" title={entry.reason} role={entry.state === 'applied' ? undefined : 'status'}>
                {entry.state === 'applied' ? null : <Dot label="Needs you" />}{agentLimitWords(entry)}
              </p>
            ))}
            {action?.kind === 'context-test' && action.harness === row.harness ? (
              <Sheet title={`Test whether ${name} takes a context limit`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} once in an empty folder under your home folder and asks it for an unusual size. It may send one short request to its provider; nothing of yours is in it. The result is kept for this version.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testContextLimit(row.harness)).then(() => props.setAction(null))} />
            ) : null}
            {action?.kind === 'context-change' && action.harness === row.harness
              ? <ContextSheet row={row} home={snapshot.home} busy={rules.busy} run={rules.run} onDone={() => props.setAction(null)} /> : null}
          </div>
        )
      })}
      <p className="preferences-help">BMN changes a limit only on an app version whose test passed. An agent's own limit, set on its page, is added to each run BMN or dev-auto starts with it, on a version whose test passed.</p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Skills (60.11 AC5)

/** A skill's state in one app, in a word or two; `on` is whether the skill is meant for that app. */
export function skillStateWords(state: SkillStateName | undefined, app: Pick<SkillsAppView, 'supported' | 'format'> | undefined, on: boolean): string {
  if (!on && state !== 'exposed') return 'Off'
  if (app === undefined || !app.supported) return 'Not yet'
  switch (state) {
    case 'current': return app.format === 'copy' ? 'Copied' : 'Linked'
    case 'read-directly': return 'Reads it'
    case 'missing': return 'Missing'
    case 'exposed': return 'Exposed'
    case 'excluded': return 'Not public'
    case 'unreadable': return "Can't read"
    case undefined: return 'Not yet'
    default: return 'Differs'
  }
}

/** What that word means for this skill and app, as the chip's hint. */
export function skillStateHint(state: SkillStateName | undefined, app: Pick<SkillsAppView, 'harness' | 'supported' | 'kind'> | undefined, on: boolean, name: string): string {
  if (state === 'exposed') return `${name} can see this skill but may not have it`
  if (!on) return `Not for ${name}`
  if (app === undefined || !app.supported) return `Skills are not supported yet in ${name}: run its test on Health`
  switch (state) {
    case 'current': return `${name} has it`
    case 'read-directly': return `${name} reads the skills folder itself`
    case 'missing': return `Not in ${name} yet: Install… adds it`
    case 'excluded': return `${name} gets public skills only`
    case 'unreadable': return 'BMN cannot read this skill'
    case undefined: return `Not checked in ${name}`
    default: return `${name} holds something else under this name: Install… shows it`
  }
}

/** An app's last skills test, or why its skills are not supported yet. */
export function skillsTestLine(app: Pick<SkillsAppView, 'supported' | 'version' | 'test' | 'listing' | 'loading' | 'kind' | 'testable' | 'testing'>): string {
  if (app.testing === true) return `BMN is testing ${app.version ?? 'the new version'}…`
  if (!app.supported) {
    if (app.version === null) return 'The app is not found'
    if (!app.testable) return 'BMN has no test for this app'
    const last = app.test !== null && app.test.version === app.version ? app.test.outcome : null
    return last === 'fail' ? `The test failed on ${app.version}` : last === 'inconclusive' ? `The test was inconclusive on ${app.version}` : `Not tested on ${app.version}`
  }
  // Two tests, each named for what it shows: a listing sends no prompt, a loading test sends one. A listing never reads as loading.
  if (app.kind !== 'full') return 'No loading test'
  const words = (label: string, test: NonNullable<SkillsAppView['loading']>): string => `${label} ${TEST_WORDS[test.outcome].toLowerCase()} ${shortDate(test.at)}${test.stale ? ' · stale' : ''}`
  if (app.loading !== null) return words('Loading test', app.loading)
  return app.listing === null ? 'Loading never tested' : `${words('Listing test', app.listing)} · loading never tested`
}

function SkillRow(props: { skill: SkillView; apps: readonly SkillsAppView[]; team: TeamState; busy: boolean }): React.JSX.Element {
  const { skill, team } = props
  const data = team.data
  const mark = skillMark(data ?? {}, skill.name)
  const scoped = ROSTER_HARNESSES.filter((harness) => skillForApp(mark, harness))
  const locked = data === null || !skill.readable || props.busy
  return (
    <div className="skill-row" data-skill={skill.name}>
      <div className="skill-name">
        <b className="mono">{skill.name}</b>
        <span className="faint" title={skill.readable ? skill.description : undefined}>{skill.readable ? skill.description || 'No description' : skill.detail ?? 'Cannot be read'}</span>
      </div>
      <span className="skill-public">
        <span className="faint">Public</span>
        <Switch label={`${skill.name} is public`} on={mark.public === true} disabled={locked} onChange={(next) => { if (data) team.stage(setSkillPublic(data, skill.name, next)) }} />
      </span>
      <span className="chips" role="group" aria-label={`Apps that get ${skill.name}`}>
        <span className="faint scope-word">{mark.only === undefined ? 'All apps' : 'Only'}</span>
        {ROSTER_HARNESSES.map((harness) => {
          const app = props.apps.find((entry) => entry.harness === harness)
          const on = skillForApp(mark, harness)
          const state = skill.states[harness]
          const name = ROSTER_APP_NAMES[harness]
          const words = skillStateWords(state, app, on)
          const last = on && scoped.length === 1
          return (
            <button key={harness} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} aria-label={`${skill.name} in ${name}: ${words}`} disabled={locked || last}
              title={last ? 'A skill needs at least one app' : skillStateHint(state, app, on, name)} onClick={() => { if (data) team.stage(toggleSkillApp(data, skill.name, harness)) }}>
              {state === 'exposed' ? <Dot label="Needs you" /> : null}{name}<span className="chip-state">{words}</span>
            </button>
          )
        })}
      </span>
    </div>
  )
}

function SkillsPage(props: { rules: RulesState; team: TeamState }): React.JSX.Element {
  const { rules, team } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.skills
  const pending = rules.pending
  const idle = !rules.busy && pending === null
  const installs = snapshot.transactions.filter((entry) => entry.reason === SKILLS_INSTALL)
  const count = view.skills.length
  const top = useHealthRule<HTMLDivElement>(rules)
  return (
    <>
      <PageHead title="Skills" status={view.source.readable ? `${count} skill${count === 1 ? '' : 's'}` : 'The skills folder cannot be read'}>
        {view.pending > 0 ? (
          <>
            <Dot label="Needs you" />
            <span className="muted">{view.pending} to install</span>
            <button type="button" className={pending?.kind === 'skills' ? undefined : 'primary'} disabled={!idle} onClick={() => void rules.beginSkillsInstall()}>Install…</button>
          </>
        ) : null}
      </PageHead>
      <Notice rules={rules} />
      {pending?.kind === 'skills' ? <PendingSheet rules={rules} /> : null}
      <div className="editor-head">
        <span className="faint mono" title={view.source.path}>{displayPath(view.source.path, snapshot.home)}</span>
        <span className="faint">· one folder per skill, each with a SKILL.md</span>
      </div>
      {view.source.readable ? null : <p className="preferences-error" role="alert">{view.source.detail ?? 'The skills folder cannot be read'}</p>}
      {view.exposed > 0 ? (
        <p className="page-note" role="status"><Dot label="Needs you" />{view.exposed === 1 ? 'One skill can be seen by an app that may not have it.' : `${view.exposed} skills can be seen by an app that may not have them.`} Mark the skill Public, or move it out of the skills folder.</p>
      ) : null}
      <div className="skill-rows" ref={top}>
        {view.skills.map((skill) => <SkillRow key={skill.name} skill={skill} apps={view.apps} team={team} busy={rules.busy} />)}
      </div>
      {count === 0 && view.source.readable ? <p className="preferences-help">No skills in this folder yet.</p> : null}
      {view.markedMissing.length > 0 ? <p className="preferences-help">The team marks {named(view.markedMissing)}, which the folder does not hold.</p> : null}
      <p className="preferences-help">A skill reaches every app unless you keep it to some. An app that gets public work only receives just the skills you mark Public. A change here takes effect once you approve it; Install… then updates each app.</p>

      <details className="advanced">
        <summary>Earlier installs</summary>
        {installs.length === 0 ? <p className="preferences-help">Nothing yet. Every skills install is kept here.</p> : null}
        {installs.map((entry) => (
          <div key={entry.id} className="list-line">
            <div><b>{entry.valid ? 'Installed' : 'An install that cannot be read'}</b> <span className="line-detail">{shortDate(entry.createdAt)}{entry.targets?.length ? ` · ${entry.targets.map(appDisplayName).join(', ')}` : ''}{entry.valid && entry.state !== 'complete' ? ' · did not finish' : ''}</span></div>
            <button type="button" className="small" disabled={!idle || !entry.valid} aria-label={`Undo the skills install of ${shortDate(entry.createdAt)}`} onClick={() => void rules.beginUndo(entry.id)}>Undo install…</button>
          </div>
        ))}
        {pending?.kind === 'undo' ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

/** Rules › Health › Skills: one row per app (60.11 AC5). */
function SkillsHealth(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.skills
  return (
    <>
      <h4 className="group-head">Skills<span className="caption">where each app reads skills, and whether it has the ones it may have</span></h4>
      {view.source.readable ? null : <p className="preferences-error" role="alert">{view.source.detail ?? 'The skills folder cannot be read'}</p>}
      {view.apps.map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const idle = !rules.busy && action === null && rules.pending === null
        const needs = app.supported && app.state !== 'Linked' && app.state !== 'Copied' && app.state !== 'Reads the source'
        return (
          <div key={app.harness} className="skills-block">
            <div className="health-row" data-skills={app.state}>
              <span>{name}</span>
              <span className="health-state">
                {app.location !== null ? <span className="path mono" title={app.location}>{displayPath(app.location, snapshot.home)}</span>
                  : <span className={app.supported ? undefined : 'faint'}>{app.supported ? 'The skills folder itself' : 'Not known yet'}</span>}
                {app.location !== null && app.readsSource ? <span className="faint">Also reads the skills folder itself</span> : null}
              </span>
              <span className="health-state">
                <span title={app.reason}>{needs ? <Dot label="Needs you" /> : null}{app.state}{app.supported ? <span className="muted"> · {app.kind === 'full' ? 'Full' : 'Public skills only'}</span> : null}</span>
                <span className="faint" title={app.loading?.detail ?? app.listing?.detail ?? app.test?.detail}>{skillsTestLine(app)}</span>
              </span>
              <span className="app-actions">
                <button type="button" className="small" disabled={!idle || !app.testable || app.version === null} aria-label={`Skills test for ${name}`}
                  title={app.testable ? undefined : `BMN has no way to ask ${name} which skills it sees`} onClick={() => props.setAction({ kind: 'skills-test', harness: app.harness })}>Test…</button>
                {app.supported && app.kind === 'full' ? (
                  <button type="button" className="small" disabled={!idle || !app.loadTestable} aria-label={`Skill loading test for ${name}`}
                    title={app.loadTestable ? undefined : `BMN cannot yet tell ${name} handing a skill to its model from the model reading the file itself`}
                    onClick={() => props.setAction({ kind: 'skills-loading-test', harness: app.harness })}>Loading test…</button>
                ) : null}
              </span>
            </div>
            {action?.kind === 'skills-test' && action.harness === app.harness ? (
              <Sheet title={`Test where ${name} reads skills`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} in an empty home folder that holds only test skills and asks which it sees; BMN sends no prompt and no sign-in is there.${app.kind === 'full' ? ` Then puts one empty test skill where ${name} keeps its skills, asks again, and removes it.` : ''} The result is kept for this version.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testSkills(app.harness)).then(() => props.setAction(null))} />
            ) : null}
            {action?.kind === 'skills-loading-test' && action.harness === app.harness ? (
              <Sheet title={`Test whether ${name} loads a skill`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Puts one test skill where ${name} keeps its skills, starts ${name} once in an empty folder and sends one prompt that calls the skill by name. The prompt goes to ${name}'s provider with whatever ${name} adds to every prompt; the test skill holds nothing of yours and is removed afterwards. It passes only when the skill's own words come back and no tool can have read the file.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testSkillsLoading(app.harness)).then(() => props.setAction(null))} />
            ) : null}
          </div>
        )
      })}
      <p className="preferences-help">Nothing is written for an app until its test passed on the installed version. Skills inside a project folder, and sessions already running, are outside what BMN installs.</p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Tools (60.12 AC6)

const PROPOSAL_WORDS: Readonly<Record<ToolProposalView['state'], string>> = {
  ready: 'will be added', secret: 'will be added without the value it holds', known: 'already on your list', conflict: 'the apps differ, so it is not added', unreadable: 'cannot be read, so it is not added'
}

/** Add tool and Edit: plain rows. What they describe is staged like any team change, and reaches no app before it is approved and installed. */
export function ToolEditor(props: { data: RosterDataShape; start: ToolDraft; onDone(next: RosterDataShape | null): void }): React.JSX.Element {
  const [draft, setDraft] = useState(props.start)
  const [tried, setTried] = useState(false)
  const kindId = useId()
  const scopeId = useId()
  const set = (patch: Partial<ToolDraft>): void => setDraft((now) => ({ ...now, ...patch }))
  const result = toolFrom(draft, props.data)
  const errors = tried ? result.errors ?? {} : {}
  const adding = draft.editing === null
  const title = adding ? 'Add a tool' : `Edit ${props.start.name}`
  const save = (): void => {
    if (result.tool === undefined) setTried(true)
    else props.onDone(setTool(props.data, result.tool))
  }
  const toggle = <Value extends string>(list: readonly Value[], value: Value): Value[] => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value])
  return (
    <div className="sheet tool-editor" role="group" aria-label={title}>
      <div className="sheet-head"><b>{title}</b><span className="muted">Nothing changes until you approve it.</span></div>
      <Row label="Name" hint={errors.name}>
        <input className="field" autoFocus aria-label="Tool name" aria-invalid={errors.name !== undefined} maxLength={40} value={draft.name}
          onChange={(event) => {
            const name = event.currentTarget.value
            // The id follows the name until the owner types one of their own.
            set(adding && draft.id === idFromName(draft.name) ? { name, id: idFromName(name) } : { name })
          }} />
      </Row>
      <Row label="Id" hint={errors.id ?? (adding ? "The name its entry carries in each app's settings." : 'An id stays as it is: for another, add the tool again and remove this one.')}>
        <input className="field mono" aria-label="Tool id" aria-invalid={errors.id !== undefined} disabled={!adding} maxLength={40} value={draft.id} onChange={(event) => set({ id: event.currentTarget.value })} />
      </Row>
      <Row label="It is" id={kindId}>
        <Segmented<ToolDraft['kind']> labelledBy={kindId} fit options={['program', 'address']} value={draft.kind} optionLabel={(kind) => (kind === 'program' ? 'A program' : 'An address')} onChange={(kind) => set({ kind })} />
      </Row>
      {draft.kind === 'program' ? (
        <>
          <Row label="Program" hint={errors.command}>
            <input className="field mono" aria-label="Program" aria-invalid={errors.command !== undefined} placeholder="npx" maxLength={400} value={draft.command} onChange={(event) => set({ command: event.currentTarget.value })} />
          </Row>
          <Row label="Arguments" hint={errors.args ?? 'One per line. $NAME takes the value of that environment variable.'}>
            <textarea className="field wide mono" aria-label="Arguments" aria-invalid={errors.args !== undefined} rows={3} value={draft.args} onChange={(event) => set({ args: event.currentTarget.value })} />
          </Row>
          <Row label="Variables" hint={errors.env ?? 'Environment variables the program needs, one name per line; NAME=OTHER when yours is named differently. Never a value.'}>
            <textarea className="field wide mono" aria-label="Variables" aria-invalid={errors.env !== undefined} rows={2} value={draft.env} onChange={(event) => set({ env: event.currentTarget.value })} />
          </Row>
        </>
      ) : (
        <>
          <Row label="Address" hint={errors.url}>
            <input className="field mono" aria-label="Address" aria-invalid={errors.url !== undefined} placeholder="https://" maxLength={400} value={draft.url} onChange={(event) => set({ url: event.currentTarget.value })} />
          </Row>
          <Row label="Headers" hint={errors.headers ?? 'One per line: Header=VARIABLE, the environment variable that holds it. Never a value.'}>
            <textarea className="field wide mono" aria-label="Headers" aria-invalid={errors.headers !== undefined} rows={2} value={draft.headers} onChange={(event) => set({ headers: event.currentTarget.value })} />
          </Row>
        </>
      )}
      <Row label="For" id={scopeId} hint={errors.scope ?? (draft.scope === 'agents' ? "Only these agents' runs get it. No app keeps it in its settings." : undefined)}>
        <Segmented<ToolScope> labelledBy={scopeId} fit options={['all', 'apps', 'agents']} value={draft.scope} optionLabel={(scope) => SCOPE_WORDS[scope]} onChange={(scope) => set({ scope })} />
        {draft.scope === 'apps' ? (
          <span className="chips" role="group" aria-label="Apps that get it">
            {ROSTER_HARNESSES.map((harness) => (
              <button key={harness} type="button" className={draft.apps.includes(harness) ? 'chip on' : 'chip'} aria-pressed={draft.apps.includes(harness)} onClick={() => set({ apps: toggle(draft.apps, harness) })}>{ROSTER_APP_NAMES[harness]}</button>
            ))}
          </span>
        ) : null}
        {draft.scope === 'agents' ? (
          <span className="chips" role="group" aria-label="Agents whose runs get it">
            {props.data.agents.map((agent) => (
              <button key={agent.id} type="button" className={draft.agents.includes(agent.id) ? 'chip on' : 'chip'} aria-pressed={draft.agents.includes(agent.id)} onClick={() => set({ agents: toggle(draft.agents, agent.id) })}>{agent.name}</button>
            ))}
          </span>
        ) : null}
      </Row>
      <Row label="Public" hint="An app that gets public work only may have it.">
        <Switch label="The tool is public" on={draft.public} onChange={(next) => set({ public: next })} />
      </Row>
      <div className="inline">
        <button type="button" className="primary" onClick={save}>{adding ? 'Add tool' : 'Done'}</button>
        <button type="button" onClick={() => props.onDone(null)}>Cancel</button>
      </div>
    </div>
  )
}

/** From your apps…: the entries the apps already hold, and which of them would join the list. */
export function ToolProposals(props: { found: readonly ToolProposalView[]; data: RosterDataShape | null; onAdd(tools: RosterToolShape[]): void; onCancel(): void }): React.JSX.Element {
  const { found } = props
  const fresh = props.data === null ? [] : addable(found, props.data)
  return (
    <Sheet title={fresh.length === 0 ? 'Nothing new in your apps' : `Add ${fresh.length} tool${fresh.length === 1 ? '' : 's'} from your apps`} action="Add to your list" busy={false} ready={fresh.length > 0}
      note={fresh.length === 0 ? undefined : 'Each is kept to the apps that hold it now. Nothing changes until you approve it.'}
      onConfirm={() => props.onAdd(fresh)} onCancel={props.onCancel}>
      {found.length === 0 ? <p className="preferences-help">Your apps hold no tool entries.</p> : null}
      {found.map((proposal, index) => (
        <div key={`${proposal.id}:${index}`} className="list-line">
          <div>
            <b className="mono">{proposal.id}</b> <span className="line-detail">{proposal.apps.map((harness) => ROSTER_APP_NAMES[harness]).join(', ')} · {PROPOSAL_WORDS[proposal.state]}</span>
            {proposal.notes.filter((note) => note !== 'already on your list').map((note) => <p key={note} className="preferences-help">{note}</p>)}
          </div>
        </div>
      ))}
    </Sheet>
  )
}

function ToolRow(props: { tool: RosterToolShape; view: ToolView | undefined; apps: readonly ToolsAppView[]; team: TeamState; busy: boolean; onEdit(): void }): React.JSX.Element {
  const { tool, team, view } = props
  const data = team.data
  const scoped = ROSTER_HARNESSES.filter((harness) => toolForApp(tool, harness))
  const locked = data === null || props.busy
  const needs = toolVariables(tool)
  const what = `${transportWords(tool)}${needs.length > 0 ? ` · needs ${needs.join(', ')}` : ''}`
  return (
    <div className="skill-row tool-row" data-tool={tool.id}>
      <div className="skill-name">
        <b>{tool.name}</b>
        <span className="faint mono" title={what}>{what}</span>
      </div>
      <span className="skill-public">
        <span className="faint">Public</span>
        <Switch label={`${tool.name} is public`} on={tool.public === true} disabled={locked} onChange={(next) => { if (data) team.stage(setToolPublic(data, tool.id, next)) }} />
        <button type="button" className="small" disabled={locked} aria-label={`Edit ${tool.name}`} onClick={props.onEdit}>Edit</button>
        <button type="button" className="small" disabled={locked} aria-label={`Remove ${tool.name}`} title="Takes it off your list; approve to keep that" onClick={() => { if (data) team.stage(removeTool(data, tool.id)) }}>Remove</button>
      </span>
      {tool.agents !== undefined ? (
        <span className="chips" role="group" aria-label={`Agents whose runs get ${tool.name}`}>
          <span className="faint scope-word">Runs of</span>
          {tool.agents.map((id) => {
            const last = tool.agents?.length === 1
            const name = data?.agents.find((agent) => agent.id === id)?.name ?? id
            return (
              <button key={id} type="button" className="chip on" aria-pressed aria-label={`${tool.name} for the runs of ${name}`} disabled={locked || last}
                title={last ? 'A tool kept to agents needs at least one' : `Stop giving it to the runs of ${name}`} onClick={() => { if (data) team.stage(toggleToolAgent(data, tool.id, id)) }}>{name}</button>
            )
          })}
          <span className="faint">in no app's settings</span>
        </span>
      ) : (
        <span className="chips" role="group" aria-label={`Apps that get ${tool.name}`}>
          <span className="faint scope-word">{tool.apps === undefined ? 'All apps' : 'Only'}</span>
          {ROSTER_HARNESSES.map((harness) => {
            const app = props.apps.find((entry) => entry.harness === harness)
            const on = toolForApp(tool, harness)
            const state = view?.states[harness]
            const name = ROSTER_APP_NAMES[harness]
            const words = toolStateWords(state, app, on)
            const last = on && scoped.length === 1
            return (
              <button key={harness} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} aria-label={`${tool.name} in ${name}: ${words}`} disabled={locked || last}
                title={last ? 'A tool needs at least one app' : toolStateHint(state, app, on, name, view?.details[harness])} onClick={() => { if (data) team.stage(toggleToolApp(data, tool.id, harness)) }}>
                {state === 'exposed' || state === 'blocked' || view?.details[harness] !== undefined ? <Dot label="Needs you" /> : null}{name}<span className="chip-state">{words}</span>
              </button>
            )
          })}
        </span>
      )}
      {/* Why an app cannot take the tool, or why its entry there is left alone: said on the page, not only in a hint. */}
      {tool.agents === undefined ? ROSTER_HARNESSES.flatMap((harness) => {
        const detail = view?.details[harness]
        return detail === undefined ? [] : [<p key={harness} className="preferences-help tool-why"><Dot label="Needs you" />In {ROSTER_APP_NAMES[harness]}: {detail}</p>]
      }) : null}
    </div>
  )
}

function ToolsPage(props: { rules: RulesState; team: TeamState }): React.JSX.Element {
  const { rules, team } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.tools
  const pending = rules.pending
  const data = team.data
  const tools = data?.tools ?? []
  const [editor, setEditor] = useState<ToolDraft | null>(null)
  const [found, setFound] = useState<ToolProposalView[] | null>(null)
  const [looking, setLooking] = useState(false)
  const idle = !rules.busy && pending === null && editor === null && found === null
  const installs = snapshot.transactions.filter((entry) => entry.reason === TOOLS_INSTALL)
  const count = tools.length
  const top = useHealthRule<HTMLDivElement>(rules)
  // Entries the apps hold that are not on the list, each id once with the apps that hold it.
  const others = new Map<string, { apps: RosterHarness[]; exposed: boolean }>()
  for (const app of view.apps) {
    // One the owner has just added to the list is no longer "not on it", approved or not.
    for (const entry of app.unlisted.filter((row) => !row.managed && !tools.some((tool) => tool.id === row.id))) {
      const row = others.get(entry.id) ?? { apps: [], exposed: false }
      others.set(entry.id, { apps: [...row.apps, app.harness], exposed: row.exposed || entry.state === 'exposed' })
    }
  }
  const look = async (): Promise<void> => {
    setLooking(true)
    try {
      const result = await window.aiTerminal.proposeTools()
      if (result.ok) setFound(result.proposals)
      else rules.setNotice({ ok: false, text: result.message ?? "The apps' settings could not be read" })
    } catch (error) {
      rules.setNotice({ ok: false, text: failureDetail(error, "The apps' settings could not be read") })
    } finally {
      setLooking(false)
    }
  }
  return (
    <>
      <PageHead title="Tools" status={`${count} tool${count === 1 ? '' : 's'}`}>
        {view.pending > 0 ? (
          <>
            <Dot label="Needs you" />
            <span className="muted">{view.pending} to install</span>
            <button type="button" className={pending?.kind === 'tools' ? undefined : 'primary'} disabled={!idle} onClick={() => void rules.beginToolsInstall(false)}>Install…</button>
          </>
        ) : null}
      </PageHead>
      <Notice rules={rules} />
      {pending?.kind === 'tools' ? <PendingSheet rules={rules} /> : null}
      {view.error ? <p className="preferences-error" role="alert">{view.error}</p> : null}
      {view.exposed > 0 ? (
        <p className="page-note" role="status"><Dot label="Needs you" />{view.exposed === 1 ? 'One tool is in an app that may not have it.' : `${view.exposed} tools are in apps that may not have them.`} Mark the tool Public, or remove its entry in that app.</p>
      ) : null}
      <div className="skill-rows" ref={top}>
        {tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} view={view.tools.find((entry) => entry.id === tool.id)} apps={view.apps} team={team} busy={rules.busy || editor !== null}
            onEdit={() => setEditor(draftFrom(tool))} />
        ))}
      </div>
      {count === 0 ? <p className="preferences-help">No tools on your list yet.</p> : null}
      {editor !== null && data !== null ? <ToolEditor key={editor.editing ?? 'new'} data={data} start={editor} onDone={(next) => { setEditor(null); if (next) team.stage(next) }} /> : null}
      {found !== null ? <ToolProposals found={found} data={data} onAdd={(tools) => { if (data) team.stage(withProposals(data, tools)); setFound(null) }} onCancel={() => setFound(null)} /> : null}
      {editor === null && found === null ? (
        <div className="inline tool-actions">
          <button type="button" disabled={data === null || !idle || count >= MAX_TOOLS} onClick={() => setEditor(EMPTY_DRAFT)}>Add tool</button>
          <button type="button" disabled={data === null || !idle || looking} onClick={() => void look()}>{looking ? 'Reading…' : 'From your apps…'}</button>
        </div>
      ) : null}
      {others.size > 0 ? (
        <>
          <h4 className="group-head">In your apps, not on your list<span className="caption">BMN did not write these and leaves them</span></h4>
          {[...others.entries()].map(([id, row]) => (
            <div key={id} className="list-line" data-unlisted={id}>
              <div><b className="mono">{id}</b> <span className="line-detail">{row.exposed ? <Dot label="Needs you" /> : null}{row.apps.map((harness) => ROSTER_APP_NAMES[harness]).join(', ')}{row.exposed ? ' · in an app that gets public work only' : ''}</span></div>
            </div>
          ))}
          <div className="inline tool-actions">
            <button type="button" className="small" disabled={!idle} onClick={() => void rules.beginToolsInstall(true)}>Remove them from the apps…</button>
          </div>
        </>
      ) : null}
      <p className="preferences-help">A tool names environment variables and never holds their values. It reaches every app unless you keep it to some apps, or to the runs of some agents. A change here takes effect once you approve it; Install… then updates each app's settings.</p>

      <details className="advanced">
        <summary>Earlier installs</summary>
        {installs.length === 0 ? <p className="preferences-help">Nothing yet. Every tools install is kept here.</p> : null}
        {installs.map((entry) => (
          <div key={entry.id} className="list-line">
            <div><b>{entry.valid ? 'Installed' : 'An install that cannot be read'}</b> <span className="line-detail">{shortDate(entry.createdAt)}{entry.targets?.length ? ` · ${entry.targets.map(appDisplayName).join(', ')}` : ''}{entry.valid && entry.state !== 'complete' ? ' · did not finish' : ''}</span></div>
            <button type="button" className="small" disabled={!idle || !entry.valid} aria-label={`Undo the tools install of ${shortDate(entry.createdAt)}`} onClick={() => void rules.beginUndo(entry.id)}>Undo install…</button>
          </div>
        ))}
        {pending?.kind === 'undo' ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

/** Rules › Health › Tools: one row per app (60.12 AC6). */
function ToolsHealth(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.tools
  return (
    <>
      <h4 className="group-head">Tools<span className="caption">where each app keeps its tools, and whether it has the ones it may have</span></h4>
      {view.error ? <p className="preferences-error" role="alert">{view.error}</p> : null}
      {view.apps.map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const idle = !rules.busy && action === null && rules.pending === null
        const needs = app.supported && app.state !== 'Set up' && app.state !== 'None'
        return (
          <div key={app.harness} className="skills-block">
            <div className="health-row" data-tools={app.state}>
              <span>{name}</span>
              <span className="health-state">
                <span className="path mono" title={app.path}>{displayPath(app.path, snapshot.home)}</span>
                {app.link !== undefined ? <span className="faint" title={app.link}>A link: BMN does not write through it</span>
                  : app.readable ? null : <span className="faint" title={app.detail}>BMN cannot read it</span>}
              </span>
              <span className="health-state">
                <span title={app.reason}>{needs ? <Dot label="Needs you" /> : null}{app.state}{app.supported ? <span className="muted"> · {app.kind === 'full' ? 'Full' : 'Public tools only'}</span> : null}</span>
                <span className="faint" title={app.test?.detail}>{toolsTestLine(app, shortDate)}</span>
              </span>
              <span className="app-actions">
                <button type="button" className="small" disabled={!idle || app.version === null} aria-label={`Tools test for ${name}`} onClick={() => props.setAction({ kind: 'tools-test', harness: app.harness })}>Test…</button>
              </span>
            </div>
            {action?.kind === 'tools-test' && action.harness === app.harness ? (
              <Sheet title={`Test where ${name} keeps its tools`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} in an empty home folder with no sign-in, so no prompt can be answered there. BMN writes one stand-in tool into its settings file, asks ${name} which tools it sees${app.harness === 'claude' ? ', starts it three more times to see which tools a run begins with' : ''}, and removes the folder. The result is kept for this version.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testTools(app.harness)).then(() => props.setAction(null))} />
            ) : null}
          </div>
        )
      })}
      <p className="preferences-help">Nothing is written for an app until its test passed on the installed version. Tools inside a project folder, and sessions already running, are outside what BMN installs.</p>
    </>
  )
}

/**
 * Health's rule, for each page that shows what BMN reads from this machine: Health, Skills and Tools (Story 75.7 takes
 * their Check now away). What such a page shows is read again when the owner comes back: on opening the page after a
 * while, when the window gets the focus while the page is on screen, and after an update command BMN typed has ended.
 * Never under an unsaved draft or an open confirmation. Returns the ref of an element on the page, by which BMN tells that the page is on screen.
 */
function useHealthRule<T extends HTMLElement>(rules: RulesState): React.RefObject<T | null> {
  const top = useRef<T | null>(null)
  const { load, began } = rules
  const checkedAt = (rules.snapshot as RulesSnapshot).health.checkedAt
  const calm = rules.pending === null && !rules.dirty
  const quiet = !rules.busy && calm
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
  // And once a command BMN typed for an update has ended: what is shown was read before that, perhaps while it still ran.
  // Judged by when the read shown began, so one that began before the end and came back after it is read again (63.4 AC2);
  // asked for also while a read is under way, whose answer is then dropped for the one begun after the end.
  // Once for each end, so a read that fails is not asked for again and again.
  const [endedAt, setEndedAt] = useState(updateEndedAt)
  useEffect(() => {
    const heard = (): void => setEndedAt(updateEndedAt)
    const stop = onUpdateEnded(heard)
    heard()
    return stop
  }, [])
  const readAfter = useRef<number | null>(null)
  useEffect(() => {
    if (!calm || endedAt === readAfter.current || !endedSince(began, endedAt)) return
    readAfter.current = endedAt
    void load()
  }, [calm, endedAt, began, load])
  return top
}

function HealthPage(props: { rules: RulesState; team: TeamState; recognised: RecognisedSessions; onRun?: RunInSession | undefined }): React.JSX.Element {
  const { rules, team, onRun: runInSession } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const [action, setAction] = useState<AppAction | null>(null)
  // Apps whose before-and-now line was shown on this visit: said once, their watch ends when the owner leaves Health.
  const told = useRef(new Set<RosterHarness>())
  useEffect(() => {
    const shown = told.current
    return () => forgetUpdateWatches(shown)
  }, [])
  const top = useHealthRule<HTMLHeadingElement>(rules)
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
  const skillsCount = [
    ...(snapshot.skills.pending > 0 ? [`${snapshot.skills.pending} skill entr${snapshot.skills.pending === 1 ? 'y' : 'ies'} to install`] : []),
    ...(snapshot.skills.exposed > 0 ? [`${snapshot.skills.exposed} skill${snapshot.skills.exposed === 1 ? '' : 's'} exposed`] : []),
    ...(snapshot.tools.pending > 0 ? [`${snapshot.tools.pending} tool entr${snapshot.tools.pending === 1 ? 'y' : 'ies'} to install`] : []),
    ...(snapshot.tools.exposed > 0 ? [`${snapshot.tools.exposed} tool${snapshot.tools.exposed === 1 ? '' : 's'} exposed`] : [])
  ].join(' · ')
  return (
    <>
      <PageHead title="Health" status={rules.busy && pending === null ? 'Checking…' : `Checked ${shortDate(health.checkedAt)}${skillsCount === '' ? '' : ` · ${skillsCount}`}`} />
      <Notice rules={rules} />
      {notHeldWords(snapshot.readOnlyRoles) === null ? null : <p className="page-note" role="status"><Dot label="Needs you" />{notHeldWords(snapshot.readOnlyRoles)}</p>}
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
                // An update BMN starts is watched afresh, and what it reports afterwards is said even where an earlier line was shown on this visit.
                onRun={runInSession ? (session, command, left) => {
                  watchUpdate(app, health.checkedAt, true)
                  told.current.delete(app.harness)
                  return runInSession(session, command, updateRunEnded, left)
                } : undefined}
                onClose={() => setAction(null)} />
            ) : reports !== null ? <p className="app-note" role="status">{reports}</p> : null}
          </div>
        )
      })}
      <p className="preferences-help">Tested versions are the ones BMN was checked against. Every installed version is supported: BMN works out where an app sends data the same way on each and notes the version with every check.</p>

      <SkillsHealth rules={rules} action={action} setAction={setAction} />

      <ToolsHealth rules={rules} action={action} setAction={setAction} />

      <ContextLimits rules={rules} action={action} setAction={setAction} />
    </>
  )
}

export function RulesPreferences(props: {
  rules: RulesState; team: TeamState; page: RulesPage; recognised?: RecognisedSessions
  /** Opens a new shell session and runs `command` there; Health offers it for an app's update command. */
  onRunInSession?: RunInSession | undefined
}): React.JSX.Element {
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
  const title = props.page === 'editor' ? 'Rules' : props.page === 'skills' ? 'Skills' : props.page === 'tools' ? 'Tools' : 'Health'
  if (rules.loadError && rules.snapshot === null) return <><PageHead title={title} /><p className="preferences-error" role="alert">{rules.loadError}</p></>
  if (rules.snapshot === null) return <><PageHead title={title} /><p className="page-note">Reading the rules…</p></>
  if (props.page === 'skills') return <SkillsPage rules={rules} team={props.team} />
  if (props.page === 'tools') return <ToolsPage rules={rules} team={props.team} />
  return props.page === 'editor' ? <EditorPage rules={rules} /> : <HealthPage rules={rules} team={props.team} recognised={props.recognised ?? {}} onRun={props.onRunInSession} />
}
