// MODULE: doctor-health.tsx - Approved automatic Health doctor: its findings counted once with Health's own sections, show-only leftovers grouped and excluded from attention
import { ROSTER_APP_NAMES, type DoctorCheck, type DoctorLeftover, type DoctorRow, type DoctorView } from '@bmn/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Dot } from './roster-marks'

const LABELS: Record<DoctorCheck, string> = { hooks: 'Hooks', skills: 'Skills', tools: 'Tools', rules: 'Rules files', claude: 'Claude Code', codex: 'Codex', leftovers: 'Leftovers' }
const COMMANDS: Record<DoctorCheck, string> = { hooks: 'bmn hooks check --json', skills: 'bmn skills check --json', tools: 'bmn tools check --json',
  rules: 'bmn rules check --json', claude: 'claude doctor', codex: 'codex doctor --json', leftovers: 'bmn doctor --json' }

const FRESH_MS = 24 * 60 * 60 * 1000
const staleAt = (row: DoctorRow, now: number): boolean => row.stale || row.checkedAt !== null && now - row.checkedAt > FRESH_MS

/** A local clock ages existing results without adopting rows over an open sheet or dirty draft. */
export function useDoctorClock(view: DoctorView | undefined): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!view) return
    const current = Date.now()
    let wake = current + 60000
    for (const row of view.rows) {
      const expiry = row.checkedAt === null ? null : row.checkedAt + FRESH_MS + 1
      if (expiry !== null && expiry > current) wake = Math.min(wake, expiry)
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, wake - current))
    return () => window.clearTimeout(timer)
  }, [view, now])
  return now
}

/** Health's sections a Doctor finding can be the same issue as (Story 96.6): its check of BMN's own entries in that app. */
export type HealthArea = 'hooks' | 'tools' | 'skills' | 'rules'
const AREAS: Readonly<Record<string, HealthArea>> = { 'hook-check': 'hooks', 'tool-check': 'tools', 'skill-check': 'skills', 'rules-check': 'rules' }
const AREA_WORDS: Readonly<Record<HealthArea, string>> = { hooks: 'Hooks', tools: 'Tools', skills: 'Skills', rules: 'Rules files' }
/** How fully the leftovers were read: shown on the Leftovers line, never counted; unreadable items stay a problem of their own. */
const COVERAGE = new Set(['leftover-source-changed', 'leftover-step', 'leftover-file-bound', 'leftover-folder-bound', 'leftover-database-bound'])

type Problem = DoctorRow['problems'][number]
/**
 * Where one Doctor finding is counted: `area` when Health's own section row for the same app and area already needs the
 * owner (one issue, counted there), `coverage` when it only says how fully the leftovers were read, `doctor` otherwise.
 * A finding that names no app matches nothing and is counted by itself.
 */
export function doctorPlace(row: DoctorRow, problem: Problem, sections: ReadonlySet<string>): 'doctor' | 'coverage' | HealthArea {
  if (COVERAGE.has(problem.code)) return 'coverage'
  const area = AREAS[problem.code]
  return area !== undefined && problem.app !== undefined && sections.has(`${area}:${problem.app}`) ? area : 'doctor'
}

/** Doctor's own issues: the whole-run error and each finding no Health section already counts (`sections` holds `area:app`). */
export function doctorNeedsCount(view: DoctorView | undefined, sections: ReadonlySet<string> = new Set()): number {
  if (!view) return 0
  return Number(view.error !== null) + view.rows.reduce((count, row) => count + row.problems.filter((problem) => doctorPlace(row, problem, sections) === 'doctor').length, 0)
}

