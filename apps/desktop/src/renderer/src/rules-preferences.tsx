// MODULE: rules-preferences.tsx - Epic 60.6: Preferences › Integrations: the master editor with what each app reads, install and earlier versions; Skills and Tools with each one's apps and state; Health with each rules file and agent app
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { takesPress, type CommandPress, type CommandStart, type RunInSession } from './session-command'
import {
  RETIRED_APP_LINE,
  ROSTER_APP_NAMES,
  ROSTER_APP_UPDATE_ARGUMENTS,
  ROSTER_HARNESSES,
  appDisplayName,
  named,
  type AgentAppView,
  type ContextAgentLimit,
  type ContextLimitApp,
  type ContextLimitPlan,
  type ContextLimitView,
  type HookAppAtStart,
  type HookLeftWhy,
  type HooksAtStart,
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
  type RulesSavePlan,
  type RulesSnapshot,
  type RulesTargetHealth,
  type RulesTargetState,
  type SkillStateName,
  type SkillView,
  type SkillsAppView,
  type RosterToolShape,
  type ToolProposalView,
  type ToolView,
  type ToolsAppView,
  type ToolsPlan
} from '@bmn/protocol'
import { offersTestAgain, runningWords, stoppedTest, stoppedWords, testRunning } from './auto-test-words'
import { failureDetail } from './bridge-error'
import { createMachineReads, endedSince, type MachineReads } from './machine-reads'
import { Segmented } from './history-preferences'
import { quoteArgv } from './launch-template'
import { Dot } from './roster-marks'
import { DoctorHealth, doctorNeedsCount, useDoctorClock } from './doctor-health'
import { SetupReadiness, useSetupApps, type SetupNavigation } from './first-run-setup'
import { setupAppNeedsAction } from './setup-app-view'
import { PushPolicyHealth } from './push-policy-health'
import { destinationProviders, diffBody, diffSummary, listedRoles, revokeVersion, setDestination, setSkillPublic, skillForApp, skillMark, thousands, toggleSkillApp, undoWords } from './roster-staging'
import { displayPath } from './session-presentation'
import { Issues, NumberField, PageHead, Row, Switch, TargetPath, shortDate } from './team-preferences'
import type { TeamState } from './team-state'
import {
  EMPTY_DRAFT, MAX_TOOLS, SCOPE_WORDS, addable, draftFrom, idFromName, removeTool, setTool, setToolPublic, toggleToolAgent, toggleToolApp, toolForApp, toolFrom, toolStateHint, toolStateWords,
  toolVariables, toolsTestLine, transportWords, withProposals, type ToolDraft, type ToolScope
} from './tools-view'

export { diffSummary, endedSince, undoWords }

type RulesPage = 'editor' | 'skills' | 'tools' | 'health'

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

const KIND_WORDS: Readonly<Record<RulesRenderingKind, string>> = { full: 'Full rules', public: 'Public sections only' }

const STATE_WORDS: Readonly<Record<RulesTargetState, string>> = {
  current: 'Current',
  stale: 'Differs from the rules',
  'edited-outside': 'Edited outside BMN',
  unmanaged: 'Not installed',
  link: 'Link',
  missing: 'Missing',
  unreadable: 'Cannot be read'
}

const TEST_WORDS: Readonly<Record<NonNullable<RulesProbeView['outcome']>, string>> = {
  pass: 'Passed',
  fail: 'Failed',
  inconclusive: 'Inconclusive',
  unavailable: 'Unavailable'
}

/** Said after a test that sent the app's provider one prompt, unlike the checks that send none (Story 75.8 AC2). */
const PROMPT_SENT = ' · one prompt sent'

