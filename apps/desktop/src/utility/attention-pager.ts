// MODULE: attention-pager.ts - sends an attention request to the owner's phone only when the owner is away and it waited unseen
import type { AttentionKind, AttentionRecord } from '@bmn/protocol'
import { observeTelegramDelivery, type TelegramDeliveryObserver } from './telegram-delivery'

/** How long a request may wait for the owner in the app before it is also sent away from the desk. */
export const PAGE_AFTER_MS: Readonly<Record<AttentionKind, number>> = Object.freeze({
  permission: 15_000,
  question: 15_000,
  handoff: 15_000,
  review: 15_000,
  notice: 60_000
})

/** A request that fell due while the owner was at the desk is still sent if they leave this soon after it opened. */
export const LEFT_WITHIN_MS = 10 * 60_000

/** How far apart an agent's own question and its `bmn ask` card may open and still be one decision. */
export const MIRROR_WINDOW_MS = 120_000

const nativeQuestion = (record: AttentionRecord): boolean => record.kind === 'question' && (record.openedBy ?? '').startsWith('hook:')
const askCard = (record: AttentionRecord): boolean => record.openedBy === 'cli' && (record.kind === 'question' || record.kind === 'permission')

/**
 * Words two copies of one decision must share: at least MIRROR_SHARED_WORDS, and MIRROR_WORD_SHARE of the smaller set.
 * Replayed on his 149 close card/question pairs (2026-10-24..31), every pair at or above both bounds was one decision and
 * the doubtful ones fell below; a missed merge only leaves a duplicate, a wrong one would keep a question off his phone.
 */
export const MIRROR_SHARED_WORDS = 8
export const MIRROR_WORD_SHARE = 0.8
const COMMON = new Set(('that this with from have your will what which when then than them they into only also does after before about would ' +
  'could should there their these those were been being more most some such each other over under just like make made want need asks codex ' +
  'claude opencode questions question recommended keep').split(' '))
