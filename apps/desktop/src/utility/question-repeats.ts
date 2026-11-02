// MODULE: question-repeats.ts - Story 103.6 AC3: whether a conversation asked this exact question before, kept as hashes in memory only
import { createHash } from 'node:crypto'

const CONVERSATIONS = 500
const PER_CONVERSATION = 50

/**
 * Bounded, oldest first out. Forgetting costs one more hand-back and never a question: asked again it opens. After a restart
 * too. No text is kept; a hash of a short question only says "the same as before", in memory, for that conversation.
 */
export class QuestionRepeats {
  private readonly seenBy = new Map<string, string[]>()

  /** Whether these questions were asked before under this key, remembering them when not. */
  seen(key: string, texts: readonly string[]): boolean {
    const hash = createHash('sha256').update(JSON.stringify(texts.map((text) => text.trim().replace(/\s+/gu, ' ')))).digest('hex')
    const hashes = this.seenBy.get(key) ?? []
    this.seenBy.delete(key)
    this.seenBy.set(key, hashes)
    if (hashes.includes(hash)) return true
    hashes.push(hash)
    if (hashes.length > PER_CONVERSATION) hashes.shift()
    if (this.seenBy.size > CONVERSATIONS) this.seenBy.delete(this.seenBy.keys().next().value as string)
    return false
  }
}