/** The last loading test in words: its result, date and version, whether BMN ran it by itself, whether the rules or the app changed since, and the prompt it sent. */
export function testLine(test: RulesProbeView | undefined): string {
  if (!test || test.outcome === null) return 'Rules test not run yet'
  const spent = test.outcome === 'unavailable' ? '' : PROMPT_SENT
  return `Rules test ${TEST_WORDS[test.outcome].toLowerCase()} ${shortDate(test.at)}${test.version ? ` on ${test.version}` : ''}${test.by === 'bmn' ? ' · by BMN' : ''}${test.stale ? ' · stale' : ''}${spent}`
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

// The version test BMN has for an app is of where it sends data (its routing), never of the rules or context it loads (Story 96.6).
const VERSION_WORDS: Readonly<Record<AgentAppView['versionState'], string>> = { tested: 'routing-tested', newer: 'newer than routing-tested', other: 'not routing-tested', unknown: 'not checked' }

/** The reason a skills install records, which tells it from a rules install. */
const SKILLS_INSTALL = 'skills install'
/** The reason a tools install records. */
const TOOLS_INSTALL = 'tools install'

/** Saves and installs, newest first, as Earlier versions lists them: a save with Undo…, a version kept from before with Restore…. */
type Earlier =
  | { kind: 'install'; id: string; at: string | undefined; title: string; detail: string; usable: boolean }
  | { kind: 'save'; revision: number; at: string; title: string; detail: string; usable: boolean }

/** The master versions a save, an install or a Team update keeps for itself: its own entry stands for them (Story 75.9). */
const KEPT_BY_TRANSACTION = /^(before )?(save|install|team update) /

export function earlierVersions(snapshot: Pick<RulesSnapshot, 'transactions' | 'history'>): Earlier[] {
  // A skills or tools install is undone on its own page, where it was made.
  const installs: Earlier[] = snapshot.transactions.filter((entry) => entry.reason !== SKILLS_INSTALL && entry.reason !== TOOLS_INSTALL).map((entry) => ({
    kind: 'install', id: entry.id, at: entry.createdAt, usable: entry.valid && (entry.state === 'complete' || entry.state === 'partial'),
    title: !entry.valid ? 'A save that cannot be read' : entry.reason === 'team update' ? 'Team line updated' : entry.master ? 'Saved and installed' : 'Installed',
    detail: (entry.targets ?? []).map(appDisplayName).join(', ')
      + (entry.valid && entry.state === 'partial' ? ' · not every app written' : entry.valid && entry.state !== 'complete' ? ' · did not finish' : '')
  }))
  const saves: Earlier[] = (snapshot.history ?? []).filter((entry) => !KEPT_BY_TRANSACTION.test(entry.reason)).map((entry) => ({
    kind: 'save', revision: entry.revision, at: entry.at, usable: entry.intact, detail: kilobytes(entry.bytes),
    title: !entry.intact ? 'A saved version that cannot be read' : entry.reason.startsWith('undo ') ? 'Put back by Undo' : 'Saved'
  }))
  return [...installs, ...saves].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** Story 75.9: the Rules page's status line, a file BMN could not write first ("Saved Oct 16, 13:38 · Codex not written"). */
export function rulesStatus(snapshot: Pick<RulesSnapshot, 'master' | 'health'>): { text: string; needs: boolean } {
  if (!snapshot.master.exists) return { text: 'No rules yet', needs: false }
  const saved = shortDate(snapshot.master.savedAt ?? undefined)
  const differ = snapshot.health.state === 'checked' ? snapshot.health.targets.filter((target) => target.state !== 'current').map((target) => ROSTER_APP_NAMES[target.harness]) : []
  if (differ.length > 0) return { text: `Saved ${saved} · ${andWords(differ)} not written`, needs: true }
  return { text: `Saved and installed ${saved}`, needs: false }
}

/** "Claude Code, Codex and OpenCode". */
function andWords(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}

/** A rules file in Health in words (Story 75.9): what differs first, with what puts it right. */
export function targetStateWords(state: RulesTargetState): string {
  if (state === 'current' || state === 'unreadable') return STATE_WORDS[state]
  if (state === 'edited-outside') return 'Differs · edited outside BMN · Save the rules to rewrite it'
  if (state === 'stale') return 'Differs from the rules · Save the rules to rewrite it'
  return `${STATE_WORDS[state]} · Save the rules to write it`
}

/** Why BMN left a hook event as it is, in words (Story 75.9). */
const HOOK_LEFT_WORDS: Readonly<Record<HookLeftWhy, string>> = {
  gated: 'inside a matcher', changed: 'changed', foreign: 'not BMN\'s', unreadable: 'the file cannot be read', unparsable: 'the file is not valid JSON',
  unusable: 'not a hook file BMN can add to', numbers: 'holds a number BMN cannot write back unchanged', failed: 'could not be written'
}

/** One app's row in Health › Hooks: whether it needs him, its line, and the faint lines under it, one left entry per line. */
export function hookRowWords(app: HookAppAtStart): { needs: boolean; head: string; lines: string[] } {
  if (app.state === 'not-set-up') return { needs: false, head: 'Not set up on this computer', lines: [] }
  const count = app.placed.length
  const inPlace = `${count} entr${count === 1 ? 'y' : 'ies'} in place`
  const added = app.installed.length > 0 ? [`Added at start: ${app.installed.join(', ')}${app.harness === 'codex' ? ' · Codex asks you once, in /hooks, before it runs them' : ''}`] : []
  // A file upgraded on disk says nothing of what a running OpenCode loaded (Story 96.3): it is woken once its own events carry the new plugin's mark.
  const upgraded = (app.upgraded ?? []).length > 0 ? [`Upgraded at start: ${app.upgraded!.join(', ')} · a running OpenCode is woken only once it reports the new plugin`] : []
  // OpenCode's plugin left in an earlier release (BMN could not write beside it) cannot tell the owner's stop from a finished turn (Story 96.6).
  const obsolete = app.harness === 'opencode' && app.older.includes('plugin') && app.state === 'left'
  const olderNames = obsolete ? app.older.filter((name) => name !== 'plugin') : app.older
  const older = [
    ...(obsolete ? ['Older plugin · stopped turns cannot be distinguished. Automatic wake is unavailable for this session until a qualified plugin is loaded.'] : []),
    ...(olderNames.length === 0 ? [] : app.harness === 'opencode'
      ? [`OpenCode 1's plugin file is still there too · \`bmn hooks install opencode\` removes it`]
      : [`${olderNames.join(', ')} · in an older wording, which does the same and still runs`])
  ]
  const leftWords = (entry: HookAppAtStart['left'][number]): string => app.harness === 'opencode' && entry.event === 'plugin' && (entry.why === 'changed' || entry.why === 'foreign')
    ? `plugin · ${HOOK_LEFT_WORDS[entry.why]} · Not BMN's · BMN leaves it` : `${entry.event} · ${HOOK_LEFT_WORDS[entry.why]}`
  if (app.why !== undefined) return { needs: true, head: `The file · ${HOOK_LEFT_WORDS[app.why]} · left as it is`, lines: older }
  if (app.left.length === 0) return { needs: obsolete, head: inPlace, lines: [...added, ...upgraded, ...older] }
  return {
    needs: true, head: `${inPlace} · ${app.left.length === 1 ? 'one left as it is' : `${app.left.length} left as they are`}`,
    lines: [...app.left.map(leftWords), ...added, ...upgraded, ...older]
  }
}


// Which Health rows carry the Needs-you dot, one test per section: the rows and the page status count alike (Story 75.10).
/** A rules file: not current, or its loading test offers Test again. */
function rulesRowState(snapshot: RulesSnapshot, target: RulesTargetHealth): { again: boolean; needs: boolean } {
  const test = snapshot.probes.find((entry) => entry.harness === target.harness)
  const again = target.kind === 'full' && offersTestAgain(snapshot.autoTests, 'rules', target.harness, test?.outcome === 'fail' && test.stale !== true)
  return { again, needs: target.state !== 'current' || again }
}

/** An app's skills: not as it may be, or a listing or loading test offers Test again. */
function skillsRowState(snapshot: RulesSnapshot, app: SkillsAppView): { again: boolean; loadAgain: boolean; needs: boolean } {
  const again = offersTestAgain(snapshot.autoTests, 'skills', app.harness, skillsFailed(app, 'skills'))
  const loadAgain = app.supported && app.kind === 'full' && offersTestAgain(snapshot.autoTests, 'skills-loading', app.harness, skillsFailed(app, 'skills-loading'))
  const off = app.supported && app.state !== 'Linked' && app.state !== 'Copied' && app.state !== 'Reads the source'
  return { again, loadAgain, needs: off || again || loadAgain }
}

/** An app's tools: not as they may be, or its tools test offers Test again. */
function toolsRowState(snapshot: RulesSnapshot, app: ToolsAppView): { again: boolean; needs: boolean } {
  const again = offersTestAgain(snapshot.autoTests, 'tools', app.harness, app.test !== null && app.test.version === app.version && app.test.outcome === 'fail')
  return { again, needs: (app.supported && app.state !== 'Set up' && app.state !== 'None') || again }
}

/** An app's context limit: its setting cannot be read, or an agent's limit is not applied. */
function contextRowNeeds(row: ContextLimitView): boolean {
  return row.unreadable !== undefined || row.limits.some((entry) => entry.state !== 'applied')
}

/** A Health section's rows with those that need the owner first, the rest in their order. */
export function needsFirst<Row>(rows: readonly Row[], needs: (row: Row) => boolean): Row[] {
  return [...rows].sort((a, b) => Number(needs(b)) - Number(needs(a)))
}

type SteadyOrder = <Row extends { harness: string }>(section: string, rows: readonly Row[], needs: (row: Row) => boolean) => Row[]
const SteadyOrderContext = createContext<SteadyOrder>((_section, rows, needs) => needsFirst(rows, needs))

/**
 * Story 96.6 AC2: while the pointer is over Health, a refresh keeps each section's rows where they were (a row new to it
 * goes last), so nothing moves under it; with the pointer elsewhere the rows that need the owner come first.
 */
function useSteadyOrder(top: RefObject<HTMLElement | null>): SteadyOrder {
  const orders = useRef(new Map<string, string[]>())
  return useCallback(<Row extends { harness: string },>(section: string, rows: readonly Row[], needs: (row: Row) => boolean): Row[] => {
    const before = orders.current.get(section)
    const hovered = top.current?.closest('.preferences-main')?.matches(':hover') ?? false
    const rank = (row: Row): number => { const at = before?.indexOf(row.harness) ?? -1; return at < 0 ? Number.MAX_SAFE_INTEGER : at }
    const sorted = hovered && before !== undefined ? [...rows].sort((a, b) => rank(a) - rank(b)) : needsFirst(rows, needs)
    orders.current.set(section, sorted.map((row) => row.harness))
    return sorted
  }, [top])
}

/**
 * What in Health needs the owner (Story 96.6): one issue per section row (one app, one area), and each Doctor finding
 * that is not the same app and area as such a row. `keys` are those rows as `area:app`, for Doctor to merge into;
 * `sections` names the sections with an issue, in page order, for the head: "Read 13:39 · 2 need you: Hooks, Tools".
 */
export function healthNeeds(snapshot: RulesSnapshot): { count: number; sections: string[]; keys: Set<string> } {
  const keys = new Set<string>()
  const found: Array<[string, number]> = []
  const rows = <Row,>(section: string, area: string | null, list: readonly Row[], needs: (row: Row) => boolean, app: (row: Row) => string): void => {
    const needing = list.filter(needs)
    if (area !== null) for (const row of needing) keys.add(`${area}:${app(row)}`)
    if (needing.length > 0) found.push([section, needing.length])
  }
  if (snapshot.health.state === 'checked') rows('Rules files', 'rules', snapshot.health.targets, (target) => rulesRowState(snapshot, target).needs, (target) => target.harness)
  rows('Skills', 'skills', snapshot.skills.apps, (app) => skillsRowState(snapshot, app).needs, (app) => app.harness)
  rows('Tools', 'tools', snapshot.tools.apps, (app) => toolsRowState(snapshot, app).needs, (app) => app.harness)
  rows('Context limits', null, snapshot.context, contextRowNeeds, (row) => row.harness)
  if (snapshot.hooks?.state === 'checked') rows('Hooks', 'hooks', snapshot.hooks.apps, (app) => hookRowWords(app).needs, (app) => app.harness)
  const doctor = doctorNeedsCount(snapshot.doctor, keys)
  if (doctor > 0) found.push(['Doctor', doctor])
  return { count: found.reduce((total, [, count]) => total + count, 0), sections: found.map(([section]) => section), keys }
}

/** How many Health issues need the owner, each counted once. */
export function healthNeedsCount(snapshot: RulesSnapshot): number {
  return healthNeeds(snapshot).count
}

type Pending =
  // A save writes the master and every app's file (Story 75.9); `revision` marks an earlier version being saved again.
  | { kind: 'save'; text: string; plan: RulesSavePlan; revision?: number }
  // `near` says where it was asked for: the Notice's Undo shows its sheet under the Notice.
  | { kind: 'undo'; transaction: string; plan: RulesPlan; near?: 'notice' }
  | { kind: 'test'; harness: RosterHarness }
  | { kind: 'tools'; plan: ToolsPlan }

/** A notice under a page's head; `undo` names the save it can undo (Story 75.9). */
interface RulesNotice { ok: boolean; text: string; undo?: string }

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
  /** A read of the machine is under way (Health's head says Refreshing…); `acting`, an action the owner started. */
  reading: boolean
  acting: boolean
  notice: RulesNotice | null
  pending: Pending | null
  setDraft(text: string): void
  setNotice(notice: RulesNotice | null): void
  /** Reads the rules once; later reads are Health's rule (Story 75.7). */
  ensure(): void
  /** Reads them again if they were read before: an approval changes what each app may read. */
  refresh(): void
  load(): Promise<void>
  /** Shows what saving the draft writes: the master and each app's file. A clean draft writes only the apps' files that differ. */
  beginSave(): Promise<void>
  /** Shows what removing the entries that are not on the tools list would change in each app's settings. */
  beginToolsRemoval(): Promise<void>
  beginUndo(transaction: string, near?: 'notice'): Promise<void>
  /** Shows what saving an earlier version again writes, the master and each app's file. */
  beginRestore(revision: number): Promise<void>
  beginTest(harness: RosterHarness): void
  /** Carries out what the sheet shows. */
  confirm(): Promise<void>
  cancel(): void
  /** Carries out one Health action and shows what came of it; resolves to whether it was done. An unsaved draft stays. */
  run(task: () => Promise<RulesOutcome>): Promise<boolean>
}

/** The Rules pages' state, held once by the Preferences dialog so an unsaved draft survives a look at Health. */
export function useRulesState(doctorVisible = false): RulesState {
  const doctorVisibility = useRef(doctorVisible)
  const doctorRefresh = useRef(false)
  if (doctorVisible && !doctorVisibility.current) doctorRefresh.current = true
  doctorVisibility.current = doctorVisible
  const [snapshot, setSnapshot] = useState<RulesSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftPlan, setDraftPlan] = useState<RulesMasterPlan | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<RulesNotice | null>(null)
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
    fetch: () => {
      doctorRefresh.current = false
      return window.aiTerminal.rulesSnapshot(doctorVisibility.current)
    },
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
    doctorRefresh.current = doctorVisibility.current
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
  useEffect(() => {
    if (doctorVisible && doctorRefresh.current && snapshot !== null && !busy && pending === null) {
      doctorRefresh.current = false
      void load()
    }
  }, [doctorVisible, snapshot, busy, pending, load])

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
      // The text the plan was shown for, never the editor's later state, bound to that plan.
      const { text, plan } = pending
      if (plan.planHash === null) return
      const planHash = plan.planHash
      run = () => window.aiTerminal.saveRules(text, plan.expectedHash, plan.expectedLink, plan.expectedDirectory, planHash)
    } else if (pending.kind === 'tools') {
      const { planHash, removeUnlisted } = pending.plan
      if (planHash === null) return
      run = () => window.aiTerminal.installTools(planHash, removeUnlisted)
    } else if (pending.kind === 'undo') {
      const { transaction, plan } = pending
      if (plan.planHash === null) return
      const planHash = plan.planHash
      run = () => window.aiTerminal.restoreRules(transaction, planHash)
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
        text: outcome.ok || outcome.code !== 'REVISION_CONFLICT' ? outcome.message : 'Something changed since this was shown. Reloaded without writing.',
        ...(outcome.undo === undefined ? {} : { undo: outcome.undo })
      })
      setPending(null)
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
      doctorRefresh.current = doctorVisibility.current
      setNotice({ ok: outcome.ok, text: outcome.ok || outcome.code !== 'REVISION_CONFLICT' ? outcome.message : 'Something changed since this was shown. Reloaded without writing.' })
      return outcome.ok
    } catch (error) {
      setNotice({ ok: false, text: failureDetail(error, 'That could not be done') })
      return false
    } finally {
      setBusy(false)
    }
  }

  // BMN is running one of its own tests (Story 75.8): what it found is read once they have ended, never under an open confirmation.
  const testing = snapshot !== null && snapshot.autoTests.running !== null ? snapshot : null
  const confirming = pending !== null
  useEffect(() => {
    if (testing === null || confirming) return
    let cancelled = false
    window.aiTerminal.autoTests(false).then(() => { if (!cancelled) void load() }).catch(() => undefined)
    return () => { cancelled = true }
  }, [testing, confirming, load])

  return {
    snapshot, began, loadError, draft, dirty, draftPlan, busy, reading, acting, notice, pending, setDraft, setNotice, ensure, refresh, load, run,
    beginSave: () => {
      // A clean draft saves the rules as they are: only the apps' files that differ are written.
      const text = draft
      return begin(async () => {
        const plan = await window.aiTerminal.planRulesSave(text)
        return plan.valid && !plan.ok ? plan.message ?? 'The rules cannot be saved now' : { kind: 'save', text, plan }
      })
    },
    beginToolsRemoval: () => begin(async () => {
      const plan = await window.aiTerminal.planToolsInstall(true)
      return plan.ok ? { kind: 'tools', plan } : plan.message ?? 'The tools cannot be changed now'
    }),
    beginUndo: (transaction, near) => begin(async () => {
      const plan = await window.aiTerminal.planRulesRestore(transaction)
      return plan.ok ? { kind: 'undo', transaction, plan, ...(near === undefined ? {} : { near }) } : plan.message ?? 'That cannot be undone'
    }),
    beginRestore: (revision) => begin(async () => {
      const earlier = await window.aiTerminal.planRulesRevertMaster(revision)
      if (!earlier.ok || earlier.text === undefined) return earlier.message ?? 'That version cannot be read'
      const plan = await window.aiTerminal.planRulesSave(earlier.text)
      return plan.ok ? { kind: 'save', text: earlier.text, plan, revision } : plan.message ?? 'That version cannot be saved now'
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
function LinkNote(props: { link: string | null | undefined; home: string | null; what: string }): React.JSX.Element | null {
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
    case 'save': {
      const plan = pending.plan
      const count = plan.targets.length
      const restoring = pending.revision !== undefined
      const title = !plan.valid ? 'These rules cannot be saved'
        : restoring ? `Restore this version · ${diffSummary(plan.diff)}`
          : plan.changesMaster ? `Save the rules · ${diffSummary(plan.diff)}` : count === 0 ? 'Every app already has the saved rules' : `Write the saved rules to ${count} app${count === 1 ? '' : 's'}`
      return (
        <Sheet {...common} title={title} action={restoring ? 'Restore' : 'Save'} ready={plan.valid && plan.ok && plan.planHash !== null && (plan.changesMaster || count > 0)}
          note={!plan.valid ? 'An app could not read them as written.' : count === 0 && !plan.changesMaster ? undefined
            : `${count > 0 ? 'Each app\'s file below is written at once. ' : ''}Undo, under Earlier versions, puts the rules and every file back.`}>
          <Issues issues={plan.errors} />
          <LinkNote link={plan.changesMaster ? plan.expectedLink : null} home={home} what="The rules file" />
          {plan.changesMaster && plan.diff ? <pre className="diff">{diffBody(plan.diff)}</pre> : null}
          <Targets targets={plan.targets} home={home} words={changeWords} />
          {plan.blocked.map((entry) => (
            <p key={entry.harness} className="preferences-help" role="status"><Dot label="Needs you" />{ROSTER_APP_NAMES[entry.harness]} is not written: {entry.reason}</p>
          ))}
        </Sheet>
      )
    }
    case 'tools': {
      const count = pending.plan.targets.length
      const { exposed, blocked } = pending.plan
      return (
        <Sheet {...common} title={count === 0 ? 'No app holds such an entry now' : `Change ${count} tool entr${count === 1 ? 'y' : 'ies'}`} action="Change"
          ready={count > 0 && pending.plan.planHash !== null} note={count === 0 ? undefined : 'Only these entries change in each file. Undo, under Earlier installs, puts them back.'}>
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
    case 'undo': {
      const master = pending.plan.master
      // Skills and tools install themselves (Story 75.9): what the list still gives an app comes back, which the sheet says.
      const reason = rules.snapshot?.transactions.find((entry) => entry.id === pending.transaction)?.reason
      const again = reason === SKILLS_INSTALL ? 'BMN installs again at its next start or approval what your list gives an app; keep the skill from it to keep it out.'
        : reason === TOOLS_INSTALL ? 'BMN installs again at its next start or approval what your list gives an app; keep the tool from it to keep it out.' : null
      return (
        <Sheet {...common} title={master ? 'Undo this save' : 'Undo this install'} action="Undo" ready={pending.plan.planHash !== null}
          note={master ? 'The rules and each file go back to what they were before that save. Nothing is installed again.' : 'Each file goes back to what it was before that install.'}>
          {again ? <p className="preferences-help">{again}</p> : null}
          {master ? (
            <details className="target">
              <summary><span>The rules</span><span className="target-file"><span className="path mono" title={master.path}>{displayPath(master.path, home)}</span><span className="muted">{diffSummary(master.diff)}</span></span><span className="muted" /></summary>
              <pre className="diff">{diffBody(master.diff) || 'No change.'}</pre>
            </details>
          ) : null}
          <Targets targets={pending.plan.targets} home={home} words={undoWords} />
          {(pending.plan.left ?? []).map((target) => (
            <p key={target.path} className="preferences-help">
              {RETIRED_APP_LINE} <span className="path mono" title={target.path}>{displayPath(target.path, home)}</span> is left as it is.
            </p>
          ))}
        </Sheet>
      )
    }
    case 'test':
      return (
        <Sheet {...common} title={`Test whether ${ROSTER_APP_NAMES[pending.harness]} loads the rules`} action="Send test"
          note={`Starts ${ROSTER_APP_NAMES[pending.harness]} once and sends the rules to its provider. The result is Passed, Failed, Inconclusive or Unavailable.`} />
      )
  }
}

function Notice(props: { rules: RulesState }): React.JSX.Element | null {
  const { rules } = props
  const notice = rules.notice
  if (notice === null) return null
  // After a save, its small Undo, as the Team page's after an approval (Story 75.9).
  const undo = notice.undo
  return (
    <p className={notice.ok ? 'preferences-success' : 'preferences-error'} role={notice.ok ? 'status' : 'alert'}>
      {notice.text}
      {undo === undefined ? null : <> · <button type="button" className="small" disabled={rules.busy || rules.pending !== null} onClick={() => void rules.beginUndo(undo, 'notice')}>Undo</button></>}
    </p>
  )
}

// ---------------------------------------------------------------------------------------------
// Integrations › Rules

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
  // A file edited outside BMN, or one a save could not write, is put back by Save without a change to the rules (Story 75.9).
  const differ = targets.filter((target) => target.state !== 'current').length
  const renderings: readonly RulesRenderingView[] = rules.dirty && rules.draftPlan?.valid ? rules.draftPlan.renderings : snapshot.renderings
  const rendering = renderings.find((entry) => entry.harness === previewApp)
  const errors: readonly RosterIssueShape[] = rules.dirty ? rules.draftPlan?.errors ?? [] : snapshot.master.errors
  const earlier = earlierVersions(snapshot)
  const status = rulesStatus(snapshot)
  return (
    <>
      <PageHead title="Rules" status={<>{status.needs ? <Dot label="Needs you" /> : null}{status.text}</>} />
      <Notice rules={rules} />
      {pending?.kind === 'undo' && pending.near === 'notice' ? <PendingSheet rules={rules} /> : null}
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
        <button type="button" disabled={rules.busy || (!rules.dirty && (differ === 0 || !snapshot.master.exists)) || errors.length > 0 || pending !== null}
          title={!rules.dirty && differ > 0 ? 'Writes the saved rules into the apps whose file differs' : undefined} onClick={() => void rules.beginSave()}>Save…</button>
        <button type="button" disabled={rules.busy || !rules.dirty || pending !== null} onClick={() => rules.setDraft(snapshot.master.text ?? '')}>Discard</button>
      </div>
      {pending?.kind === 'save' && pending.revision === undefined ? <PendingSheet rules={rules} /> : null}

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
        {earlier.length === 0 ? <p className="preferences-help">Nothing yet. Every save is kept here.</p> : null}
        {earlier.map((entry) => (
          <div key={entry.kind === 'install' ? entry.id : `save-${entry.revision}`} className="list-line">
            <div><b>{entry.title}</b> <span className="line-detail">{shortDate(entry.at)}{entry.detail ? ` · ${entry.detail}` : ''}</span></div>
            {entry.kind === 'install'
              ? <button type="button" className="small" disabled={rules.busy || !entry.usable || rules.dirty || pending !== null} aria-label={`Undo the ${entry.title === 'Installed' || entry.title === 'Team line updated' ? 'install' : 'save'} of ${shortDate(entry.at)}`}
                  title={rules.dirty ? 'Save or discard your edits first' : undefined} onClick={() => void rules.beginUndo(entry.id)}>Undo…</button>
              : <button type="button" className="small" disabled={rules.busy || !entry.usable || rules.dirty || pending !== null} aria-label={`Restore the version saved ${shortDate(entry.at)}`}
                  title={rules.dirty ? 'Save or discard your edits first' : undefined} onClick={() => void rules.beginRestore(entry.revision)}>Restore…</button>}
          </div>
        ))}
        {(pending?.kind === 'undo' && pending.near === undefined) || (pending?.kind === 'save' && pending.revision !== undefined) ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Integrations › Health

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
  return count === 1 ? `BMN recognises 1 ${name} session. Restart it to use the update; its running version is not checked.`
    : `BMN recognises ${count} ${name} sessions. Restart them to use the update; their running versions are not checked.`
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

/** An update command BMN typed has ended: Health reads the machine after it, and BMN looks for what the new version needs tested (Story 75.8). */
function updateRunEnded(): void {
  updateEnded()
  void window.aiTerminal.autoTests(true).catch(() => undefined)
}

/** What the sheet says about a press on Update now that did not run the command; null while there is nothing to say. */
function pressWords(press: CommandPress, session: string): string | null {
  if (press === 'opening') return `Opening ${session} and waiting for its shell…`
  if (press === 'not-reading') return `The shell in ${session} did not get ready for a command, so BMN typed nothing. Copy the command and run it yourself.`
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
  // One line each: what Update now does, the other way, and the test to run again (docs/design.md W2).
  const afterwards = [
    ...(props.onRun ? ['Update now opens a session, types the command at its prompt and presses Enter; you see and answer what the updater asks.',
      `BMN rereads ${name}'s version and where it sends data whenever that session's shell is at its prompt, and on Health.`,
      'Or run the command in any terminal yourself.']
      : [`Run the command in a terminal. Back on Health, BMN reads the version and where ${name} sends data again.`]),
    ...(props.hasTest ? ['A loading test made before the update needs to be run again.'] : [])
  ]
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
        {/* The lines take the gap a review's lines have, so each reads as its own fact (docs/design.md W2). */}
        <span><span className="review">{afterwards.map((line) => <span key={line}>{line}</span>)}</span></span>
      </div>
      <p className="preferences-help">The updater decides what it downloads and replaces, and may ask; BMN cannot see it first or undo it.</p>
      <p className="preferences-help">BMN does not know whether a newer version exists.</p>
      {props.onRun ? (
        <>
          <p className="preferences-help">BMN knows the prompt by the sign the shell&apos;s line editor gives.</p>
          <p className="preferences-help">A question a start-up file asks with line editing gives the same sign and would get the command as its answer.</p>
        </>
      ) : null}
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

/** An app's default for the owner's own sessions, as its file holds it. */
export function contextValueWords(row: Pick<ContextLimitView, 'limit' | 'compact' | 'unreadable'>): string {
  if (row.unreadable) return "Can't be read"
  if (row.limit === null) return 'App default'
  return `${thousands(row.limit)} tokens${row.compact === null ? '' : ` · summarises at ${thousands(row.compact)}`}`
}

/** What a passed test of an app proves, beside what it does not: where the app starts summarising is never tested (that would take filling a conversation). */
const CONTEXT_PROOF: Record<ContextLimitView['harness'], string> = {
  claude: 'proves the limit for runs BMN starts, as --settings; where it summarises is not tested',
  codex: 'proves model_context_window; where it summarises is not tested'
}

/**
 * How the app's setting stands on the installed version (60.9 AC1), in parts that stay apart (Story 96.5): what the latest
 * test of this version observed and who ran it (63.1 AC5), what a pass proves, and who acts next: BMN's own test, the
 * owner's Test again…, or no one because nothing calls for a test. The saved value is contextValueWords.
 */
export function contextStateWords(row: Pick<ContextLimitView, 'harness' | 'version' | 'test' | 'autoTest'>): string {
  if (row.version === null) return 'Not found · no limit can be proven without the app'
  const last = row.test !== null && row.test.version === row.version ? row.test : null
  if (last === null) {
    return `Not yet proven on ${row.version} · ${row.autoTest === 'scheduled' ? 'BMN tests it by itself'
      : row.autoTest === 'not-needed' ? 'no automatic test: no agent has a limit here and the file holds no default' : 'no automatic test is scheduled'}`
  }
  // Codex's test sends one short request to its provider; Claude Code's asks for its own report (Story 75.8 AC2).
  const spent = row.harness === 'codex' ? ' · one prompt sent' : ''
  const who = last.by === 'bmn' ? `BMN tested ${row.version} by itself ${shortDate(last.at)}` : `Tested on ${row.version}`
  if (last.outcome === 'pass') {
    const seen = last.observed === null ? '' : ` · asked for ${thousands(last.asked)}, it reported ${thousands(last.observed)}`
    return `${who}${seen} · ${CONTEXT_PROOF[row.harness]}${spent}`
  }
  // A failure says why in the test's own words, such as a setting of the owner's that outranks the agent's limit (Story 90.9).
  if (last.outcome === 'fail') return `${who} · the test failed${last.detail === '' ? '' : `: ${last.detail}`} · not used; Test again… is yours${spent}`
  return `${who} · the test showed nothing · ${row.autoTest === 'scheduled' ? 'BMN tries again by itself' : 'no automatic test is scheduled'}${spent}`
}

/**
 * What Health says while the approved team holds no role to read-only although BMN proposes some (63.2 AC4):
 * a team from before the mark reads as before, and the owner is told what that leaves open. Null otherwise.
 */
export function notHeldWords(roles: RulesSnapshot['readOnlyRoles']): string | null {
  if (roles === null || roles.held.length > 0 || roles.proposed.length === 0) return null
  return `No role is held to read-only yet, so a reviewer with write access passes. Agents › Team proposes it for ${listedRoles(roles.proposed)}.`
}

/** What becomes of an agent's own limit in a run BMN checks, in one line (63.1 AC4). */
export function agentLimitWords(entry: ContextAgentLimit): string {
  const size = thousands(entry.limit)
  if (entry.state === 'applied') return `${entry.agent}: its own limit of ${size} is applied to each run.`
  if (entry.state === 'refused') return `${entry.agent}: runs are refused, because its own limit of ${size} cannot be applied.`
  return `${entry.agent}: its own limit of ${size} is not applied, so a run gets the app's own size.`
}

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

/** Integrations › Health › Context limits: one row per app BMN has a setting for (60.9 AC3). */
function ContextLimits(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const steady = useContext(SteadyOrderContext)
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const auto = snapshot.autoTests
  const idle = !rules.acting && action === null && rules.pending === null
  return (
    <>
      <h4 className="group-head">Context limits<span className="caption">how large a conversation may grow in sessions you start yourself</span></h4>
      {steady('context', snapshot.context, contextRowNeeds).map((row) => {
        const name = ROSTER_APP_NAMES[row.harness]
        const stopped = stoppedTest(auto, 'context', row.harness)
        const failed = row.test !== null && row.test.version === row.version && row.test.outcome === 'fail'
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
                <span className="faint" title={row.test?.detail}>{testRunning(auto, 'context', row.harness) ? runningWords(row.harness) : stopped !== undefined ? stoppedWords(stopped) : contextStateWords(row)}</span>
              </span>
              <span className="app-actions">
                {offersTestAgain(auto, 'context', row.harness, failed) ? (
                  <button type="button" className="small" disabled={!idle || row.version === null} aria-label={`Test the context limit of ${name} again`} onClick={() => props.setAction({ kind: 'context-test', harness: row.harness })}>Test again…</button>
                ) : null}
                <button type="button" className="small" disabled={!idle || !row.limitProven || row.unreadable !== undefined} aria-label={`Change the default context limit of ${name}`}
                  title={row.limitProven ? undefined : `Not yet proven: it waits for a test that passes on this ${name} version`} onClick={() => props.setAction({ kind: 'context-change', harness: row.harness })}>Change…</button>
              </span>
            </div>
            {row.limits.map((entry) => (
              <p key={entry.agent} className="limit-note" title={entry.reason}>
                {entry.state === 'applied' ? null : <Dot label="Needs you" />}{agentLimitWords(entry)}
              </p>
            ))}
            {action?.kind === 'context-test' && action.harness === row.harness ? (
              <Sheet title={`Test whether ${name} takes a context limit`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} once in an empty folder under your home folder and asks it for an unusual size.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testContextLimit(row.harness)).then(() => props.setAction(null))}>
                <p className="preferences-help">It may send one short request to its provider, with nothing of yours in it. The result is kept for this version.</p>
              </Sheet>
            ) : null}
            {action?.kind === 'context-change' && action.harness === row.harness
              ? <ContextSheet row={row} home={snapshot.home} busy={rules.busy} run={rules.run} onDone={() => props.setAction(null)} /> : null}
          </div>
        )
      })}
      <p className="preferences-help">When an agent has a limit of its own or the app&apos;s file holds a default, BMN tests each new version of the app by itself, once, in an empty folder.</p>
      <p className="preferences-help">Claude Code is asked for its context report; Codex sends one short request to its provider. Nothing of yours is in it.</p>
      <p className="preferences-help">A limit changes only on a version whose test passed; an agent&apos;s own limit waits for the next automatic test.</p>
      <p className="preferences-help">An agent&apos;s own limit, set on its page, is added to each run BMN or dev-auto starts with it on a tested version.</p>
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
  if (app === undefined || !app.supported) return `Skills are not supported yet in ${name}: Health says how BMN's test of it stands`
  switch (state) {
    case 'current': return `${name} has it`
    case 'read-directly': return `${name} reads the skills folder itself`
    case 'missing': return `Not in ${name} yet: BMN adds it at its next start or approval`
    case 'excluded': return `${name} gets public skills only`
    case 'unreadable': return 'BMN cannot read this skill'
    case undefined: return `Not checked in ${name}`
    case 'stale': return `${name} has an older copy: BMN updates it at its next start or approval`
    default: return `${name} holds something else under this name, which BMN leaves as it is: remove it there and BMN adds the skill`
  }
}

/** An app's last skills test, or why its skills are not supported yet. */
export function skillsTestLine(app: Pick<SkillsAppView, 'supported' | 'version' | 'test' | 'listing' | 'loading' | 'kind' | 'testable'>): string {
  if (!app.supported) {
    if (app.version === null) return 'The app is not found'
    if (!app.testable) return 'BMN has no test for this app'
    const last = app.test !== null && app.test.version === app.version ? app.test.outcome : null
    return last === 'fail' ? `The test failed on ${app.version}` : last === 'inconclusive' ? `The test was inconclusive on ${app.version}` : `BMN tests ${app.version} by itself`
  }
  // Two tests, each named for what it shows: a listing sends no prompt, a loading test sends one. A listing never reads as loading.
  if (app.kind !== 'full') return 'No loading test'
  const words = (label: string, test: NonNullable<SkillsAppView['loading']>): string => `${label} ${TEST_WORDS[test.outcome].toLowerCase()} ${shortDate(test.at)}${test.by === 'bmn' ? ' · by BMN' : ''}${test.stale ? ' · stale' : ''}`
  if (app.loading !== null) return `${words('Loading test', app.loading)}${app.loading.outcome === 'unavailable' ? '' : PROMPT_SENT}`
  return app.listing === null ? 'Loading never tested' : `${words('Listing test', app.listing)} · loading never tested`
}

/** Whether a skills test failed on the installed version: the folder test, or a listing or loading test that is not stale. */
function skillsFailed(app: Pick<SkillsAppView, 'version' | 'test' | 'listing' | 'loading'>, kind: 'skills' | 'skills-loading'): boolean {
  const failed = (test: { version: string | null; outcome: string; stale?: boolean } | null): boolean => test !== null && test.version === app.version && test.outcome === 'fail' && test.stale !== true
  return kind === 'skills' ? failed(app.test) || failed(app.listing) : failed(app.loading)
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
      <PageHead title="Skills" status={view.source.readable ? `${count} skill${count === 1 ? '' : 's'}${view.pending > 0 ? ` · ${view.pending} not installed yet` : ''}` : 'The skills folder cannot be read'} />
      <Notice rules={rules} />
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
      {view.ownLeft.map((left) => (
        <p key={left.name} className="preferences-help">
          BMN&apos;s own skill <b>{left.name}</b> is not BMN&apos;s here: {left.state === 'removed' ? 'you removed it, so BMN does not add it back' : left.state === 'foreign' ? `${left.detail}; remove it and BMN adds its own at the next start` : left.detail}.
        </p>
      ))}
      <p className="preferences-help">A skill reaches every app unless you keep it to some; an app held to public work gets only the Public&nbsp;skills.</p>
      <p className="preferences-help">A change takes effect on approval; BMN then installs it in each app, and at every start installs what an app lacks.</p>

      <details className="advanced">
        <summary>Earlier installs</summary>
        {installs.length === 0 ? <p className="preferences-help">Nothing yet. Every skills install is kept here.</p> : null}
        {installs.map((entry) => (
          <div key={entry.id} className="list-line">
            <div><b>{entry.valid ? 'Installed' : 'An install that cannot be read'}</b> <span className="line-detail">{shortDate(entry.createdAt)}{entry.targets?.length ? ` · ${entry.targets.map(appDisplayName).join(', ')}` : ''}{entry.valid && entry.state !== 'complete' ? ' · did not finish' : ''}</span></div>
            <button type="button" className="small" disabled={!idle || !entry.valid} aria-label={`Undo the skills install of ${shortDate(entry.createdAt)}`} onClick={() => void rules.beginUndo(entry.id)}>Undo…</button>
          </div>
        ))}
        {pending?.kind === 'undo' ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

/** Integrations › Health › Skills: one row per app (60.11 AC5). */
function SkillsHealth(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const steady = useContext(SteadyOrderContext)
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.skills
  return (
    <>
      <h4 className="group-head">Skills<span className="caption">where each app reads skills, and whether it has the ones it may have</span></h4>
      {view.source.readable ? null : <p className="preferences-error" role="alert">{view.source.detail ?? 'The skills folder cannot be read'}</p>}
      {steady('skills', view.apps, (app) => skillsRowState(snapshot, app).needs).map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const idle = !rules.acting && action === null && rules.pending === null
        const stopped = stoppedTest(snapshot.autoTests, 'skills', app.harness) ?? stoppedTest(snapshot.autoTests, 'skills-loading', app.harness)
        const { again, loadAgain, needs } = skillsRowState(snapshot, app)
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
                <span className="faint" title={app.loading?.detail ?? app.listing?.detail ?? app.test?.detail}>{testRunning(snapshot.autoTests, ['skills', 'skills-loading'], app.harness) ? runningWords(app.harness) : stopped !== undefined ? stoppedWords(stopped) : skillsTestLine(app)}</span>
              </span>
              <span className="app-actions">
                {again && app.testable ? (
                  <button type="button" className="small" disabled={!idle || app.version === null} aria-label={`Test the skills of ${name} again`}
                    onClick={() => props.setAction({ kind: 'skills-test', harness: app.harness })}>Test again…</button>
                ) : null}
                {loadAgain && app.loadTestable ? (
                  <button type="button" className="small" disabled={!idle} aria-label={`Test skill loading in ${name} again`}
                    onClick={() => props.setAction({ kind: 'skills-loading-test', harness: app.harness })}>Test loading again…</button>
                ) : null}
              </span>
            </div>
            {action?.kind === 'skills-test' && action.harness === app.harness ? (
              <Sheet title={`Test where ${name} reads skills`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} in an empty home with test skills only and asks which it sees; no prompt, no sign-in.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testSkills(app.harness)).then(() => props.setAction(null))}>
                {app.kind === 'full' ? <p className="preferences-help">{`Then puts one empty test skill where ${name} keeps its skills, asks again and removes it.`}</p> : null}
                <p className="preferences-help">The result is kept for this version.</p>
              </Sheet>
            ) : null}
            {action?.kind === 'skills-loading-test' && action.harness === app.harness ? (
              <Sheet title={`Test whether ${name} loads a skill`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Puts one test skill where ${name} keeps its skills, starts ${name} once in an empty folder and sends one prompt naming it.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testSkillsLoading(app.harness)).then(() => props.setAction(null))}>
                <p className="preferences-help">{`The prompt goes to ${name}'s provider with what ${name} adds to every prompt; the test skill holds nothing of yours.`}</p>
                <p className="preferences-help">The skill is removed afterwards. The test passes only when its own words come back and no tool can have read the file.</p>
              </Sheet>
            ) : null}
          </div>
        )
      })}
      <p className="preferences-help">Nothing is written for an app until its test passed on the installed version.</p>
      <p className="preferences-help">Skills inside a project folder, and sessions already running, are outside what BMN installs.</p>
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
      <PageHead title="Tools" status={`${count} tool${count === 1 ? '' : 's'}${view.pending > 0 ? ` · ${view.pending} not installed yet` : ''}`} />
      <Notice rules={rules} />
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
            <button type="button" className="small" disabled={!idle} onClick={() => void rules.beginToolsRemoval()}>Remove them from the apps…</button>
          </div>
          {pending?.kind === 'tools' ? <PendingSheet rules={rules} /> : null}
        </>
      ) : null}
      <p className="preferences-help">A tool names environment variables and never holds their values.</p>
      <p className="preferences-help">It reaches every app unless you keep it to some apps, or to the runs of some agents.</p>
      <p className="preferences-help">A change takes effect on approval and goes into each app&apos;s settings; at every start BMN installs what an app lacks.</p>

      <details className="advanced">
        <summary>Earlier installs</summary>
        {installs.length === 0 ? <p className="preferences-help">Nothing yet. Every tools install is kept here.</p> : null}
        {installs.map((entry) => (
          <div key={entry.id} className="list-line">
            <div><b>{entry.valid ? 'Installed' : 'An install that cannot be read'}</b> <span className="line-detail">{shortDate(entry.createdAt)}{entry.targets?.length ? ` · ${entry.targets.map(appDisplayName).join(', ')}` : ''}{entry.valid && entry.state !== 'complete' ? ' · did not finish' : ''}</span></div>
            <button type="button" className="small" disabled={!idle || !entry.valid} aria-label={`Undo the tools install of ${shortDate(entry.createdAt)}`} onClick={() => void rules.beginUndo(entry.id)}>Undo…</button>
          </div>
        ))}
        {pending?.kind === 'undo' ? <PendingSheet rules={rules} /> : null}
      </details>
    </>
  )
}

