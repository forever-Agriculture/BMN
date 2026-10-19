// MODULE: grant.test.ts - the Away grant record: departures, cards, answers, uses and the words every surface shares (Story 84.3)
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD, type AwayRecord } from './away'
import {
  EMPTY_GRANT_RECORD,
  GRANT_RECORD_KEY,
  answerGrant,
  askGrant,
  departurePeriodId,
  followAwayChange,
  grantAnswerWords,
  grantButtonWords,
  grantChoiceLabel,
  grantDepartureNotice,
  grantNoChoices,
  grantProposedChoices,
  grantStatus,
  grantStatusLines,
  grantTermChoices,
  markDepartureTold,
  openGrantPeriod,
  parseGrantCardInput,
  readGrantRecord,
  startDeparture,
  useGrant,
  type GrantRecord,
  type GrantTerm
} from './grant'

const T0 = '2026-10-19T19:31:00.000Z'
const T1 = '2026-10-19T19:40:00.000Z'
const T2 = '2026-10-20T04:40:00.000Z'
const empty = (): GrantRecord => ({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] })
const awayRecord = (over: Partial<AwayRecord>): AwayRecord => ({ ...EMPTY_AWAY_RECORD, operations: [], ...over })
const AWAY = awayRecord({ state: 'away', revision: 1, periodId: 'p-1', since: T1, source: 'agent' })
const BACK = awayRecord({ state: 'back', revision: 2, periodId: 'p-1', since: T1, endedAt: T2, source: 'agent', endedBy: 'app' })

const CARD = {
  title: 'Epic 80 · clean up ai slop',
  scope: 'Stories 80.2–80.6, then Epic 81',
  terms: [
    { kind: 'rounds', proposed: 3, reason: '80.3\'s review took two rounds last night; two boundaries are ahead.' },
    { kind: 'merge', id: 'merge-12', repository: 'forever-Agriculture/BMN', pr: 12, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'Its required checks were green at 22:20.' },
    { kind: 'push-default', id: 'push-81', repository: 'forever-agriculture/dev-auto', branch: 'dev-auto/epic-81', proposed: 'yes', reason: 'dev-auto takes no PRs.' }
  ]
}
const card = (over: Record<string, unknown> = {}): { title: string; scope: string; nothing: boolean; terms: GrantTerm[] } => {
  const parsed = parseGrantCardInput({ ...CARD, ...over })
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.card
}

const leaving = (): GrantRecord => {
  const result = startDeparture(empty(), { source: 'agent', agentSessionId: 's-builder', periodId: 'p-1' }, 'back', T0)
  expect(result.outcome).toBe('changed')
  return result.record
}
const asked = (record = leaving(), over: Record<string, unknown> = {}, runId = 'run-80'): GrantRecord => {
  const result = askGrant(record, { runId, sessionId: 's-builder', agentCli: 'claude', card: card(over) }, T0)
  expect(['opened', 'replaced']).toContain(result.outcome)
  return result.record
}
const away = (record: GrantRecord): GrantRecord => followAwayChange(record, awayRecord({}), AWAY, { to: 'away', source: 'agent', outcome: 'changed' }, T1).record
const granted = (record: GrantRecord, choices: Record<string, unknown>, runId = 'run-80', key = 'op-1'): GrantRecord => {
  const revision = openGrantPeriod(record)!.runs.find((run) => run.runId === runId)!.card.revision
  const result = answerGrant(record, { periodId: 'p-1', runId, cardRevision: revision, choices, via: 'app', operationKey: key }, T1)
  expect(result.outcome).toBe('granted')
  return result.record
}
const all = { rounds: 3, 'merge-12': 'pr', 'push-81': 'yes' }

