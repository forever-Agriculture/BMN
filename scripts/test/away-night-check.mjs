// MODULE: away-night-check.mjs - Story 113.6 AC4: the night's account read back after Back must match the wake's own log lines
// Pure. `account` is `bmn away --night --json`; `lines` are away-wake.log lines; `reasonCode` and `reasons` are
// awayWakeReasonCode and AWAY_WAKE_REASONS from @bmn/protocol (built), so the check and BMN map a skip the same way.

const TYPED = /^(\S+) away wake: typed the wake line into (\S+) \(period (\S+), tick (\d+)\)$/u
const SKIPPED = /^(\S+) away wake: skipped (\S+) \(period (\S+), tick (\d+)\): (.+)$/u

/** The log's decisions of one period, per session, in tick order. */
export function logDecisions(lines, periodId) {
  const sessions = new Map()
  for (const line of lines) {
    const typed = TYPED.exec(line)
    const skipped = typed ? null : SKIPPED.exec(line)
    const match = typed ?? skipped
    if (!match || match[3] !== periodId) continue
    const row = { tick: Number(match[4]), typed: Boolean(typed), reason: skipped ? skipped[5] : null }
    sessions.set(match[2], [...(sessions.get(match[2]) ?? []), row])
  }
  for (const rows of sessions.values()) rows.sort((a, b) => a.tick - b.tick)
  return sessions
}

/**
 * Every mismatch between the account and the log: a session the log typed into that the account does not read woken, a
 * skipped one read in the wrong class or with another reason, a session the account decided that the log never names,
 * and a tick the log decided that the account reads as an unknown hour. Empty when they agree.
 */
export function nightMismatches(account, lines, reasonCode, reasons) {
  const mismatches = []
  const decided = logDecisions(lines, account.periodId)
  const where = new Map()
  for (const [state, rows] of [['woken', account.woken], ['skipped', account.skipped], ['missed', account.missed]]) {
    for (const row of rows) where.set(row.sessionId, { state, reason: row.reason })
  }
  for (const [sessionId, rows] of decided) {
    const got = where.get(sessionId)
    let want
    if (rows.some((row) => row.typed)) want = { state: 'woken', reason: null }
    else {
      const codes = rows.map((row) => reasonCode(row.reason))
      const missed = codes.filter((code) => reasons[code].missed)
      want = missed.length > 0 ? { state: 'missed', reason: missed.at(-1) } : { state: 'skipped', reason: codes.at(-1) }
    }
    if (!got || got.state !== want.state || got.reason !== want.reason) mismatches.push({ sessionId, account: got ?? null, log: want })
  }
  for (const sessionId of where.keys()) if (!decided.has(sessionId)) mismatches.push({ sessionId, account: where.get(sessionId), log: null })
  const since = Date.parse(account.since)
  const ticks = new Set([...decided.values()].flatMap((rows) => rows.map((row) => row.tick)))
  for (const tick of ticks) {
    const at = since + tick * account.everyMs
    const span = account.unknownSpans.find((item) => Date.parse(item.from) <= at && at < Date.parse(item.to))
    if (span) mismatches.push({ tick, account: span, log: 'decided' })
  }
  if (account.ticks.swept < ticks.size) mismatches.push({ ticks: account.ticks, log: ticks.size })
  return mismatches
}