/** Integrations › Health › Tools: one row per app (60.12 AC6). */
/** An app holding tools it may not have, as what is available to it (Story 96.6): BMN saw entries, never a transfer. */
export function exposedWords(view: Pick<RulesSnapshot['tools'], 'tools'>, app: Pick<ToolsAppView, 'harness' | 'unlisted'>): string {
  const count = view.tools.filter((tool) => tool.states[app.harness] === 'exposed').length + app.unlisted.filter((entry) => entry.state === 'exposed').length
  return `${count === 1 ? 'One tool connection' : `${count} tool connections`} available · no approved destination recorded`
}

function ToolsHealth(props: { rules: RulesState; action: AppAction | null; setAction(action: AppAction | null): void }): React.JSX.Element {
  const steady = useContext(SteadyOrderContext)
  const { rules, action } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const view = snapshot.tools
  return (
    <>
      <h4 className="group-head">Tools<span className="caption">where each app keeps its tools, and whether it has the ones it may have</span></h4>
      {view.error ? <p className="preferences-error" role="alert">{view.error}</p> : null}
      {steady('tools', view.apps, (app) => toolsRowState(snapshot, app).needs).map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const idle = !rules.acting && action === null && rules.pending === null
        const stopped = stoppedTest(snapshot.autoTests, 'tools', app.harness)
        const { again, needs } = toolsRowState(snapshot, app)
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
                <span title={app.reason}>{needs ? <Dot label="Needs you" /> : null}{app.state === 'Exposed' ? exposedWords(view, app) : app.state}{app.supported ? <span className="muted"> · {app.kind === 'full' ? 'Full' : 'Public tools only'}</span> : null}</span>
                {app.state === 'Exposed' ? <span className="faint">{`Names and Remove…: Tools tab › ${name}`}</span> : null}
                <span className="faint" title={app.test?.detail}>{testRunning(snapshot.autoTests, 'tools', app.harness) ? runningWords(app.harness) : stopped !== undefined ? stoppedWords(stopped) : toolsTestLine(app, shortDate)}</span>
              </span>
              <span className="app-actions">
                {again ? (
                  <button type="button" className="small" disabled={!idle || app.version === null} aria-label={`Test the tools of ${name} again`} onClick={() => props.setAction({ kind: 'tools-test', harness: app.harness })}>Test again…</button>
                ) : null}
              </span>
            </div>
            {action?.kind === 'tools-test' && action.harness === app.harness ? (
              <Sheet title={`Test where ${name} keeps its tools`} action="Run test" busy={rules.busy} onCancel={() => props.setAction(null)}
                note={`Starts ${name} in an empty home folder with no sign-in, so no prompt can be answered there.`}
                onConfirm={() => void rules.run(() => window.aiTerminal.testTools(app.harness)).then(() => props.setAction(null))}>
                <p className="preferences-help">{`BMN writes one stand-in tool into its settings file and asks ${name} which tools it sees.`}</p>
                {app.harness === 'claude' ? <p className="preferences-help">{`It then starts ${name} three more times to see which tools a run begins with.`}</p> : null}
                <p className="preferences-help">The folder is removed afterwards. The result is kept for this version.</p>
              </Sheet>
            ) : null}
          </div>
        )
      })}
      <p className="preferences-help">Nothing is written for an app until its test passed on the installed version.</p>
      <p className="preferences-help">Tools inside a project folder, and sessions already running, are outside what BMN installs.</p>
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