describe('readGrantRecord (84.3 AC4: a malformed row is no grant)', () => {
  it('reads a missing row as the empty start and its own output back unchanged', () => {
    expect(GRANT_RECORD_KEY).toBe('night-grant-v1')
    expect(readGrantRecord(undefined)).toEqual({ state: 'read', record: empty() })
    const record = granted(away(asked()), all)
    expect(readGrantRecord(JSON.stringify(record))).toEqual({ state: 'read', record })
  })

  it('reads anything malformed as unknown with its reason, never as a grant', () => {
    expect(readGrantRecord('{').state).toBe('unknown')
    expect(readGrantRecord(JSON.stringify({ version: 2, revision: 0, periods: [], operations: [] }))).toMatchObject({ state: 'unknown', reason: expect.stringContaining('version') })
    const record = granted(away(asked()), all)
    const broken = JSON.parse(JSON.stringify(record)) as { periods: Array<{ runs: Array<{ answer: { terms: unknown[] } }> }> }
    broken.periods[0]!.runs[0]!.answer.terms = [{ kind: 'force-push', reason: 'x', repository: 'o/r' }]
    expect(readGrantRecord(JSON.stringify(broken)).state).toBe('unknown')
    const twoOpen = { ...record, periods: [record.periods[0], { ...record.periods[0], periodId: 'p-2' }] }
    expect(readGrantRecord(JSON.stringify(twoOpen))).toMatchObject({ state: 'unknown', reason: 'the grant record has two open periods' })
    expect(grantStatus(readGrantRecord('{'), AWAY, 'run-80')).toEqual({ active: false, reason: 'the grant record is not valid JSON, so nothing is granted' })
  })
})

describe('parseGrantCardInput (R84-FR1, FR8; 84.6 AC5)', () => {
  it('takes rounds and the fixed action kinds, numbering items without an id', () => {
    const parsed = card({ terms: [{ kind: 'pr-elsewhere', repository: 'o/dev-auto', proposed: 'no', reason: 'a skill fix' }, { kind: 'rounds', proposed: 2, reason: 'one boundary' }] })
    expect(parsed.terms.map((term) => term.id)).toEqual(['item-1', 'rounds'])
    expect(card().terms[1]).toMatchObject({ repository: 'forever-agriculture/bmn', headSha: '3f2a9c1', upTo: 2 })
  })

  it.each([
    [{ terms: [{ kind: 'force-push', repository: 'o/r', proposed: 'yes', reason: 'r' }] }, 'never on a card'],
    [{ terms: [{ kind: 'release', repository: 'o/r', proposed: 'yes', reason: 'r' }] }, 'never on a card'],
    [{ terms: [{ kind: 'rounds', proposed: 1, reason: 'r' }] }, 'rounds proposes 2, 3 or 4'],
    [{ terms: [{ kind: 'rounds', proposed: 0, reason: 'r' }] }, 'rounds proposes 2, 3 or 4'],
    [{ terms: [{ kind: 'merge', repository: 'o/r', pr: 3, proposed: 'no', reason: 'r' }] }, 'or both'],
    [{ terms: [{ kind: 'merge', repository: 'o/r', pr: 3, headSha: '3f2a9c1', proposed: 'green', reason: 'r' }] }, 'choices the term offers'],
    [{ terms: [{ kind: 'push-default', repository: 'o/r', branch: '../main', proposed: 'yes', reason: 'r' }] }, 'branch'],
    [{ terms: [{ kind: 'pr-elsewhere', repository: 'not a repo', proposed: 'yes', reason: 'r' }] }, 'OWNER/NAME'],
    [{ terms: [{ kind: 'rounds', proposed: 3, reason: 'line\u0007bell' }] }, 'reason'],
    [{ terms: [] }, 'at least one term'],
    [{ nothing: true }, 'asks no terms'],
    [{ extra: 1 }, 'no field "extra"']
  ])('refuses %j', (over, words) => {
    const parsed = parseGrantCardInput({ ...CARD, ...over })
    expect('problem' in parsed && parsed.problem).toContain(words)
  })

  it('takes a run that needs nothing', () => {
    expect(parseGrantCardInput({ title: 'Night', scope: 'Epic 81', nothing: true })).toEqual({ card: { title: 'Night', scope: 'Epic 81', nothing: true, terms: [] } })
  })

  it('offers No first, then narrowest to widest', () => {
    const [rounds, merge, push] = card().terms
    expect(grantTermChoices(rounds!)).toEqual([0, 2, 3, 4])
    expect(grantTermChoices(merge!)).toEqual(['no', 'pr', 'green'])
    expect(grantTermChoices(push!)).toEqual(['no', 'yes'])
    expect(grantTermChoices(merge!).map((choice) => grantChoiceLabel(merge!, choice))).toEqual(['No', 'PR 12 at 3f2a9c1', 'Up to 2 when green'])
  })
})

