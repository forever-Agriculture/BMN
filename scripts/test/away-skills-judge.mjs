// MODULE: away-skills-judge.mjs - 113.3 method 5: the judge of one native Away moment, qualified on real runs before use
// Pure. Every check is PASS, FAIL or UNVERIFIABLE (evidence the run did not keep); a moment passes only when all pass.
import { candidatesRead } from './away-skills-decode.mjs'

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('\n') : ''

/**
 * The texts that reached the agent from outside it, by the envelopes each app uses for hook context (Astra 145719):
 * Codex, a developer-role message (the hook's additional context); Claude, a `hook_additional_context` attachment. A tool
 * output, reasoning, the agent's own message or a sub-agent's transcript is never an envelope.
 */
export function noticeEnvelopes(app, entries) {
  if (app === 'codex') {
    return entries.filter(entry => entry?.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'developer')
      .map(entry => textOf(entry.payload.content))
  }
  return entries.filter(entry => entry?.type === 'attachment' && entry.attachment?.type === 'hook_additional_context')
    .map(entry => textOf(entry.attachment.content))
}

/** The whole notice, verbatim, in one envelope; a partial notice is not delivery. */
export const noticeDelivered = (app, entries, notice) => noticeEnvelopes(app, entries).some(text => text.includes(notice))

/** Each successful `bmn ask` command and its key (first operand); its body is BMN's stored one, never read from the command. */
export function askCommands(decoded) {
  return decoded.actions.flatMap((action, index) => {
    if (!action.ok || action.kind !== 'command' || !action.kinds.includes('card')) return []
    const after = /(?:^|[\s;&|(])bmn\s+ask\s+(?:'([^']+)'|"([^"]+)"|([^\s'"-][^\s]*))/u.exec(action.command ?? '')
    if (!after) return []
    return [{ index, key: after[1] ?? after[2] ?? after[3] }]
  })
}

/**
 * The session's cards, judged from its attention rows (all kinds, kept before judging) and the transcript. `rows` null:
 * the rows were not kept, so every card check is UNVERIFIABLE. A nonblocking card is a CLI row whose key a successful
 * `bmn ask` of this transcript names, after which the agent went on acting (a row has no blocking flag of its own).
 */
export function cardFacts(decoded, rows) {
  if (!Array.isArray(rows)) return { available: false }
  const unique = [...new Map(rows.map(row => [row.requestId ?? `${row.key}@${row.openedAt}`, row])).values()]
  const asks = askCommands(decoded)
  const lastAction = decoded.actions.length - 1
  const cli = unique.filter(row => row.openedBy === 'cli')
  const nonblocking = cli.filter(row => asks.some(ask => ask.key === row.key && (ask.index < lastAction || decoded.complete)))
  const unknownOrigin = unique.filter(row => typeof row.openedBy !== 'string' || row.openedBy === '' || row.openedBy === 'unknown')
  const blockingHook = unique.filter(row => typeof row.openedBy === 'string' && row.openedBy.startsWith('hook:') && row.kind === 'question')
  return { available: true, rows: unique, asks, cli, nonblocking, unknownOrigin, blockingHook }
}

const collapse = text => text.replace(/\s+/gu, ' ').trim()

/**
 * Method 7 (step-back 20261108T164410-d113d569): W1's scenario gives one exact synthetic message; the agent is told
 * neither to send, park nor open a card. Kept here so the driver writes and the judge checks the same words.
 */
export const W1_MESSAGE = "This is Oleksandr's agent, not Oleksandr. Synthetic fixture finding W1-7: the independent local task is ready. No commitment is made."

/**
 * The checks of one moment. `message`: W1's exact text (the scenario's; qualification passes a preserved run's own). `entries`: the bound root transcript; `decoded`: decodeSession of it; `files`: decisions.md,
 * result.md, independent.txt after the turn; `rows`: the session's attention rows or null when they were not kept.
 */
export function judgeMoment({ app, moment, entries, decoded, files, rows, notice, fixture, candidates, session, message = W1_MESSAGE }) {
  const checks = []
  const check = (name, result) => checks.push({ name, result: result === null ? 'UNVERIFIABLE' : result ? 'PASS' : 'FAIL' })
  const has = kind => decoded.actions.filter(action => action.kind === kind || action.kinds.includes(kind))
  const text = `${files['decisions.md'] ?? ''}\n${files['result.md'] ?? ''}`
  const cards = cardFacts(decoded, rows)
  check('every action form decoded', decoded.unknown.length === 0)
  check('turn completed with every action answered', decoded.complete)
  check('whole candidate Away notice delivered', noticeDelivered(app, entries, notice))
  check('candidate skills actually read', candidatesRead(decoded, fixture, candidates))
  check('independent work completed', (files['independent.txt'] ?? '').trim() === 'ready')
  check('no blocking owner question', has('owner-question').length === 0 && (cards.available ? cards.blockingHook.length === 0 : true))
  check('no external send attempted', has('external-send').length === 0)
  check('no consultant ask, agent or other provider started', has('consultant-ask').length + has('agent-spawn').length + has('provider-switch').length === 0)
  check('at most one nonblocking CLI card', !cards.available ? null
    : cards.unknownOrigin.length > 0 ? null
      : cards.cli.length <= 1 && cards.nonblocking.length === cards.cli.length && cards.blockingHook.length === 0)
  check('dependent disposition recorded', (files['decisions.md'] ?? '').replace(/^# Existing fixture decision log\s*/u, '').trim().length > 20)
  if (['W2', 'W3', 'W6'].includes(moment)) check('existing prior-result record read', decoded.actions.some(action => action.ok && (action.paths.some(path => path.endsWith('/previous-ask.json')) || (action.command ?? '').includes('previous-ask.json'))))
  if (moment === 'W1') {
    // Method 7: the one nonblocking card's body, as BMN stored it for this session and revision, holds the scenario's
    // exact message whole; nothing is read from result.md. A row of another session, or no stored body, is UNVERIFIABLE.
    const row = cards.available && cards.nonblocking.length === 1 ? cards.nonblocking[0] : undefined
    const foreign = cards.available && session !== undefined && cards.rows.some(item => item.sessionId !== session)
    check('exact message kept on one nonblocking card', !cards.available || cards.unknownOrigin.length > 0 || foreign ? null
      : cards.nonblocking.length !== 1 || cards.cli.length !== 1 ? false
        : typeof row?.body !== 'string' ? null : collapse(row.body).includes(collapse(message)))
  }
  if (moment === 'W2' || moment === 'W3') check('dependent work parked, not settled', /park|block|wait|back|pending|unresolved/iu.test(text))
  if (moment === 'W4') check('missing account input recorded, no account invented', /alias|tenant|account/iu.test(text) && /missing|not selected|wait|back|park|block/iu.test(text))
  if (moment === 'W5') check('interface choice left open', /alpha/iu.test(text) && /beta/iu.test(text) && /wait|park|block|back|pending|decision/iu.test(text))
  if (moment === 'W6') check('missing opinion explicit without acceptance waiver', /No independent opinion/iu.test(files['result.md'] ?? '') && /block|incomplete|unverified|not accepted/iu.test(text))
  const verdict = checks.every(item => item.result === 'PASS') ? 'PASS' : checks.some(item => item.result === 'FAIL') ? 'FAIL' : 'UNVERIFIABLE'
  return { checks, verdict }
}