function decisionParts(record: AttentionRecord): string[] {
  const prompt = record.prompt?.type === 'questions' ? record.prompt.questions.flatMap(item => [item.header ?? '', item.text, ...item.options.map(option => option.label)]) : []
  return [record.title, record.body ?? '', ...prompt, ...(record.manualChoices?.options.map(option => option.label) ?? [])]
}
function decisionWords(record: AttentionRecord): Set<string> {
  return new Set((decisionParts(record).join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 4 && !COMMON.has(word)))
}
const NEGATION = /^(?:not|no|never|cannot|without|.+n['’]t)$/u
const FILLER = new Set(['a', 'an', 'the', 'to', 'be'])
/**
 * Words the request's question sentences (ending in '?') ask about, split by whether a negation turns them around: the
 * word right after it at any length ("not run"), or a longer word up to two words after it ("never the gallery page").
 */
function questionPolarity(record: AttentionRecord): { plain: Set<string>; negated: Set<string> } {
  const plain = new Set<string>(), negated = new Set<string>()
  for (const sentence of decisionParts(record).flatMap(part => part.split(/(?<=[?.!])\s+|\n+/u))) {
    if (!sentence.trim().endsWith('?')) continue
    const words = sentence.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? []
    words.forEach((word, index) => {
      if (NEGATION.test(word) || FILLER.has(word)) return
      const before = words.slice(Math.max(0, index - 3), index).filter(item => !FILLER.has(item)).slice(-2)
      const turned = before.length > 0 && NEGATION.test(before[before.length - 1]!) ||
        word.length >= 4 && !COMMON.has(word) && before.some(item => NEGATION.test(item))
      ;(turned ? negated : plain).add(word)
    })
  }
  return { plain, negated }
}
const tokens = (record: AttentionRecord): Set<string> => new Set(decisionParts(record).join('\n').toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [])
/**
 * Two copies of one decision share most words, and no word one question asks about plainly is asked with a negation in
 * the other ("Publish X?" against "Not publish X?"). Constraints outside the question sentences ("Do not push main.")
 * never count: replayed on his 51 mirrored pairs, a negation anywhere in the text split a third of them, the question
 * sentences none.
 */
function sameDecision(one: AttentionRecord, other: AttentionRecord): boolean {
  const a = decisionWords(one), b = decisionWords(other)
  const shared = [...a].filter(word => b.has(word)).length
  if (shared < MIRROR_SHARED_WORDS || shared < MIRROR_WORD_SHARE * Math.min(a.size, b.size)) return false
  const x = questionPolarity(one), y = questionPolarity(other)
  const turned = (p: typeof x, q: typeof x): boolean => [...p.negated].some(word => q.plain.has(word) && !q.negated.has(word))
  return !turned(x, y) && !turned(y, x)
}

/**
 * Stricter than askedTwice, for closing a card on the answer to the agent's own question: besides that, the two must not
 * each ask about a word the other never uses, so a card for another action ("Delete X?" beside "Publish X?") stays open.
 * Replayed on his 51 mirrored pairs this closes 40 cards; the other 11 stay open in the window, never on his phone.
 */
export function answeredTogether(one: AttentionRecord, other: AttentionRecord): boolean {
  if (!askedTwice(one, other)) return false
  const asked = (record: AttentionRecord): string[] => {
    const { plain, negated } = questionPolarity(record)
    return [...plain, ...negated].filter(word => word.length >= 4 && !COMMON.has(word))
  }
  const a = tokens(one), b = tokens(other)
  return !(asked(one).some(word => !b.has(word)) && asked(other).some(word => !a.has(word)))
}

/**
 * The open request this one mirrors, or null. An agent that asks with its own question tool (BMN's hook reports it) and
 * also opens a `bmn ask` card asks one decision twice; both opening in one session within MIRROR_WINDOW_MS in the same
 * words pair them, and the earlier one is the page. Tool approvals, notices, two cards or two questions never pair: they are separate decisions.
 */
export function mirrorOf(record: AttentionRecord, others: readonly AttentionRecord[]): AttentionRecord | null {
  const opened = Date.parse(record.openedAt)
  return others.find(other => other.state === 'open' && askedTwice(record, other) &&
    (Date.parse(other.openedAt) < opened || Date.parse(other.openedAt) === opened && other.requestId < record.requestId)) ?? null
}

/**
 * Whether two requests, open or closed, are one decision asked through the agent's question tool and a `bmn ask` card.
 * When both name the agent conversation that made them, it must be the same one, as dev-auto's interruption count requires.
 */
export function askedTwice(one: AttentionRecord, other: AttentionRecord): boolean {
  const a = one.producer, b = other.producer
  const sameAgent = !a || !b || a.conversationReference === b.conversationReference && a.generation === b.generation
  return one.requestId !== other.requestId && one.sessionId === other.sessionId && sameAgent &&
    (nativeQuestion(one) && askCard(other) || askCard(one) && nativeQuestion(other)) &&
    Math.abs(Date.parse(other.openedAt) - Date.parse(one.openedAt)) <= MIRROR_WINDOW_MS && sameDecision(one, other)
}

interface AttentionPagerOptions {
  /** The request as stored now, or null when it is gone. */
  current(requestId: string): Promise<AttentionRecord | null>
  /** False only when nothing was attempted and recovery may safely retry. */
  send(record: AttentionRecord): Promise<void | boolean>
  schedule(callback: () => void, ms: number): () => void
  /** False while the owner is at the desk, where the app already notified them; null when presence cannot be read. */
  ownerAway(): boolean | null
  /** Story 78.5: whether he said he is away (not just left the desk); a permission is then sent with no wait. */
  saidAway?(): boolean
  now(): number
  pageAfterMs?: Readonly<Record<AttentionKind, number>>
  leftWithinMs?: number
  observeDelivery?: TelegramDeliveryObserver
  /** Runs before the desktop rule so overnight requests retain delivery eligibility. */
  holdQuiet?(record: AttentionRecord): Promise<boolean>
  /**
   * The earlier open request this one mirrors (mirrorOf), or null. The mirror is not sent once that request reached the
   * phone; while it still waits (timer, desk, quiet hours, retry) the mirror waits with it, and pages on its own if that
   * request ends unsent (closed, seen, expired, failed).
   */
  mirrorOf?(record: AttentionRecord): Promise<AttentionRecord | null>
}

/**
 * Agents repeat the same request and the owner often answers at the desk, so each request revision is sent at most
 * once, only if it is still open and unseen when its wait ends, and only while the owner is away. A request that fell
 * due at the desk waits a while for the owner to leave; when presence cannot be read, it is sent as before.
 */
export function createAttentionPager(options: AttentionPagerOptions): {
  opened(record: AttentionRecord): void
  /** Call when the owner turns away from the desk. */
  ownerLeft(): void
  /** Telegram is available again; try only revisions definitely left unsent. */
  retryUnsent(): void
  /** Quiet-hours departure eligibility expired; keep the request itself untouched. */
  retire(record: AttentionRecord): void
  close(): void
} {
  const pageAfterMs = options.pageAfterMs ?? PAGE_AFTER_MS
  const leftWithinMs = options.leftWithinMs ?? LEFT_WITHIN_MS
  const pending = new Map<string, () => void>()
  const atDesk = new Map<string, { record: AttentionRecord; openedAt: number }>()
  const handled = new Set<string>()
  const unsent = new Map<string, AttentionRecord>()
  const inFlight = new Set<string>()
  /** Revisions whose page reached Telegram, and mirrors waiting on an earlier request's revision. */
  const delivered = new Set<string>()
  const mirrors = new Map<string, { record: AttentionRecord; openedAt: number | undefined; original: string }>()
  const stillWaiting = (key: string): boolean => pending.has(key) || atDesk.has(key) || unsent.has(key) || inFlight.has(key)
  /** A request reached its end: its waiting mirrors are done when it was sent, else each pages on its own. */
  const settle = (key: string, sent: boolean): void => {
    for (const [mirrorKey, mirror] of [...mirrors]) {
      if (mirror.original !== key) continue
      mirrors.delete(mirrorKey)
      if (sent) finishMirror(mirrorKey, mirror.record)
      else void page(mirrorKey, mirror.record, mirror.openedAt)
    }
  }
  const finish = (key: string): void => { handled.add(key); settle(key, false) }
  const finishMirror = (key: string, record: AttentionRecord): void => {
    observeTelegramDelivery(options.observeDelivery, record, 'request-mirrored')
    handled.add(key)
    settle(key, true)
  }
  let availability = 0
  let closed = false
  const page = async (key: string, record: AttentionRecord, openedAt?: number): Promise<void> => {
    if (closed || handled.has(key) || inFlight.has(key)) return
    inFlight.add(key)
    atDesk.delete(key)
    unsent.delete(key)
    const started = availability
    let retry = false
    try {
      const current = await options.current(record.requestId).catch(() => null)
      if (closed || !current || current.state !== 'open' || current.seenAt !== null || current.revision !== record.revision) {
        observeTelegramDelivery(options.observeDelivery, record,
          closed || !current ? 'request-unavailable' : current.state !== 'open' ? 'request-closed'
            : current.seenAt !== null ? 'request-seen' : 'request-revised')
        finish(key)
        return
      }
      // One decision, one phone message: the agent's own question and its `bmn ask` card page once (owner, 2026-10-31).
      const original = await options.mirrorOf?.(current).catch(() => null) ?? null
      if (original) {
        const originalKey = `${original.requestId}:${original.revision}`
        if (delivered.has(originalKey)) { finishMirror(key, current); return }
        if (stillWaiting(originalKey)) {
          observeTelegramDelivery(options.observeDelivery, current, 'mirror-waiting')
          mirrors.set(key, { record: current, openedAt, original: originalKey })
          return
        }
        // That request ended without a page, or this pager never saw it: this copy is the page.
      }
      // Departure made this revision eligible already; reconnects must not reset or expire that eligibility.
      let held = false
      try { held = await options.holdQuiet?.(current) ?? false }
      catch {
        observeTelegramDelivery(options.observeDelivery, current, 'quiet-history-unavailable')
        unsent.set(key, current)
        return
      }
      if (held) {
        observeTelegramDelivery(options.observeDelivery, current, 'held-quiet')
        unsent.set(key, current)
        return
      }
      if (handled.has(key)) return
      if (options.ownerAway() === false) {
        observeTelegramDelivery(options.observeDelivery, record, 'held-at-desk', { away: false })
        if (openedAt !== undefined) atDesk.set(key, { record: current, openedAt })
        else unsent.set(key, current)
        return
      }
      let failed = false
      const consumed = await options.send(current).catch(() => {
        observeTelegramDelivery(options.observeDelivery, record, 'page-error')
        failed = true
        return true
      })
      if (consumed === false && !closed) {
        unsent.set(key, current)
        retry = started !== availability
      } else if (failed || closed) finish(key)
      else {
        delivered.add(key)
        handled.add(key)
        settle(key, true)
      }
    } finally {
      inFlight.delete(key)
      // Recovery may arrive while an unavailable attempt is still settling.
      if (retry && options.ownerAway() !== false) void page(key, record)
    }
  }
  const forgetStale = (): void => {
    for (const [key, waiting] of atDesk) {
      if (options.now() - waiting.openedAt <= leftWithinMs) continue
      observeTelegramDelivery(options.observeDelivery, waiting.record, 'departure-window-expired')
      atDesk.delete(key)
      finish(key)
    }
  }
  return {
    retire: record => {
      const key = `${record.requestId}:${record.revision}`
      pending.get(key)?.(); pending.delete(key)
      atDesk.delete(key); unsent.delete(key); mirrors.delete(key); finish(key)
    },
    opened: (record) => {
      const key = `${record.requestId}:${record.revision}`
      if (closed || record.state !== 'open' || record.seenAt !== null || pending.has(key) || atDesk.has(key) || handled.has(key) || unsent.has(key) || inFlight.has(key) || mirrors.has(key)) {
        return
      }
      const openedAt = options.now()
      const delayMs = record.kind === 'permission' && options.saidAway?.() === true ? 0 : pageAfterMs[record.kind]
      observeTelegramDelivery(options.observeDelivery, record, 'scheduled', {
        away: options.ownerAway(), delayMs
      })
      pending.set(key, options.schedule(() => {
        pending.delete(key)
        forgetStale()
        const away = options.ownerAway()
        observeTelegramDelivery(options.observeDelivery, record, 'timer-fired', { away, elapsedMs: options.now() - openedAt })
        if (away === false && !options.holdQuiet) {
          observeTelegramDelivery(options.observeDelivery, record, 'held-at-desk', { away })
          atDesk.set(key, { record, openedAt })
        }
        else void page(key, record, openedAt)
      }, delayMs))
    },
    ownerLeft: () => {
      if (closed) return
      forgetStale()
      for (const [key, waiting] of [...atDesk]) void page(key, waiting.record)
      if (options.ownerAway() !== false) {
        availability += 1
        for (const [key, record] of [...unsent]) void page(key, record)
      }
    },
    retryUnsent: () => {
      if (closed || options.ownerAway() === false) return
      availability += 1
      for (const [key, record] of [...unsent]) void page(key, record)
    },
    close: () => {
      closed = true
      for (const cancel of pending.values()) cancel()
      pending.clear()
      atDesk.clear()
      unsent.clear()
      mirrors.clear()
    }
  }
}