describe('the departure lifecycle (84.3 AC1; Decisions, departure lifecycle)', () => {
  it('starts a pending departure once, and none while away', () => {
    const record = leaving()
    expect(openGrantPeriod(record)).toMatchObject({ periodId: 'p-1', state: 'leaving', startedBy: 'agent', agentSessionId: 's-builder' })
    expect(departurePeriodId(record)).toBe('p-1')
    expect(startDeparture(record, { source: 'app', agentSessionId: null, periodId: 'p-2' }, 'back', T1).outcome).toBe('unchanged')
    expect(startDeparture(empty(), { source: 'cli', agentSessionId: null, periodId: 'p-2' }, 'away', T1).outcome).toBe('unchanged')
  })

  it('carries the departure into Away, and starts its own period when Away is pressed with none pending', () => {
    const carried = away(leaving())
    expect(openGrantPeriod(carried)).toMatchObject({ periodId: 'p-1', state: 'away', awayAt: T1 })
    const pressed = followAwayChange(empty(), awayRecord({}), { ...AWAY, periodId: 'p-9', source: 'app' }, { to: 'away', source: 'app', outcome: 'changed' }, T1)
    expect(openGrantPeriod(pressed.record)).toMatchObject({ periodId: 'p-9', state: 'away', startedBy: 'app' })
    expect(departurePeriodId(pressed.record)).toBeNull()
  })

  it('changes nothing for a repeated, replayed, stale or refused away change', () => {
    const record = leaving()
    for (const outcome of ['repeated', 'stale', 'invalid']) {
      expect(followAwayChange(record, awayRecord({}), AWAY, { to: 'away', source: 'agent', outcome }, T1)).toEqual({ outcome: 'unchanged', record })
    }
    const already = away(record)
    expect(followAwayChange(already, AWAY, AWAY, { to: 'away', source: 'app', outcome: 'unchanged' }, T1).outcome).toBe('unchanged')
  })

  it('ends the period at Back and withdraws open cards; the answers stay as history', () => {
    const withCards = asked(granted(away(asked()), all), {}, 'run-81')
    const ended = followAwayChange(withCards, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, T2).record
    const period = ended.periods.at(-1)!
    expect(period).toMatchObject({ state: 'ended', endedAt: T2, endedBy: 'app' })
    expect(period.runs.map((run) => [run.runId, run.card.state, run.card.withdrawnFor])).toEqual([['run-80', 'answered', null], ['run-81', 'withdrawn', 'back']])
    expect(period.runs[0]!.answer).not.toBeNull()
    expect(openGrantPeriod(ended)).toBeNull()
  })

  it('cancels a departure on back while only leaving', () => {
    const cancelled = followAwayChange(asked(), awayRecord({}), awayRecord({}), { to: 'back', source: 'telegram', outcome: 'unchanged' }, T1).record
    expect(cancelled.periods.at(-1)).toMatchObject({ state: 'cancelled', endedBy: 'telegram' })
    expect(cancelled.periods.at(-1)!.runs[0]!.card).toMatchObject({ state: 'withdrawn', withdrawnFor: 'not-leaving' })
  })

  it('keeps the current and the previous period only', () => {
    let record = followAwayChange(granted(away(asked()), all), AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, T2).record
    for (const id of ['p-2', 'p-3']) {
      record = startDeparture(record, { source: 'cli', agentSessionId: null, periodId: id }, 'back', T2).record
      record = followAwayChange(record, BACK, BACK, { to: 'back', source: 'cli', outcome: 'unchanged' }, T2).record
    }
    expect(record.periods.map((period) => period.periodId)).toEqual(['p-2', 'p-3'])
  })

  it('remembers who was told, once each', () => {
    let record = markDepartureTold(leaving(), 'p-1', 's-builder').record
    record = markDepartureTold(record, 'p-1', 's-builder').record
    expect(markDepartureTold(record, 'p-0', 's-night').outcome).toBe('unchanged')
    expect(openGrantPeriod(record)!.told).toEqual(['s-builder'])
  })

  it('hands a departure notice only while leaving or away', () => {
    const notice = grantDepartureNotice({ state: 'leaving', startedAt: T0 }, new Date(T0))
    expect(notice).toContain('[BMN state: the owner is leaving since')
    expect(notice).toContain('bmn grant ask --run <run id> --card-file -')
    expect(grantDepartureNotice({ state: 'ended', startedAt: T0 })).toBeNull()
  })
})