/**
 * Health's head (Story 96.6): "Refreshing…" only while BMN re-reads the machine, otherwise when it last read and, past
 * the Health rule's limit, that this is stale; then how many issues need the owner and in which sections. Tests and
 * Doctor runs say their state on their own rows and never change it.
 */
export function healthHeadWords(reading: boolean, checkedAt: string, stale: boolean, needs: { count: number; sections: string[] }): string {
  if (reading) return 'Refreshing…'
  const issues = needs.count === 0 ? '' : ` · ${needs.count} need${needs.count === 1 ? 's' : ''} you: ${needs.sections.join(', ')}`
  return `Read ${shortDate(checkedAt)}${stale ? ' · stale' : ''}${issues}`
}

/** Whether `iso` is older than `ms` now, turning true by itself once it is. */
function useAged(iso: string, ms: number): boolean {
  const at = Date.parse(iso)
  const [, tick] = useState(0)
  const aged = Number.isFinite(at) && Date.now() - at > ms
  useEffect(() => {
    if (aged || !Number.isFinite(at)) return
    const timer = window.setTimeout(() => tick((value) => value + 1), Math.max(1, at + ms + 1 - Date.now()))
    return () => window.clearTimeout(timer)
  }, [aged, at, ms])
  return aged
}

function HealthPage(props: { rules: RulesState; team: TeamState; recognised: RecognisedSessions; onRun?: RunInSession | undefined } & SetupNavigation): React.JSX.Element {
  const { rules, team, onRun: runInSession } = props
  const snapshot = rules.snapshot as RulesSnapshot
  const setup = useSetupApps(props)
  const [action, setAction] = useState<AppAction | null>(null)
  // Apps whose before-and-now line was shown on this visit: said once, their watch ends when the owner leaves Health.
  const told = useRef(new Set<RosterHarness>())
  useEffect(() => {
    const shown = told.current
    return () => forgetUpdateWatches(shown)
  }, [])
  const top = useHealthRule<HTMLHeadingElement>(rules)
  const steady = useSteadyOrder(top)
  const shownDoctor = useRef(snapshot.doctor)
  if (action === null && rules.pending === null && !rules.dirty) shownDoctor.current = snapshot.doctor
  const doctorView = shownDoctor.current
  const doctorNow = useDoctorClock(doctorView)
  useEffect(() => {
    const doctor = doctorView
    if (!doctor || (!doctor.running && (doctor.cycleStartedAt !== null || doctor.error !== null)) ||
      rules.busy || rules.dirty || rules.pending !== null || action !== null) return
    const timer = window.setInterval(() => {
      if (top.current !== null && top.current.offsetParent !== null) void rules.load()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [doctorView, rules.busy, rules.dirty, rules.pending, rules.load, action, top])
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
  const needs = healthNeeds({ ...snapshot, doctor: doctorView })
  const stale = useAged(health.checkedAt, HEALTH_STALE_MS)
  return (
    <SteadyOrderContext.Provider value={steady}>
      <PageHead title="Health" status={<span role="status">{healthHeadWords(rules.reading, health.checkedAt, stale, needs)}</span>} />
      <Notice rules={rules} />
      {/* Only the head is a live status (Story 96.6): what a read finds is said where it is, without announcing itself. */}
      {notHeldWords(snapshot.readOnlyRoles) === null ? null : <p className="page-note"><Dot label="Needs you" />{notHeldWords(snapshot.readOnlyRoles)}</p>}
      <h4 className="group-head" ref={top}>Rules files</h4>
      {health.state === 'failed' ? <p className="preferences-error" role="alert">{health.reason}</p> : steady('rules', health.targets, (target) => rulesRowState(snapshot, target).needs).map((target) => {
        const test = snapshot.probes.find((entry) => entry.harness === target.harness)
        const stopped = stoppedTest(snapshot.autoTests, 'rules', target.harness)
        const { again, needs } = rulesRowState(snapshot, target)
        return (
          <div key={target.harness} className="health-row" data-state={target.state}>
            <span>{ROSTER_APP_NAMES[target.harness]}</span>
            <span className="path mono" title={target.path}>{displayPath(target.path, snapshot.home)}</span>
            <span className="health-state">
              <span>{needs ? <Dot label="Needs you" /> : null}{targetStateWords(target.state)}{target.state === 'current' ? <span className="muted"> · {KIND_WORDS[target.kind]}</span> : null}</span>
              <span className="faint" title={test?.detail}>{target.kind !== 'full' ? 'No loading test' : testRunning(snapshot.autoTests, 'rules', target.harness) ? runningWords(target.harness) : stopped !== undefined ? stoppedWords(stopped) : testLine(test)}</span>
            </span>
            {again
              ? <button type="button" className="small" disabled={rules.acting || pending !== null} aria-label={`Test ${ROSTER_APP_NAMES[target.harness]} again`} onClick={() => rules.beginTest(target.harness)}>Test again…</button>
              : <span />}
          </div>
        )
      })}
      {pending?.kind === 'test' ? <PendingSheet rules={rules} /> : null}
      <p className="preferences-help">A loading test starts the app once with the rules in one prompt; BMN runs it by itself after updates and rules changes.</p>
      {withheld.length > 0 ? <p className="preferences-help">{`It is off for ${named(withheld)}, which ${withheld.length === 1 ? 'gets' : 'get'} only the public sections.`}</p> : null}

      <h4 className="group-head">Agent apps<span className="caption">the program BMN finds, its version and where it sends data</span></h4>
      {snapshot.ownEnvironment ? (
        <p className="page-note"><Dot label="Needs you" />BMN could not read your shell's settings ({snapshot.ownEnvironment}), so it looked for the apps with its own; a session may find more.</p>
      ) : null}
      {snapshot.apps.map((app) => {
        const name = ROSTER_APP_NAMES[app.harness]
        const readiness = setup.snapshot?.apps.find(row => row.app === app.harness)
        const setupSession = readiness ? setup.latest(readiness) : undefined
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
                {readiness ? <SetupReadiness row={readiness} session={setupSession} /> : null}
                {readiness?.program && !readiness.onPath ? <span className="path mono wrap" title={readiness.program}>Not on your PATH · {readiness.program}</span> : null}
              </span>
              <span className="app-actions">
                {readiness && (setupAppNeedsAction(readiness, setupSession)) ?
                  <button type="button" className="small" disabled={setup.busy || action !== null} onClick={() => setup.begin(readiness)}>{setup.actionWords(readiness)}</button> : null}
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
      <p className="preferences-help">Routing-tested versions are the ones BMN checked for where they send data. Every installed version is supported.</p>
      <p className="preferences-help">BMN works out where an app sends data the same way on each version, and notes the version with every check.</p>

      <SkillsHealth rules={rules} action={action} setAction={setAction} />

      <ToolsHealth rules={rules} action={action} setAction={setAction} />

      <ContextLimits rules={rules} action={action} setAction={setAction} />

      <PushPolicyHealth />

      <HooksHealth hooks={snapshot.hooks} home={snapshot.home} />
      <DoctorHealth view={doctorView} now={doctorNow} sections={needs.keys} />
      {setup.error ? <p className="preferences-error" role="alert">{setup.error}</p> : null}
      {setup.modal}
    </SteadyOrderContext.Provider>
  )
}

/** "13:31": the time of day BMN checked something at start. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Health › Hooks (Story 75.9): what BMN's install at start found in each app's hook file, failure first; there is no button. */
function HooksHealth(props: { hooks: HooksAtStart | null; home: string | null }): React.JSX.Element {
  const steady = useContext(SteadyOrderContext)
  const { hooks } = props
  return (
    <>
      <h4 className="group-head" id="health-hooks">Hooks<span className="caption">BMN's entries in each app's hook file, installed at start</span></h4>
      {hooks === null ? <p className="preferences-help">Not checked yet: BMN checks them each time it starts.</p>
        : hooks.state === 'failed' ? <p className="preferences-error" role="alert">{hooks.reason}</p>
          : steady('hooks', hooks.apps, (app) => hookRowWords(app).needs).map((app) => {
            const words = hookRowWords(app)
            return (
              <div key={app.harness} className="health-row" data-hooks={words.needs ? 'left' : 'in-place'}>
                <span>{ROSTER_APP_NAMES[app.harness]}</span>
                <span className="path mono" title={app.file}>{displayPath(app.file, props.home)}</span>
                <span className="health-state">
                  <span className={words.needs ? undefined : 'faint'}>{words.needs ? <Dot label="Needs you" /> : null}{words.head}</span>
                  {words.lines.map((line) => <span key={line} className="faint">{line}</span>)}
                </span>
                <span />
              </div>
            )
          })}
      {hooks === null ? null : (
        <>
          <p className="preferences-help">Checked at start, {clockTime(hooks.checkedAt)}. BMN adds an entry only where an event has none of its own.</p>
          <p className="preferences-help">An entry it did not write, a changed one, or one inside a matcher is left as it is.</p>
        </>
      )}
    </>
  )
}

export function RulesPreferences(props: {
  rules: RulesState; team: TeamState; page: RulesPage; recognised?: RecognisedSessions
  /** Opens a new shell session and runs `command` there; Health offers it for an app's update command. */
  onRunInSession?: RunInSession | undefined
  onSetupCreated?: SetupNavigation['onCreated']
  onOpenSetupSession?: SetupNavigation['onOpenSession']
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
  return props.page === 'editor' ? <EditorPage rules={rules} /> : <><HealthPage rules={rules} team={props.team} recognised={props.recognised ?? {}} onRun={props.onRunInSession}
    onCreated={props.onSetupCreated} onOpenSession={props.onOpenSetupSession} /></>
}
