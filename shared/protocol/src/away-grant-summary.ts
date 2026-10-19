// MODULE: away-grant-summary.ts - the summary's Granted section: what each run's card granted and what the night used of it, BMN's record and the agent's report told apart (Story 84.7, the notes §4)
import { awayMomentWords } from './away'
import { pad } from './shared-helpers'
import {
  grantShortName,
  grantTermLabel,
  type GrantActionTerm,
  type GrantCarried,
  type GrantChoice,
  type GrantAnswer,
  type GrantPeriod,
  type GrantRefusal,
  type GrantReport,
  type GrantRun,
  type GrantTerm,
  type GrantUse
} from './grant'

/** The notes' bounds: per run 10 boundaries and 10 refusals, then "N more"; 20 runs, as the other run lists. */
export const AWAY_GRANT_LIMITS = Object.freeze({ boundaries: 10, refusals: 10, runs: 20 })

/** Who a line comes from: BMN wrote it itself, or an agent told BMN about the world (the split Epic 76 draws). */
type AwayGrantSource = 'BMN\'s record' | 'the agent\'s report'
const AWAY_GRANT_RECORD: AwayGrantSource = 'BMN\'s record'
const AWAY_GRANT_REPORT: AwayGrantSource = 'the agent\'s report'

export interface AwayGrantLine { label: string; text: string; source: AwayGrantSource }
/** One run, once: its title, used, unused or none, and one line of BMN's record; the lines open in place. */
interface AwayGrantRow { key: string; title: string; state: 'used' | 'unused' | 'none'; text: string; lines: AwayGrantLine[] }
export interface AwayGrantSection { count: number; rows: AwayGrantRow[]; more: string | null; empty: string | null }

const clock = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '--:--' : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
const ordinal = (value: number): string => {
  const tens = value % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'
  return `${value}${suffix}`
}
const isNo = (choice: GrantChoice | undefined): boolean => choice === undefined || choice === 'no' || choice === 0

/** A granted term in full, as the opened row's Granted lines name it. */
function grantedWords(term: GrantTerm, choice: GrantChoice): string {
  if (term.kind === 'rounds') return `${choice} extra rounds per boundary`
  if (term.kind === 'merge') {
    return choice === 'green'
      ? `Merge up to ${term.upTo ?? 1} of this run's PRs in ${term.repository} when green`
      : `Merge PR ${term.pr} in ${term.repository}${term.headSha === null ? '' : ` at ${term.headSha.slice(0, 7)}`}`
  }
  if (term.kind === 'push-default') return `Push ${term.branch} to the default branch in ${term.repository}${term.count > 1 ? `, up to ${term.count}` : ''}`
  return `${grantTermLabel(term)}${term.count > 1 ? `, up to ${term.count}` : ''}`
}

/** An action item's own label: "Merge PR 12", "Merge when green", "Push to the default branch", "PR in NAME". */
function itemLabel(term: GrantActionTerm | undefined, id: string | null, choice?: GrantChoice): string {
  if (term === undefined) return `Item ${id ?? 'unnamed'}`
  if (term.kind === 'merge') return choice === 'green' ? 'Merge when green' : `Merge PR ${term.pr}`
  if (term.kind === 'push-default') return 'Push to the default branch'
  return `PR in ${term.repository.split('/')[1] ?? term.repository}`
}

/** What an action's done report says when the agent gave no words of its own. */
function doneWords(term: GrantActionTerm | undefined): string {
  if (term?.kind === 'merge') return 'Merged'
  if (term?.kind === 'push-default') return 'Pushed'
  return 'Done'
}

/** BMN's refusal reason in the notes' words; one BMN words otherwise stands as it was kept. */
function awayGrantRefusalWords(reason: string): string {
  if (/^the owner is back since/u.test(reason) || reason === 'the away state no longer carries this period') return 'you were back'
  if (reason === 'the owner did not leave; that departure was cancelled') return 'you did not leave'
  if (reason === 'that use id was recorded for another use') return 'its use id was another use\'s'
  return reason
}

/** A refused answer of his own, in the notes' words: "Your answer from Telegram at 22:39: the card had changed". */
function answerRefusalWords(refusal: GrantRefusal): string {
  const why = refusal.reason === 'changed' ? 'the card had changed'
    : refusal.reason === 'withdrawn-back' ? 'you were back'
      : refusal.reason === 'withdrawn-not-leaving' ? 'you did not leave'
        : refusal.reason === 'answered' ? 'it was already answered' : 'BMN could not save it'
  return `Your answer ${refusal.via === 'telegram' ? 'from Telegram' : 'here'} at ${clock(refusal.at)}: ${why}`
}