describe('askGrant (84.3 AC1)', () => {
  it('refuses without a departure', () => {
    expect(askGrant(empty(), { runId: 'run-80', sessionId: 's', agentCli: 'claude', card: card() }, T0)).toMatchObject({ outcome: 'no-departure' })
  })

  it('opens one card per run, changes nothing for the same terms, and makes a new revision for others', () => {
    const record = asked()
    const run = openGrantPeriod(record)!.runs[0]!
    expect(run).toMatchObject({ runId: 'run-80', title: CARD.title, card: { revision: 1, state: 'open', sessionId: 's-builder', change: null } })
    const same = askGrant(record, { runId: 'run-80', sessionId: 's-other', agentCli: 'codex', card: card() }, T1)
    expect(same.outcome).toBe('unchanged')
    const terms = [{ ...CARD.terms[0], proposed: 4 }, CARD.terms[1]]
    const replaced = askGrant(record, { runId: 'run-80', sessionId: 's-builder', agentCli: 'claude', card: card({ terms }) }, T1)
    expect(replaced.outcome).toBe('replaced')
    expect(replaced.outcome !== 'no-departure' && replaced.run.card).toMatchObject({ revision: 2, state: 'open', change: 'rounds 3 → 4, push to the default branch in dev-auto removed' })
  })

  it('replays an operation key and says "nothing needed" as its own state', () => {
    const first = askGrant(leaving(), { runId: 'run-81', sessionId: 's', agentCli: null, card: card({ nothing: true, terms: undefined }), operationKey: 'k1' }, T0)
    expect(first.outcome).toBe('opened')
    expect(first.outcome !== 'no-departure' && first.run.card.state).toBe('nothing')
    expect(askGrant(first.record, { runId: 'run-81', sessionId: 's', agentCli: null, card: card(), operationKey: 'k1' }, T1).outcome).toBe('repeated')
  })
})

