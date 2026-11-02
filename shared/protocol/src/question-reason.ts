// MODULE: question-reason.ts - Story 103.6 (D6): the words a question starts with to say why only he can decide, the fixed hand-back and its count
//
// An agent can pick a word falsely; the counts and his reading of them are the check (103.7), not a classifier here. The count
// is one raw setting beside the away record; it holds who and when, never a question's text.

export const QUESTION_REASON_WORDS = ['Go', 'Money', 'Scope', 'Privacy', 'Interface', 'Irreversible', 'Access', 'Taste', 'Asked'] as const
export type QuestionReasonWord = typeof QUESTION_REASON_WORDS[number]

const LISTED = QUESTION_REASON_WORDS.map((word) => `${word}:`).join(', ')

/** The fixed words an agent gets for a bare question. A reserved choice is asked, never decided, so they say both. */
export const QUESTION_HAND_BACK = 'BMN: this question was not shown to the owner, because it does not say why only he can decide: ' +
  `if this is his to decide, start each question with one of these words and ask again (${LISTED}); ` +
  'otherwise decide on your recommendation within your existing authority and say so in one line; this refusal authorizes nothing. ' +
  'Asked again unchanged, it reaches him.'

/** The word a question starts with, as the list spells it, or null. A word with nothing after its colon asks nothing. */
export function questionReasonWord(text: string): QuestionReasonWord | null {
  const found = /^\s*([A-Za-z]+):\s*\S/u.exec(text)
  if (found === null) return null
  const word = found[1]!.toLowerCase()
  return QUESTION_REASON_WORDS.find((one) => one.toLowerCase() === word) ?? null
}

/** Whether a call must go back: any one of its questions lacks its word. */
export function questionsNeedingReason(texts: readonly string[]): boolean {
  return texts.some((text) => questionReasonWord(text) === null)
}

export const QUESTION_HAND_BACK_KEY = 'question-hand-backs-v1'
/** At the measured 1,289 questions in 30 days this holds well over a month, longer than 103.7's three runs need. */
export const QUESTION_HAND_BACK_LIMIT = 2000

export type QuestionHandBackOutcome = 'handed-back' | 'repeat'
export interface QuestionHandBack {
  at: string
  sessionId: string
  conversation: string | null
  agentCli: string | null
  outcome: QuestionHandBackOutcome
}
export interface QuestionHandBacks { version: 1; dropped: number; entries: QuestionHandBack[] }

const EMPTY: QuestionHandBacks = Object.freeze({ version: 1, dropped: 0, entries: [] as QuestionHandBack[] }) as QuestionHandBacks

function readEntry(value: unknown): QuestionHandBack | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  const nullableText = (field: unknown): field is string | null => field === null || typeof field === 'string'
  if (typeof entry.at !== 'string' || typeof entry.sessionId !== 'string' || !nullableText(entry.conversation) || !nullableText(entry.agentCli)) return null
  if (entry.outcome !== 'handed-back' && entry.outcome !== 'repeat') return null
  return { at: entry.at, sessionId: entry.sessionId, conversation: entry.conversation, agentCli: entry.agentCli, outcome: entry.outcome }
}

/** A missing or malformed row reads as empty: this is a count, and it holds nothing that grants anything. */
export function parseQuestionHandBacks(raw: string | undefined): QuestionHandBacks {
  if (raw === undefined) return { ...EMPTY, entries: [] }
  try {
    const value = JSON.parse(raw) as { version?: unknown; dropped?: unknown; entries?: unknown }
    if (value.version !== 1 || !Array.isArray(value.entries)) return { ...EMPTY, entries: [] }
    const entries = value.entries.map(readEntry).filter((entry): entry is QuestionHandBack => entry !== null)
    return { version: 1, dropped: typeof value.dropped === 'number' && value.dropped >= 0 ? value.dropped : 0, entries }
  } catch {
    return { ...EMPTY, entries: [] }
  }
}

export function appendQuestionHandBack(record: QuestionHandBacks, entry: QuestionHandBack): QuestionHandBacks {
  const kept = readEntry(entry)
  if (kept === null) return record
  const entries = [...record.entries, kept]
  const over = Math.max(0, entries.length - QUESTION_HAND_BACK_LIMIT)
  return { version: 1, dropped: record.dropped + over, entries: entries.slice(over) }
}
