// MODULE: grant-reoffers.ts - a short return offers identical previously granted lines, with no authority before a fresh answer
import { grantAnswerWords, grantChoice, type GrantAnswer, type GrantChoice, type GrantPeriod, type GrantRecord, type GrantRun, type GrantTerm } from './grant'

export interface GrantReoffer {
  runId: string
  at: string
  choices: Record<string, GrantChoice>
  changed: string[]
}

const canReoffer = (term: GrantTerm): boolean => term.kind !== 'access' && term.kind !== 'limit'

/** Proposals and their limits are part of the line. Its id and explanatory words carry no permission. */
function sameLine(left: GrantTerm, right: GrantTerm): boolean {
  const semantic = (term: GrantTerm): string => JSON.stringify(Object.entries(term)
    .filter(([key]) => key !== 'id' && key !== 'reason').sort(([a], [b]) => a.localeCompare(b)))
  return !(left.kind === 'merge' && (left.headSha === null || right.kind !== 'merge' || right.headSha === null)) && semantic(left) === semantic(right)
}

function priorOffers(record: GrantRecord, period: GrantPeriod): Array<{ runId: string; title: string; endedAt: string; answer: GrantAnswer }> {
  const prior = record.offers ?? record.periods.filter(other => other.periodId !== period.periodId && other.state === 'ended' && other.endedAt !== null)
    .flatMap(other => other.runs.filter(run => run.answer !== null).map(run => ({ runId: run.runId, title: run.title, endedAt: other.endedAt!, answer: run.answer! })))
  return prior.filter(offer => Date.parse(period.startedAt) - Date.parse(offer.endedAt) >= 0 &&
    Date.parse(period.startedAt) - Date.parse(offer.endedAt) < 12 * 60 * 60_000)
}

export function grantReoffer(record: GrantRecord, period: GrantPeriod, run: GrantRun): GrantReoffer | null {
  const before = priorOffers(record, period).findLast(offer => offer.runId === run.runId)?.answer
  if (before === undefined) return null
  const choices: Record<string, GrantChoice> = {}
  const changed: string[] = []
  const matched = new Set<string>()
  for (const term of run.card.terms.filter(canReoffer)) {
    const old = before.terms.find(other => !matched.has(other.id) && sameLine(term, other))
    if (old !== undefined) matched.add(old.id)
    const choice = old === undefined ? undefined : grantChoice(before.choices, old.id)
    if (choice !== undefined && choice !== 'no' && choice !== 0) choices[term.id] = choice
    else if (old === undefined) changed.push(term.id)
  }
  return { runId: run.runId, at: before.at, choices, changed }
}

/** A run that has not asked again is only history: no card, choices or grant is created. */
export function grantNotAskedAgain(record: GrantRecord, period: GrantPeriod): Array<{ runId: string; title: string; at: string; granted: string[] }> {
  return priorOffers(record, period).filter(run => !period.runs.some(other => other.runId === run.runId) &&
    run.answer.terms.some(term => {
      const choice = grantChoice(run.answer.choices, term.id)
      return canReoffer(term) && choice !== undefined && choice !== 'no' && choice !== 0
    }))
    .map(run => ({ runId: run.runId, title: run.title, at: run.answer.at, granted: grantAnswerWords(run.answer.terms.filter(canReoffer), run.answer.choices).granted }))
}