describe('answerGrant (84.3 AC2–AC3)', () => {
  it('stores the answer bound to the run, the terms shown, the period and the revision', () => {
    const record = granted(away(asked()), { rounds: 3, 'merge-12': 'green', 'push-81': 'no' })
    const run = openGrantPeriod(record)!.runs[0]!
    expect(run.card.state).toBe('answered')
    expect(run.answer).toMatchObject({ cardRevision: 1, via: 'app', operationKey: 'op-1', choices: { rounds: 3, 'merge-12': 'green', 'push-81': 'no' } })
    expect(run.answer!.terms).toEqual(run.card.terms)
  })

  it('replays the same operation key and refuses a second answer, a stale revision, a bad choice and an unknown term', () => {
    const record = granted(away(asked()), all)
    const again = (over: Record<string, unknown>) => answerGrant(record, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: all, via: 'telegram', operationKey: 'op-2', ...over }, T2)
    expect(again({ operationKey: 'op-1' }).outcome).toBe('repeated')
    expect(again({})).toMatchObject({ outcome: 'refused', reason: 'answered' })
    const open = asked(away(leaving()))
    const answer = (over: Record<string, unknown>) => answerGrant(open, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: all, via: 'app', operationKey: 'k', ...over }, T1)
    expect(answer({ cardRevision: 2 })).toMatchObject({ outcome: 'refused', reason: 'changed' })
    expect(answer({ choices: { ...all, rounds: 5 } })).toMatchObject({ outcome: 'refused', reason: 'invalid' })
    expect(answer({ choices: { ...all, extra: 'yes' } })).toMatchObject({ outcome: 'refused', reason: 'invalid' })
    expect(answer({ periodId: 'p-0' })).toMatchObject({ outcome: 'refused', reason: 'no-card' })
    for (const refused of [answer({ cardRevision: 2 }), answer({ periodId: 'p-0' })]) expect(refused.record).toBe(open)
  })

  it('refuses an answer after Back or after a cancelled departure', () => {
    const ended = followAwayChange(asked(away(leaving())), AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, T2).record
    expect(answerGrant(ended, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: all, via: 'telegram', operationKey: 'k' }, T2))
      .toMatchObject({ outcome: 'refused', reason: 'withdrawn-back' })
    const cancelled = followAwayChange(asked(), awayRecord({}), awayRecord({}), { to: 'back', source: 'app', outcome: 'unchanged' }, T1).record
    expect(answerGrant(cancelled, { periodId: 'p-1', runId: 'run-80', cardRevision: 1, choices: all, via: 'app', operationKey: 'k' }, T1))
      .toMatchObject({ outcome: 'refused', reason: 'withdrawn-not-leaving' })
  })

  it('keeps an earlier answer in force while a newer revision is open', () => {
    const record = asked(granted(away(asked()), all), { terms: [{ ...CARD.terms[0], proposed: 4 }] })
    const status = grantStatus({ state: 'read', record }, AWAY, 'run-80')
    expect(status).toMatchObject({ active: true, grant: { cardRevision: 1, rounds: 3, newerOpen: 2 } })
    expect(status.active && status.grant.items.map((item) => item.term.id)).toEqual(['merge-12', 'push-81'])
  })
})

describe('grantStatus (84.3 AC4; R84-FR2, FR7)', () => {
  const status = (record: GrantRecord, awayState: Pick<AwayRecord, 'state' | 'periodId'> = AWAY, runId = 'run-80') => grantStatus({ state: 'read', record }, awayState, runId)

  it('prints the terms granted, the period and what is left', () => {
    const result = status(granted(away(asked()), all))
    expect(result).toMatchObject({ active: true, grant: { periodId: 'p-1', periodState: 'away', rounds: 3, roundsUsed: {}, via: 'app', notGranted: [] } })
    expect(result.active && result.grant.items.map((item) => [item.term.id, item.count, item.left])).toEqual([['merge-12', 1, 1], ['push-81', 1, 1]])
  })

  it('says why there is no grant', () => {
    expect(status(empty())).toEqual({ active: false, reason: 'the owner has not said he is leaving and is not away' })
    expect(status(asked(away(leaving())))).toMatchObject({ active: false, reason: expect.stringContaining('unanswered card grants nothing') })
    expect(status(granted(away(asked()), grantNoChoices(card().terms)))).toEqual({ active: false, reason: 'the owner granted none' })
    expect(status(away(asked()), AWAY, 'run-99')).toEqual({ active: false, reason: 'this run has no card in this departure' })
    expect(status(granted(away(asked()), all), awayRecord({ state: 'away', periodId: 'p-2' }))).toEqual({ active: false, reason: 'the away state no longer carries this period' })
    expect(status(granted(away(asked()), all), awayRecord({}), 'run-99')).toMatchObject({ active: false })
    const ended = followAwayChange(granted(away(asked()), all), AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, T2).record
    expect(status(ended, BACK)).toMatchObject({ active: false, reason: expect.stringContaining('the owner is back since') })
    const cancelled = followAwayChange(asked(), awayRecord({}), awayRecord({}), { to: 'back', source: 'app', outcome: 'unchanged' }, T1).record
    expect(status(cancelled, awayRecord({}))).toEqual({ active: false, reason: 'the owner did not leave; that departure was cancelled' })
  })

  it('holds a grant answered while leaving until Away carries another period', () => {
    const record = granted(asked(), all)
    expect(status(record, awayRecord({ state: 'back' }))).toMatchObject({ active: true, grant: { periodState: 'leaving' } })
    expect(status(record, awayRecord({ state: 'away', periodId: 'p-2' }))).toEqual({ active: false, reason: 'the away state names another period' })
  })
})