/** The round outcome the agent reported, as the notes word it. */
function roundOutcomeWords(boundary: string, round: number, report: GrantReport): string {
  const words = report.result === 'passed' ? `${boundary} passed after round ${round}`
    : report.result === 'blocked' ? `${boundary} parked BLOCKED after round ${round}`
      : `${boundary} still failing after round ${round}`
  return report.text === null ? words : `${words} · ${report.text}`
}

/**
 * One run's row: BMN's record on its one line, then every line opened with its source. Rounds count as `bmn grant` counts
 * them, over the periods up to this one and the rounds carried from those no longer kept; times and outcomes are this period's.
 */
function grantRow(run: GrantRun, period: GrantPeriod, earlier: readonly GrantPeriod[], carried: readonly GrantCarried[], now: Date): { row: AwayGrantRow; granted: boolean } {
  const lines: AwayGrantLine[] = []
  const add = (label: string, text: string, source: AwayGrantSource): void => { lines.push({ label, text, source }) }
  // Every answer he gave this period, oldest first: a use is read against the answer it was recorded under.
  const answers: GrantAnswer[] = [...run.earlier, ...(run.answer === null ? [] : [run.answer])]
  const answer = run.answer
  const roundsOf = (given: GrantAnswer): number => given.terms.some((term) => term.kind === 'rounds') && typeof given.choices.rounds === 'number' ? given.choices.rounds : 0
  const itemsOf = (given: GrantAnswer): GrantActionTerm[] => given.terms.filter((term): term is GrantActionTerm => term.kind !== 'rounds' && !isNo(given.choices[term.id]))
  const grants = (given: GrantAnswer): boolean => roundsOf(given) > 0 || itemsOf(given).length > 0
  const terms = answer?.terms ?? run.card.terms
  const choices = answer?.choices ?? {}
  const roundsTerm = terms.find((term) => term.kind === 'rounds') ?? answers.flatMap((given) => given.terms).find((term) => term.kind === 'rounds')
  const rounds = answer === null ? 0 : roundsOf(answer)
  const roundsShown = Math.max(0, ...answers.map(roundsOf))
  const notGranted = terms.filter((term) => answer === null || (term.kind === 'rounds' ? rounds === 0 : isNo(choices[term.id])))
  const granted = answers.some(grants)
  const uses = period.uses.filter((use) => use.runId === run.runId)
  const reports = period.reports.filter((report) => report.runId === run.runId)
  const refusals = period.refusals.filter((refusal) => refusal.runId === run.runId)
  const answerFor = (revision: number | undefined): GrantAnswer | undefined => answers.find((given) => given.cardRevision === revision)
  const termOf = (id: string | null, revision?: number): GrantActionTerm | undefined =>
    [answerFor(revision)?.terms ?? [], terms, ...answers.map((given) => given.terms).reverse()].flat()
      .find((term): term is GrantActionTerm => term.kind !== 'rounds' && term.id === id)
  const choiceOf = (id: string | null, revision?: number): GrantChoice | undefined => id === null ? undefined : (answerFor(revision) ?? answer)?.choices[id]

  // Granted, or why nothing was: each answer with when and where, or the card's state.
  for (const given of answers) {
    const revision = answers.length > 1 ? ` · card revision ${given.cardRevision}` : ''
    add('Granted', `${awayMomentWords(given.at, now)} ${given.via === 'telegram' ? 'from Telegram' : 'here'}${grants(given) ? '' : ' · none'}${revision}`, AWAY_GRANT_RECORD)
    const rounds = given.terms.find((term) => term.kind === 'rounds')
    if (roundsOf(given) > 0) add('Granted', grantedWords(rounds!, roundsOf(given)), AWAY_GRANT_RECORD)
    for (const term of itemsOf(given)) add('Granted', grantedWords(term, given.choices[term.id]!), AWAY_GRANT_RECORD)
  }
  if (answers.length === 0 && run.card.state === 'nothing') {
    add('Granted', 'Nothing asked: the run needed nothing for the night', AWAY_GRANT_RECORD)
  } else if (answers.length === 0) {
    const withdrawn = run.card.state === 'withdrawn' ? `; withdrawn ${run.card.withdrawnFor === 'not-leaving' ? 'when you did not leave' : 'at back'}` : ''
    add('Granted', `Nothing: card unanswered${withdrawn}`, AWAY_GRANT_RECORD)
  }
  for (const term of notGranted) add('Not granted', term.kind === 'rounds' ? `${term.proposed} extra rounds per boundary` : grantTermLabel(term), AWAY_GRANT_RECORD)

  // Rounds per boundary: BMN's record of each use, then the agent's step-back and outcome reports.
  const roundUses = uses.filter((use): use is GrantUse & { boundary: string } => use.kind === 'round' && use.boundary !== null)
  const boundaries = [...new Set(roundUses.map((use) => use.boundary))]
  const earlierUses = (other: GrantPeriod, boundary: string): number => other.uses.filter((use) => use.runId === run.runId && use.kind === 'round' && use.boundary === boundary).length
  const carriedFor = (boundary: string): number => carried.filter((entry) => entry.runId === run.runId && entry.boundary === boundary).reduce((sum, entry) => sum + entry.rounds, 0)
  const before = (boundary: string): number => carriedFor(boundary) + earlier.reduce((sum, other) => sum + earlierUses(other, boundary), 0)
  const periodsBefore = (boundary: string): number => (carriedFor(boundary) > 0 ? 2 : 0) + earlier.filter((other) => earlierUses(other, boundary) > 0).length
  const roundNumber = new Map<string, number>()
  for (const boundary of boundaries) {
    const earlierCount = before(boundary)
    roundUses.filter((use) => use.boundary === boundary).forEach((use, index) => roundNumber.set(use.id, earlierCount + index + 1))
  }
  const summaryParts: string[] = []
  for (const boundary of boundaries.slice(0, AWAY_GRANT_LIMITS.boundaries)) {
    const mine = roundUses.filter((use) => use.boundary === boundary)
    const used = before(boundary) + mine.length
    const left = Math.max(0, rounds - used)
    const earlierWords = before(boundary) > 0 ? ` · ${before(boundary)} in ${periodsBefore(boundary) > 1 ? 'earlier periods' : 'an earlier period'}` : ''
    add('Rounds', `${boundary}: ${used} of ${roundsShown} used${left > 0 ? `, ${left} left` : ''} · ${mine.map((use) => clock(use.at)).join(', ')}${earlierWords}`, AWAY_GRANT_RECORD)
    summaryParts.push(`${summaryParts.length === 0 ? 'Rounds ' : ''}${used} of ${roundsShown} at ${boundary}`)
  }
  if (boundaries.length > AWAY_GRANT_LIMITS.boundaries) add('Rounds', `${boundaries.length - AWAY_GRANT_LIMITS.boundaries} more boundaries`, AWAY_GRANT_RECORD)
  const roundsPart = summaryParts.join(', ')
  for (const report of reports.filter((item) => item.kind === 'step-back' && item.boundary !== null)) {
    const round = before(report.boundary!) + roundUses.filter((use) => use.boundary === report.boundary && use.at <= report.at).length + 1
    add('Step back', `${report.boundary}, before round ${round}: ${report.text ?? ''}`, AWAY_GRANT_REPORT)
  }
  const latest = (use: GrantUse): GrantReport | undefined => reports.filter((report) => report.kind === 'outcome' && report.useId === use.id).at(-1)
  for (const use of roundUses) {
    const report = latest(use)
    if (report !== undefined && report.result !== 'uncertain') add('Outcome', roundOutcomeWords(use.boundary, roundNumber.get(use.id)!, report), AWAY_GRANT_REPORT)
  }

  // Each granted item: BMN's record of its uses, then what the agent reported each one did.
  const actionUses = uses.filter((use) => use.kind === 'action')
  const itemParts: string[] = []
  for (const given of answers) {
    for (const term of itemsOf(given)) {
      const choice = given.choices[term.id]!
      const label = itemLabel(term, term.id, choice)
      const mine = actionUses.filter((use) => use.item === term.id && use.cardRevision === given.cardRevision)
      const count = term.kind === 'merge' ? (choice === 'green' ? term.upTo ?? 1 : 1) : term.count
      if (mine.length === 0) continue
      add(label, `Used ${mine.length} of ${count} · ${mine.map((use) => clock(use.at)).join(', ')}`, AWAY_GRANT_RECORD)
      for (const use of mine) {
        const report = latest(use)
        if (report?.result === 'done') add(label, `${report.text ?? doneWords(term)} · ${clock(report.at)}`, AWAY_GRANT_REPORT)
      }
      itemParts.push(`${grantShortName(term, choice)} used${count > 1 ? ` ${mine.length} of ${count}` : ''}`)
    }
  }

  // Refused: BMN's refusals and the steps the agent reported refused, oldest first.
  const refused: Array<{ at: string; text: string; source: AwayGrantSource }> = []
  for (const refusal of refusals) {
    if (refusal.kind === 'answer') { refused.push({ at: refusal.at, text: answerRefusalWords(refusal), source: AWAY_GRANT_RECORD }); continue }
    const what = refusal.kind === 'round' && refusal.boundary !== null
      ? `${refusal.boundary}, a ${ordinal(before(refusal.boundary) + roundUses.filter((use) => use.boundary === refusal.boundary && use.at <= refusal.at).length + 1)} round`
      : itemLabel(termOf(refusal.item), refusal.item, choiceOf(refusal.item))
    refused.push({ at: refusal.at, text: `${what}: ${awayGrantRefusalWords(refusal.reason)} · ${clock(refusal.at)}`, source: AWAY_GRANT_RECORD })
  }
  for (const report of reports) {
    const outcomeRefused = report.kind === 'outcome' && report.result === 'refused' && actionUses.some((use) => use.id === report.useId && latest(use) === report)
    if (report.kind !== 'refused' && !outcomeRefused) continue
    const used = report.useId === null ? undefined : actionUses.find((use) => use.id === report.useId)
    refused.push({ at: report.at, text: `${itemLabel(termOf(report.item, used?.cardRevision), report.item, choiceOf(report.item, used?.cardRevision))}: ${report.text ?? 'refused'} · ${clock(report.at)}`, source: AWAY_GRANT_REPORT })
  }
  refused.sort((a, b) => a.at.localeCompare(b.at))
  for (const item of refused.slice(0, AWAY_GRANT_LIMITS.refusals)) add('Refused', item.text, item.source)
  if (refused.length > AWAY_GRANT_LIMITS.refusals) add('Refused', `${refused.length - AWAY_GRANT_LIMITS.refusals} more`, AWAY_GRANT_RECORD)

  // Missing: a use with no outcome, or one the agent could not tell; while away, one may still be running.
  const open = period.state === 'leaving' || period.state === 'away'
  let missing = 0
  for (const use of uses) {
    const report = latest(use)
    if (report !== undefined && report.result !== 'uncertain') continue
    missing += 1
    const what = use.kind === 'round' && use.boundary !== null ? `${use.boundary}, round ${roundNumber.get(use.id)}` : itemLabel(termOf(use.item, use.cardRevision), use.item, choiceOf(use.item, use.cardRevision))
    add('Missing', `${what}: ${report === undefined ? `no outcome reported${open ? ' yet' : ''}` : 'outcome uncertain'}`, AWAY_GRANT_RECORD)
  }
  if (period.state === 'ended' && period.endedAt !== null) add('Ended', `${awayMomentWords(period.endedAt, now)} at back`, AWAY_GRANT_RECORD)

  // The row's one line is BMN's record only, so it needs no label (the notes §4 Row).
  let text: string
  let state: AwayGrantRow['state']
  const shown = [...answers].reverse().find(grants)
  if (answers.length === 0) {
    state = 'none'
    text = run.card.state === 'nothing' ? 'Needed nothing'
      : run.card.state === 'withdrawn' ? `Card unanswered; withdrawn ${run.card.withdrawnFor === 'not-leaving' ? 'when you did not leave' : 'at back'}` : 'Card unanswered'
  } else if (!granted) {
    state = 'none'
    text = 'You granted none'
  } else if (uses.length === 0) {
    state = 'unused'
    text = `${[...(roundsOf(shown!) > 0 ? [grantShortName(roundsTerm!, roundsOf(shown!))] : []), ...itemsOf(shown!).map((term) => grantShortName(term, shown!.choices[term.id]!))].join(', ')} granted; none used`
  } else {
    state = 'used'
    text = [roundsPart, ...itemParts].filter(Boolean).join(' · ')
  }
  const tail = [...(refusals.length > 0 ? [`${refusals.length} refused`] : []), ...(missing > 0 ? [`${missing} missing`] : [])]
  if (tail.length > 0) text = [text, ...tail].join(' · ')
  return { row: { key: `${period.periodId}\u0000${run.runId}`, title: run.title, state, text, lines }, granted }
}

/**
 * Story 84.7 AC1–AC2: the period's Granted section, or null when the period holds no grant, so the summary is as before.
 * Once one run holds a grant, every run that asked is listed, so what was asked and not granted shows too. `periods` are
 * the kept grant periods, oldest first; `null` is a grant record BMN could not read, which the section says.
 */
export function awayGrantSection(periods: readonly GrantPeriod[] | null, periodId: string | null, now: Date, carried: readonly GrantCarried[] = []): AwayGrantSection | null {
  if (periods === null) return { count: 0, rows: [], more: null, empty: 'Grant records could not be read.' }
  const index = periods.findIndex((period) => period.periodId === periodId)
  if (index < 0) return null
  const period = periods[index]!
  const built = period.runs.map((run) => grantRow(run, period, periods.slice(0, index), carried, now))
  const count = built.filter((item) => item.granted).length
  if (count === 0) return null
  return {
    count,
    rows: built.slice(0, AWAY_GRANT_LIMITS.runs).map((item) => item.row),
    more: built.length > AWAY_GRANT_LIMITS.runs ? `${built.length - AWAY_GRANT_LIMITS.runs} more · dev-auto runs…` : null,
    empty: null
  }
}