export function doctorAge(checkedAt: number | null, now = Date.now()): string {
  if (checkedAt === null) return 'not checked'
  const minutes = Math.max(0, Math.floor((now - checkedAt) / 60000))
  return minutes === 0 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} d ago`
}

export function doctorStateWords(row: DoctorRow): string {
  if (row.state === 'passed') return row.stale ? 'Passed · stale' : 'Passed'
  if (row.state === 'problems') return 'Failed'
  if (row.state === 'timeout') return 'Did not finish · stopped after 60 s'
  if (row.state === 'unsupported') return 'Not supported for this version'
  if (row.state === 'unqualified') return row.check === 'claude' || row.check === 'codex' ? 'Not checked for this version' : 'Not checked yet'
  if (row.state === 'interrupted') return 'Interrupted'
  if (row.state === 'partial') return 'Partly checked'
  return 'Could not run'
}

function nextWords(row: DoctorRow, view: DoctorView): string {
  if (row.state === 'unsupported') return 'BMN could not qualify this read-only doctor.'
  if (row.state === 'unqualified' && (row.check === 'claude' || row.check === 'codex')) return 'BMN tries a disposable profile before checking this version.'
  if (row.stale) return 'Checked again when BMN next starts and a run is due.'
  if (view.retryAtNextStart && !['passed', 'unsupported'].includes(row.state)) return 'Tries once more at the next start.'
  return view.retryUsed ? 'Waits for the next scheduled run or version change.' : 'Checks run automatically when BMN starts.'
}

function CheckedTime(props: { at: number | null; now: number }): React.JSX.Element {
  return <span className="faint" title={props.at === null ? 'No result yet' : new Date(props.at).toLocaleString()}>{doctorAge(props.at, props.now)}</span>
}

const KIND_WORDS: Readonly<Record<DoctorLeftover['kind'], string>> = { memory: 'Memory', skills: 'Skills', plugins: 'Plugins', mcp: 'MCP' }
type Leftover = DoctorRow['leftovers'][number] & { checkedAt: number | null }
export interface LeftoverGroup { key: string; label: string; reasonText: string; items: Leftover[] }

/** Leftovers by app, kind and reason, largest first: what the owner may review, never one row each (Story 96.6). */
export function leftoverGroups(leftovers: readonly Leftover[]): LeftoverGroup[] {
  const groups = new Map<string, LeftoverGroup>()
  for (const item of leftovers) {
    const key = `${item.app ?? 'shared'}:${item.kind}:${item.reason}`
    const group = groups.get(key) ?? { key, label: `${item.app ? ROSTER_APP_NAMES[item.app] : 'Shared'} · ${KIND_WORDS[item.kind]} · ${item.reason.replace(/-/gu, ' ')}`, reasonText: item.reasonText, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
}

/** "13:31": when a doctor result was read. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The Leftovers disclosure and its groups. Each `details` keeps its own open state across refreshes (keyed by group);
 * Enter or Space toggles it with the focus left on its summary, and a focused group that a refresh removed hands the
 * focus to the Leftovers summary instead of dropping it.
 */
function Leftovers(props: { groups: LeftoverGroup[]; total: number; coverage: string[] }): React.JSX.Element {
  const head = useRef<HTMLElement | null>(null)
  const focused = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (focused.current === null || props.groups.some((group) => group.key === focused.current)) return
    focused.current = null
    if (document.activeElement === null || document.activeElement === document.body) head.current?.focus()
  })
  return (
    <details className="advanced leftovers" data-doctor-leftovers={props.total}>
      <summary ref={head}>
        <span>Leftovers · {props.total} in {props.groups.length} group{props.groups.length === 1 ? '' : 's'} · show-only</span>
        {props.coverage.length > 0 ? <span className="faint">Partly checked · {props.coverage.join(' · ')}</span> : null}
      </summary>
      {props.groups.map((group) => (
        <details key={group.key} className="advanced leftover-group" data-doctor-leftover-group={group.key}>
          <summary onFocus={() => { focused.current = group.key }}
            onBlur={(event) => { if (event.currentTarget.isConnected) focused.current = null }}>
            <span>{group.label}</span><span className="count">{group.items.length}</span>
          </summary>
          <p className="faint">{group.reasonText} Review it yourself; BMN leaves it.</p>
          <ul className="leftover-items">
            {group.items.map((item) => (
              <li key={`${item.kind}:${item.app ?? 'shared'}:${item.item}`} data-doctor-leftover={item.kind}>
                <span className="path mono" title={item.location}>{item.location}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </details>
  )
}

/**
 * A Doctor row's lines: each finding counted here on its own, the findings that are a Health row's issue as one line per
 * app and area with how many they are, a coverage note none (it goes on the Leftovers line), a row with none its state.
 */
function doctorLines(row: DoctorRow, sections: ReadonlySet<string>): Array<{ problem: Problem | null; place: 'doctor' | HealthArea; count: number }> {
  if (row.problems.length === 0) return [{ problem: null, place: 'doctor', count: 0 }]
  const lines: Array<{ problem: Problem; place: 'doctor' | HealthArea; count: number }> = []
  for (const problem of row.problems) {
    const place = doctorPlace(row, problem, sections)
    if (place === 'coverage') continue
    const same = place === 'doctor' ? undefined : lines.find((line) => line.place === place && line.problem.app === problem.app)
    if (same) same.count += 1
    else lines.push({ problem, place, count: 1 })
  }
  return lines
}

/**
 * Health › Doctor. `sections` holds each Health section row (`area:app`) that already needs the owner: a Doctor finding of
 * the same app and area is that issue, shown here faint and counted there. Only the page's head is a live status.
 */
export function DoctorHealth(props: { view: DoctorView | undefined; now?: number; sections?: ReadonlySet<string> }): React.JSX.Element {
  const now = props.now ?? Date.now()
  const sections = props.sections ?? new Set<string>()
  const view = props.view ? { ...props.view, rows: props.view.rows.map((row) => ({ ...row, stale: staleAt(row, now) })) } : undefined
  const coverage = view?.rows.flatMap((row) => row.problems.filter((problem) => doctorPlace(row, problem, sections) === 'coverage').map((problem) => problem.reason)) ?? []
  // A leftovers check whose only findings are about coverage says so on the Leftovers line, not as a row of its own.
  const rows = view?.rows.filter((row) => (row.state !== 'passed' || row.stale || row.problems.length > 0) &&
    !(row.check === 'leftovers' && row.problems.length > 0 && row.problems.every((problem) => doctorPlace(row, problem, sections) === 'coverage'))) ?? []
  const leftovers = view?.rows.flatMap((row) => row.leftovers.map((item) => ({ ...item, checkedAt: row.checkedAt }))) ?? []
  const groups = leftoverGroups(leftovers)
  const oldest = view?.rows.reduce<number | null>((at, row) => row.checkedAt === null ? at : at === null ? row.checkedAt : Math.min(at, row.checkedAt), null) ?? null
  const latest = view?.rows.reduce<number | null>((at, row) => row.checkedAt === null ? at : at === null ? row.checkedAt : Math.max(at, row.checkedAt), null) ?? null
  const ran = latest === null ? 'no results yet' : clock(latest)
  return (
    <section aria-labelledby="health-doctor" data-doctor="true">
      <h4 className="group-head" id="health-doctor">Doctor<span className="caption">automatic, read-only</span>
        {view ? <span className="caption" data-doctor-head="true">{view.running ? `Doctor running · results below are from ${ran}` : latest === null ? 'Doctor has not run yet' : `Doctor ran ${ran}`}</span> : null}
      </h4>
      {!view ? <p className="preferences-help">Not checked yet: BMN runs the doctor when it starts.</p> : null}
      {view?.error ? <p className="preferences-error" role="alert">{view.error === 'profile-unavailable' ? 'The selected agent profile is unavailable. Check its location and read access. Earlier results stay below.' : 'Doctor could not complete. Earlier results stay below; inspect the app doctor yourself.'}</p> : null}
      {view?.allWell && !view.running && view.error === null && rows.length === 0 && coverage.length === 0 && sections.size === 0
        ? <p className="preferences-help">All well · {view.rows.length} checks passed · checked {doctorAge(oldest, now)}</p> : null}
      {rows.flatMap((row) => doctorLines(row, sections).map((line) => {
        const { problem, place, count } = line
        const counted = problem !== null && place === 'doctor'
        return (
          <div key={`${row.check}:${problem?.code ?? 'state'}:${problem?.app ?? ''}:${place === 'doctor' ? problem?.item ?? 0 : place}`} className="health-row" data-doctor-check={row.check} data-doctor-state={row.state}
            data-doctor-counted={problem === null ? undefined : place}>
            <span>{problem?.app ? ROSTER_APP_NAMES[problem.app] : LABELS[row.check]}</span>
            <span className="path mono" title={COMMANDS[row.check]}>{COMMANDS[row.check]}</span>
            <span className="health-state">
              <span className={counted || problem === null ? undefined : 'faint'}>{counted ? <Dot label="Needs you" /> : null}{doctorStateWords(row)}{problem ? ` · ${problem.reason}` : ''}{count > 1 ? ` · ${count} findings` : ''}</span>
              {problem && place !== 'doctor' ? <span className="faint">{`The same issue as ${AREA_WORDS[place as HealthArea]} above, counted there.`}</span>
                : problem ? <span className="faint">{problem.fix}</span> : null}
              <span className="faint">{nextWords(row, view!)}</span>
            </span>
            <CheckedTime at={row.checkedAt} now={now} />
          </div>
        )
      }))}
      {groups.length > 0 || coverage.length > 0 ? <Leftovers groups={groups} total={leftovers.length} coverage={coverage} /> : null}
      <details className="advanced">
        <summary>What is checked</summary>
        <p className="preferences-help">BMN reads hooks, skills, tools and rules files. It runs qualified Claude and Codex doctors read-only.</p>
        <p className="preferences-help">Checks run at start when never run, after 24 hours, or after an app version changes.</p>
        <p className="preferences-help">A new version is tried on a disposable profile first. Failed checks retry once at the next start.</p>
        <p className="preferences-help">OpenCode has no qualified doctor. Leftovers stay show-only; BMN leaves their files and contents unchanged.</p>
        {leftovers.length > 0 ? <p className="preferences-help">{view?.locationHelp}</p> : null}
      </details>
    </section>
  )
}