describe('useGrant (R84-FR3, FR8)', () => {
  const read = (record: GrantRecord) => ({ state: 'read' as const, record })
  const round = (id: string, boundary = '80.3-review') => ({ runId: 'run-80', sessionId: 's-builder', id, kind: 'round' as const, boundary })

  it('records rounds per boundary up to the grant, and refuses past it, keeping the refusal', () => {
    let record = granted(away(asked()), all)
    for (const [index, id] of ['u1', 'u2', 'u3'].entries()) {
      const result = useGrant(read(record), AWAY, round(id), T1)
      expect(result).toMatchObject({ outcome: 'recorded', left: 2 - index })
      record = result.record
    }
    const refused = useGrant(read(record), AWAY, round('u4'), T1)
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'none left' })
    expect(refused.record.periods.at(-1)!.refusals).toEqual([{ runId: 'run-80', kind: 'round', boundary: '80.3-review', item: null, reason: 'none left', at: T1 }])
    expect(useGrant(read(record), AWAY, round('u5', '80.5-acceptance'), T1)).toMatchObject({ outcome: 'recorded', left: 2 })
  })

  it('returns the first record for the same use id and refuses it for another use', () => {
    const first = useGrant(read(granted(away(asked()), all)), AWAY, round('u1'), T1)
    expect(useGrant(read(first.record), AWAY, round('u1'), T1)).toMatchObject({ outcome: 'repeated', left: 2 })
    expect(useGrant(read(first.record), AWAY, round('u1', 'other'), T1)).toMatchObject({ outcome: 'refused', reason: 'that use id was recorded for another use' })
  })

  it('records an item use only while it is granted and left', () => {
    const record = granted(away(asked()), { ...all, 'push-81': 'no' })
    const merge = useGrant(read(record), AWAY, { runId: 'run-80', sessionId: 's', id: 'm1', kind: 'action', item: 'merge-12' }, T1)
    expect(merge).toMatchObject({ outcome: 'recorded', left: 0 })
    expect(useGrant(read(merge.record), AWAY, { runId: 'run-80', sessionId: 's', id: 'm2', kind: 'action', item: 'merge-12' }, T1)).toMatchObject({ outcome: 'refused', reason: 'none left' })
    expect(useGrant(read(record), AWAY, { runId: 'run-80', sessionId: 's', id: 'p1', kind: 'action', item: 'push-81' }, T1)).toMatchObject({ outcome: 'refused', reason: 'not on the card' })
    expect(useGrant(read(record), BACK, round('r1'), T1)).toMatchObject({ outcome: 'refused' })
    expect(useGrant({ state: 'unknown', reason: 'the grant record is not valid JSON' }, AWAY, round('r1'), T1)).toMatchObject({ outcome: 'refused' })
  })

  it('counts a boundary\'s rounds across the kept periods', () => {
    let record = granted(away(asked()), all)
    record = useGrant(read(record), AWAY, round('u1'), T1).record
    record = useGrant(read(record), AWAY, round('u2'), T1).record
    record = followAwayChange(record, AWAY, BACK, { to: 'back', source: 'app', outcome: 'changed' }, T2).record
    record = startDeparture(record, { source: 'agent', agentSessionId: 's', periodId: 'p-2' }, 'back', T2).record
    record = askGrant(record, { runId: 'run-80', sessionId: 's', agentCli: 'claude', card: card() }, T2).record
    const second = { ...AWAY, periodId: 'p-2' }
    record = followAwayChange(record, BACK, second, { to: 'away', source: 'agent', outcome: 'changed' }, T2).record
    record = answerGrant(record, { periodId: 'p-2', runId: 'run-80', cardRevision: 1, choices: all, via: 'telegram', operationKey: 'op-n2' }, T2).record
    const status = grantStatus(read(record), second, 'run-80')
    expect(status.active && status.grant.roundsUsed).toEqual({ '80.3-review': 2 })
    expect(useGrant(read(record), second, round('u3'), T2)).toMatchObject({ outcome: 'recorded', left: 0 })
  })
})

