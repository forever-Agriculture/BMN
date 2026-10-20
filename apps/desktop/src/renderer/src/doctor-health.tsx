// MODULE: doctor-health.tsx - Approved automatic Health doctor, with show-only leftovers excluded from attention
import { ROSTER_APP_NAMES, type DoctorCheck, type DoctorRow, type DoctorView } from '@bmn/protocol'
import { useEffect, useState } from 'react'
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

export function doctorNeedsCount(view: DoctorView | undefined): number {
  if (!view) return 0
  return Number(view.error !== null) + view.rows.reduce((count, row) => count + row.problems.length, 0)
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

export function DoctorHealth(props: { view: DoctorView | undefined; now?: number }): React.JSX.Element {
  const now = props.now ?? Date.now()
  const view = props.view ? { ...props.view, rows: props.view.rows.map((row) => ({ ...row, stale: staleAt(row, now) })) } : undefined
  const rows = view?.rows.filter((row) => row.state !== 'passed' || row.stale || row.problems.length > 0) ?? []
  const leftovers = view?.rows.flatMap((row) => row.leftovers.map((item) => ({ ...item, checkedAt: row.checkedAt }))) ?? []
  const oldest = view?.rows.reduce<number | null>((at, row) => row.checkedAt === null ? at : at === null ? row.checkedAt : Math.min(at, row.checkedAt), null) ?? null
  return (
    <section aria-labelledby="health-doctor" data-doctor="true">
      <h4 className="group-head" id="health-doctor">Doctor<span className="caption">automatic, read-only</span></h4>
      {!view ? <p className="preferences-help">Not checked yet: BMN runs the doctor when it starts.</p> : null}
      {view?.running ? <p className="preferences-help" role="status">Checking now</p> : null}
      {view?.error ? <p className="preferences-error" role="alert">{view.error === 'profile-unavailable' ? 'The selected agent profile is unavailable. Check its location and read access. Earlier results stay below.' : 'Doctor could not complete. Earlier results stay below; inspect the app doctor yourself.'}</p> : null}
      {view?.allWell && !view.running && view.error === null && rows.length === 0 ? <p className="preferences-help" role="status">All well · {view.rows.length} checks passed · checked {doctorAge(oldest, now)}</p> : null}
      {rows.flatMap((row) => (row.problems.length > 0 ? row.problems : [null]).map((problem) => (
        <div key={`${row.check}:${problem?.code ?? 'state'}:${problem?.item ?? 0}`} className="health-row" data-doctor-check={row.check} data-doctor-state={row.state}>
          <span>{problem?.app ? ROSTER_APP_NAMES[problem.app] : LABELS[row.check]}</span>
          <span className="path mono" title={COMMANDS[row.check]}>{COMMANDS[row.check]}</span>
          <span className="health-state">
            <span>{problem ? <Dot label="Needs you" /> : null}{doctorStateWords(row)}{problem ? ` · ${problem.reason}` : ''}</span>
            {problem ? <span className="faint">{problem.fix}</span> : null}
            <span className="faint">{nextWords(row, view!)}</span>
          </span>
          <CheckedTime at={row.checkedAt} now={now} />
        </div>
      )))}
      {leftovers.map((item) => (
        <div key={`${item.kind}:${item.app ?? 'shared'}:${item.item}`} className="health-row" data-doctor-leftover={item.kind}>
          <span>{item.app ? ROSTER_APP_NAMES[item.app] : 'Shared skills'}</span>
          <span className="path mono" title={item.location}>{item.location}</span>
          <span className="health-state"><span>Leftover · {item.reasonText}</span><span className="faint">Review it yourself; BMN leaves it.</span></span>
          <CheckedTime at={item.checkedAt} now={now} />
        </div>
      ))}
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
