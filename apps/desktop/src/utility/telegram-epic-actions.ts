// MODULE: telegram-epic-actions.ts - owner answers to the whole terms shown on the phone
import { createHash } from 'node:crypto'
import type { EpicActionAnswer, EpicActionCard } from '@bmn/protocol'
import { escapeHtml, type InlineKeyboard } from './telegram-cards'
import { formattedTelegramTextFits, type InboundTap, type TelegramConnector } from './telegram-connector'

export const EPIC_ACTION_TAP = 'ea:'

/** The deploy rule a button was drawn under, in its callback data: an old button never answers under a newer rule (S4). */
export const shownRuleMark = (rule: string | null | undefined) => createHash('sha256').update(rule ?? '').digest('hex').slice(0, 8)

export function epicActionPhoneCard(card: EpicActionCard) {
  let text = `<b>Actions for Epic ${card.epic}</b>`
  const keyboard: InlineKeyboard = []
  const visible = new Set<number>()
  let phoneOverflow = false
  for (const [index, action] of card.actions.entries()) {
    const saved = card.answers[action.id]
    const prefix = `\n\n<b>${escapeHtml(action.id)}</b>\n`
    const rule = `${action.rule ? `\nDeploy rule: ${escapeHtml(action.rule)}` : ''}${action.held ? `\nHeld: ${escapeHtml(action.held)}` : ''}`
    const line = `${prefix}${escapeHtml(action.words)}${rule}${saved ? `\n${saved.choice === 'yes' ? 'Approved' : 'Declined'}` : ''}`
    if (!formattedTelegramTextFits(text + line + '\n\nMore actions: answer on desktop.')) {
      phoneOverflow = true
      if (formattedTelegramTextFits(text + prefix + 'Answer on desktop.\n\nMore actions: answer on desktop.')) {
        text += prefix + 'Answer on desktop.'
      }
      continue
    }
    text += line
    visible.add(index)
    const token = `${EPIC_ACTION_TAP}${card.id}:${card.revision.toString(36)}:${index.toString(36)}:${shownRuleMark(action.rule)}:`
    if (!saved) keyboard.push([{ text: `No · ${action.id}`, callback_data: token + 'n' },
      ...(action.held ? [] : [{ text: `Yes · ${action.id}`, callback_data: token + 'y' }])])
  }
  if (phoneOverflow) text += '\n\nMore actions: answer on desktop.'
  return { text, keyboard, visible }
}

export class TelegramEpicActions {
  private readonly sent = new Map<string, { revision: number; id: number; text: string }>()
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly connector: () => TelegramConnector | undefined,
    private readonly list: () => Promise<EpicActionCard[]>, private readonly answer: (input: EpicActionAnswer) => Promise<void>) {}

  reconcile(): void {
    this.pending = this.pending.then(async () => {
      const telegram = this.connector()
      if (!telegram) return
      const cards = await this.list()
      const current = new Set(cards.map(card => card.id))
      for (const [card, message] of this.sent) {
        if (current.has(card)) continue
        await telegram.editMessageText(message.id, 'These epic actions changed. Open the current card.')
        this.sent.delete(card)
      }
      for (const card of cards) {
        const sent = this.sent.get(card.id)
        if (!sent && card.actions.every(action => card.answers[action.id])) continue
        const { text, keyboard } = epicActionPhoneCard(card)
        // A changed deploy rule changes the words without a new revision; the phone shows it before a Yes can be taken.
        if (sent?.revision === card.revision && sent.text === text) continue
        if (sent) {
          await telegram.editMessageText(sent.id, text, { html: true, keyboard })
          sent.revision = card.revision
          sent.text = text
        } else {
          const message = await telegram.sendMessage(text, { html: true, keyboard })
          this.sent.set(card.id, { revision: card.revision, id: message.messageId, text })
        }
      }
    }).catch(() => undefined)
  }

  async tap(tap: InboundTap): Promise<void> {
    const telegram = this.connector()
    if (!telegram) return
    try {
      const match = /^ea:([a-f0-9-]{36}):([a-z0-9]+):([a-z0-9]+):([a-f0-9]{8}):([yn])$/u.exec(tap.data)
      const card = match && (await this.list()).find(card => card.id === match[1])
      const index = match ? Number.parseInt(match[3]!, 36) : -1
      const revision = match ? Number.parseInt(match[2]!, 36) : -1
      const action = card && card.actions[index]
      const sent = card ? this.sent.get(card.id) : undefined
      // The button's own mark must name the rule in force now: a tap on a button drawn under another rule, before or after the
      // message was redrawn, is refused, and the redrawn button carries the new mark.
      if (!card || !action || card.revision !== revision || !epicActionPhoneCard(card).visible.has(index) ||
        sent?.id !== tap.messageId || match![4] !== shownRuleMark(action.rule)) throw new Error('This card changed')
      await this.answer({ card: card.id, action: action.id, choice: match![5] === 'y' ? 'yes' : 'no', revision, rule: action.rule ?? null })
      await telegram.answerCallbackQuery(tap.callbackId, 'Saved')
    } catch {
      await telegram.answerCallbackQuery(tap.callbackId, 'This card changed. Open the current actions.')
    } finally { this.reconcile() }
  }
}