describe('the card\'s words (the notes §1)', () => {
  it('names the primary button by what the choices grant', () => {
    const terms = card().terms
    expect(grantButtonWords(terms, grantProposedChoices(terms))).toBe('Grant all')
    expect(grantButtonWords(terms, { ...grantProposedChoices(terms), 'push-81': 'no' })).toBe('Grant 2 of 3')
    expect(grantButtonWords(terms, grantNoChoices(terms))).toBe('Grant none')
    expect(grantButtonWords([terms[0]!], { rounds: 3 })).toBe('Grant')
  })

  it('words an answer as granted and not granted', () => {
    expect(grantAnswerWords(card().terms, { rounds: 3, 'merge-12': 'pr', 'push-81': 'no' })).toEqual({
      granted: ['3 rounds per boundary', 'merge PR 12 at 3f2a9c1'], notGranted: ['push to the default branch in dev-auto']
    })
  })
})

describe('named actions for the night (Story 84.6)', () => {
  const read = (record: GrantRecord) => ({ state: 'read' as const, record })

  it('lists each granted item with its kind, target, condition and what is left, and the rules every item keeps (AC1, AC3)', () => {
    const record = granted(away(asked()), all)
    const lines = grantStatusLines('run-80', grantStatus(read(record), AWAY, 'run-80'))
    expect(lines).toContain('  Item merge-12: merge PR 12 in forever-agriculture/bmn, only at head 3f2a9c1; another head waits; 1 of 1 left.')
    expect(lines).toContain('  Item push-81: push dev-auto/epic-81 to the default branch of forever-agriculture/dev-auto, never forced; 1 of 1 left.')
    expect(lines).toContain('  Every item: no admin bypass; a PR that changes CI or workflows, or deploys, still asks; a different target, run or condition waits.')
    const green = granted(away(asked()), { ...all, 'merge-12': 'green' })
    expect(grantStatusLines('run-80', grantStatus(read(green), AWAY, 'run-80'))).toContain(
      '  Item merge-12: merge this run\'s PRs in forever-agriculture/bmn, each only when its required checks are all green; 2 of 2 left.')
    const rounds = granted(away(asked()), { ...all, 'merge-12': 'no', 'push-81': 'no' })
    expect(grantStatusLines('run-80', grantStatus(read(rounds), AWAY, 'run-80')).some((line) => line.startsWith('  Every item'))).toBe(false)
  })

  it('refuses another run\'s item, and a card naming anything outside the three actions (AC2, AC5)', () => {
    const record = granted(away(asked()), all)
    expect(useGrant(read(record), AWAY, { runId: 'run-81', sessionId: 's', id: 'x1', kind: 'action', item: 'merge-12' }, T1)).toMatchObject({ outcome: 'refused' })
    for (const kind of ['force-push', 'delete-branch', 'release', 'publish']) {
      const parsed = parseGrantCardInput({ ...CARD, terms: [{ kind, id: 'x', repository: 'octo/widgets', proposed: 'yes', reason: 'tonight' }] })
      expect(parsed).toMatchObject({ problem: expect.stringContaining('are never on a card') })
    }
  })
})
