// MODULE: telegram-cards.ts - the Telegram card for a page: escaped HTML, the length rule, buttons and outcome lines (Story 30.3)
import {
  stripFormatCharacters,
  type AttentionPermissionPrompt,
  type AttentionQuestionsPrompt,
  type AttentionRecord,
  type ModelOriginAgent
} from '@bmn/protocol'
import type { AnswerOutcome, AnswerRefusal } from './remote-answer'
import { SECRET_FOOTNOTE, SECRET_MASK, maskSecrets } from './secret-mask'

/** Telegram's limit on one message's text; every card is measured as the HTML string itself, which is never shorter. */
export const TELEGRAM_TEXT_LIMIT = 4096
const SESSION_CHARS = 24
const BUTTON_CHARS = 28
const ONE_ROW_CHARS = 30
const ONE_ROW_OPTIONS = 3
const QUOTE_CHARS = 3000
const QUOTE_LINES = 3
const COMMAND_CHARS = 3000
const OUTCOME_QUESTION_CHARS = 200
const MIN_QUESTION_CHARS = 40

export interface InlineButton {
  text: string
  callback_data: string
}

export type InlineKeyboard = InlineButton[][]

/** What the first line names: never the model, and the flag only when Epic 29 observed it. */
export interface CardHeader {
  session: string
  agent: ModelOriginAgent | null
  flag: string | null
}

/**
 * A rendered card. `base` is what stays above the outcome line once the buttons go: the header and the
 * question (or the permission's command), so the finished card still says what was answered.
 */
export interface RenderedCard {
  text: string
  keyboard: InlineKeyboard | null
  base: string
}

const AGENT_NAMES: Readonly<Record<ModelOriginAgent, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
})

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Agent-written text on its way to Telegram, before any escaping or clipping: a record stored before Story 34.1
 * may still hold invisible or direction-changing format characters, and none of them leave the machine; nor
 * does anything shaped like a secret (Story 34.2).
 */
export function said(text: string): string {
  return maskSecrets(stripFormatCharacters(text))
}

/**
 * Card HTML stored before Stories 34.1 and 34.2, sent again when a card is ended after a restart: the words
 * between tags are cleaned and masked as fresh text is, and the tags BMN wrote stay intact.
 */
function saidHtml(html: string): string {
  return html.split(/(<[^>]*>)/).map((part, index) => index % 2 === 1 ? part : escapeHtml(said(plainText(part)))).join('')
}

/** A card whose text hides a secret ends by saying so, so the owner knows the laptop has the full text. */
function footnoted(text: string): string {
  return text.includes(SECRET_MASK) ? `${text}\n\n<i>${SECRET_FOOTNOTE}</i>` : text
}

/**
 * The plain words sent when Telegram refuses a card's formatting. A card that had buttons is answered at the
 * laptop, said before the secret footnote so the footnote stays the last line.
 */
export function plainFallback(html: string, answerAtLaptop: boolean): string {
  const plain = plainText(html)
  if (!answerAtLaptop) return plain
  const footnote = `\n\n${SECRET_FOOTNOTE}`
  return plain.endsWith(footnote)
    ? `${plain.slice(0, -footnote.length)}\n\nAnswer at the laptop.${footnote}`
    : `${plain}\n\nAnswer at the laptop.`
}

/** Clips to at most `max` characters including the ellipsis, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 0) return ''
  return `${chars.slice(0, max - 1).join('')}…`
}

/** The card as plain text, for the one resend after Telegram refuses its HTML. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function headerLine(glyph: string, header: CardHeader, suffix = ''): string {
  const agent = header.agent ? ` · ${AGENT_NAMES[header.agent]}${header.flag ? ` ${header.flag}` : ''}` : ''
  return `${glyph} <b>${escapeHtml(clip(said(header.session), SESSION_CHARS))}</b>${agent}${suffix}`
}

/**
 * Agent-written text: up to three lines as they are, longer text folded into an expandable quote, clipped
 * on a paragraph break at 3,000 characters and saying where the rest is.
 */
function agentText(text: string): string {
  const trimmed = said(text).trim()
  if (trimmed.split('\n').length <= QUOTE_LINES && [...trimmed].length <= QUOTE_CHARS) return escapeHtml(trimmed)
  let kept = trimmed
  if ([...kept].length > QUOTE_CHARS) {
    const head = [...kept].slice(0, QUOTE_CHARS).join('')
    const paragraph = head.lastIndexOf('\n\n')
    const line = head.lastIndexOf('\n')
    const cut = paragraph > QUOTE_CHARS / 2 ? paragraph : line > QUOTE_CHARS / 2 ? line : head.length
    kept = `${head.slice(0, cut).trimEnd()}\n… continues at the laptop`
  }
  return `<blockquote expandable>${escapeHtml(kept)}</blockquote>`
}

function keyboardFor(labels: string[], tokens: string[], marked: number | null = null): InlineKeyboard {
  const buttons = labels.map((label, index) => ({
    text: clip(`${index === marked ? '● ' : ''}${index + 1} · ${label}`, BUTTON_CHARS),
    callback_data: tokens[index]!
  }))
  const total = buttons.reduce((sum, button) => sum + [...button.text].length, 0)
  return buttons.length <= ONE_ROW_OPTIONS && total <= ONE_ROW_CHARS ? [buttons] : buttons.map((button) => [button])
}

export interface QuestionCardInput {
  header: CardHeader
  prompt: AttentionQuestionsPrompt
  /** The question on the card now, and the labels chosen for the ones before it. */
  step: number
  chosen: string[]
  /**
   * One token per option of this step (a choice, or a toggle on a multi-select question), or null for a card
   * answered only at the laptop.
   */
  tokens: string[] | null
  /** A short line above the options, for a tap that sent nothing. */
  note?: string | null
  /** The Other… button, when this question takes a typed answer. */
  other?: string | null
  /** The ‹ Back button, from the second question on. */
  back?: string | null
  /** Multi-select: the options toggled on, and Send or Next once at least one is. */
  toggled?: number[] | null
  submit?: string | null
  /** Single choice after Back: the option chosen before, marked ●. */
  marked?: number | null
  /** Waiting for a typed reply after Other…: the ‹ Options button that returns to the options. */
  typing?: string | null
}

function questionChip(prompt: AttentionQuestionsPrompt, index: number): string | null {
  const question = prompt.questions[index]!
  const parts: string[] = []
  if (prompt.questions.length > 1) parts.push(`Question ${index + 1} of ${prompt.questions.length}`)
  if (question.header) parts.push(said(question.header))
  let chip = parts.join(' · ')
  if (question.multiSelect) chip = chip ? `${chip} · choose any` : 'Choose any'
  return chip ? `<i>${escapeHtml(chip)}</i>` : null
}

function questionBody(
  prompt: AttentionQuestionsPrompt,
  index: number,
  limits: { description: number; question: number }
): string {
  const question = prompt.questions[index]!
  const options = question.options.map((option, number) => {
    const description = option.description ? clip(said(option.description), limits.description) : ''
    return `<b>${number + 1}. ${escapeHtml(said(option.label))}</b>${description ? `\n${escapeHtml(description)}` : ''}`
  })
  return [
    `<b>${escapeHtml(clip(said(question.text), limits.question))}</b>`,
    '',
    options.join('\n\n')
  ].join('\n')
}

/**
 * Fits the card in Telegram's limit by one rule: descriptions are clipped first, then question text,
 * never labels. `render` is called with ever smaller caps until the text fits or the caps are spent.
 */
function fitted(draw: (limits: { description: number; question: number }) => string): string {
  const render = (limits: { description: number; question: number }): string => footnoted(draw(limits))
  const unlimited = Number.MAX_SAFE_INTEGER
  let text = render({ description: unlimited, question: unlimited })
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text
  for (let description = 400; description >= 0; description = description > 50 ? description - 50 : description - 10) {
    text = render({ description, question: unlimited })
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text
  }
  for (let question = 1600; question >= MIN_QUESTION_CHARS; question -= 80) {
    text = render({ description: 0, question })
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text
  }
  return render({ description: 0, question: MIN_QUESTION_CHARS })
}

function outcomeBase(header: string, questions: string[]): string {
  return [header, ...questions.map((text) => `<b>${escapeHtml(clip(said(text), OUTCOME_QUESTION_CHARS))}</b>`)].join('\n')
}

/**
 * A question card. With buttons it shows one question at a time, earlier answers quoted above it; without
 * them it shows every question and says to answer at the laptop.
 */
export function questionCard(input: QuestionCardInput): RenderedCard {
  const { prompt, step, chosen, tokens } = input
  const header = headerLine('❓', input.header)
  const base = outcomeBase(header, prompt.questions.map((question) => question.text))
  if (tokens === null) {
    const text = fitted((limits) => [
      header,
      prompt.questions.map((_, index) => {
        const chip = questionChip(prompt, index)
        const body = questionBody(prompt, index, limits)
        // The first chip sits right under the header, as on a card with buttons.
        return index === 0 ? [...(chip ? [chip] : []), '', body].join('\n') : [...(chip ? [chip, ''] : []), body].join('\n')
      }).join('\n\n'),
      '',
      prompt.harness === 'codex' && prompt.shape === 'async-choice'
        ? '<i>Codex Default has no verified correlated answer route. Answer at the laptop; nothing was sent.</i>'
        : '<i>No buttons for this kind yet. Answer at the laptop.</i>'
    ].join('\n'))
    return { text, keyboard: null, base }
  }
  const earlier = chosen.map((label, index) => {
    const question = prompt.questions[index]!
    return `${escapeHtml(question.header === null ? `Question ${index + 1}` : said(question.header))}: <b>${escapeHtml(said(label))}</b>`
  })
  const question = prompt.questions[step]!
  const final = step === prompt.questions.length - 1
  const last = prompt.questions.length > 1 && final
  const chip = questionChip(prompt, step)
  const intro = [
    header,
    ...(chip ? [chip] : []),
    ...(earlier.length > 0 ? ['', `<blockquote>${earlier.join('\n')}</blockquote>`] : []),
    ...(input.note ? ['', `⚠ <i>${escapeHtml(input.note)}</i>`] : [])
  ]
  if (input.typing) {
    const text = fitted((limits) => [
      ...intro,
      '',
      `<b>${escapeHtml(clip(said(question.text), limits.question))}</b>`,
      '',
      '<i>Reply to this message with your answer.</i>'
    ].join('\n'))
    return { text, keyboard: [[{ text: '‹ Options', callback_data: input.typing }]], base }
  }
  const labels = question.options.map((option) => said(option.label))
  const toggled = input.toggled ?? null
  // Multi-select: the body repeats the choice in full, because buttons clip; with none, it says what to do.
  const status = toggled === null
    ? last ? ['', '<i>Nothing is sent until this answer.</i>'] : []
    : ['', toggled.length > 0
      ? `<i>Chosen: ${escapeHtml(toggled.map((index) => labels[index]!).join(' · '))}</i>`
      : `<i>Choose one or more, then ${final ? 'Send' : 'Next'}.</i>`]
  const text = fitted((limits) => [...intro, '', questionBody(prompt, step, limits), ...status].join('\n'))
  const keyboard: InlineKeyboard = toggled === null
    ? keyboardFor(labels, tokens, input.marked ?? null)
    : labels.map((label, index) => [{
        text: clip(`${toggled.includes(index) ? '●' : '○'} ${index + 1} · ${label}`, BUTTON_CHARS),
        callback_data: tokens[index]!
      }])
  if (input.other) keyboard.push([{
    text: labels.some((label) => /^other[.\s…]*$/i.test(label)) ? 'Type an answer…' : 'Other…',
    callback_data: input.other
  }])
  const control: InlineButton[] = []
  if (input.back) control.push({ text: '‹ Back', callback_data: input.back })
  if (toggled !== null && toggled.length > 0 && input.submit) {
    control.push({
      text: final ? `Send ${toggled.length} selected` : `Next · ${toggled.length} selected`,
      callback_data: input.submit
    })
  }
  if (control.length > 0) keyboard.push(control)
  return { text, keyboard, base }
}

function permissionWants(prompt: AttentionPermissionPrompt): string {
  if (prompt.shape === 'sandbox-network') return 'Wants network access'
  const what = /^bash$/i.test(prompt.tool) ? 'to run a command' : `to use ${said(prompt.tool)}`
  return prompt.shape === 'subagent' ? `A subagent wants ${what}` : `Wants ${what}`
}

function homeRelative(path: string, home: string | null): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Whether masking hid part of the command (Story 34.2). */
function commandMasked(prompt: AttentionPermissionPrompt): boolean {
  return prompt.command !== null && said(prompt.command) !== stripFormatCharacters(prompt.command)
}

/**
 * Whether cleaning removed invisible or direction-changing characters from what is approved (Story 34.1): the
 * card would show different bytes from the ones the harness runs.
 */
function permissionCleaned(prompt: AttentionPermissionPrompt): boolean {
  return [prompt.tool, prompt.command, prompt.cwd].some((value) => value !== null && stripFormatCharacters(value) !== value)
}

/**
 * Whether the card can show the whole command exactly; a permission is never approved from a clipped one, one
 * with part of it hidden as a secret, or one whose tool, command or folder the card had to clean.
 */
export function commandShownWhole(prompt: AttentionPermissionPrompt): boolean {
  return prompt.command !== null && clip(prompt.command, COMMAND_CHARS) === prompt.command && !commandMasked(prompt) &&
    !permissionCleaned(prompt)
}

export interface PermissionCardInput {
  header: CardHeader
  prompt: AttentionPermissionPrompt
  /** Allow once and Deny tokens; Deny is null when it would answer more than this request. */
  tokens: { allow: string; deny: string | null } | null
  /**
   * Why a card has no buttons: the setting is off, or no verified route answers this shape. A command too
   * long to show whole never gets buttons, whatever is passed.
   */
  closedBecause: 'permissions-off' | 'unsupported' | null
  home: string | null
  note?: string | null
}

export function permissionCard(input: PermissionCardInput): RenderedCard {
  const { prompt } = input
  const command = prompt.command === null ? 'The agent did not say exactly what.' : clip(said(prompt.command), COMMAND_CHARS)
  const base = [
    headerLine('🔐', input.header),
    `<i>${escapeHtml(permissionWants(prompt))}</i>`,
    '',
    `<pre>${escapeHtml(command)}</pre>`,
    ...(prompt.cwd ? [`in <code>${escapeHtml(clip(homeRelative(said(prompt.cwd), input.home), 300))}</code>`] : [])
  ].join('\n')
  const tokens = prompt.command !== null && !commandShownWhole(prompt) ? null : input.tokens
  const trailer = tokens !== null
    ? input.note ? `⚠ <i>${escapeHtml(input.note)}</i>` : null
    : prompt.command !== null && commandMasked(prompt)
      ? '<i>Part of the command is hidden here. Answer at the laptop.</i>'
    : prompt.command !== null && permissionCleaned(prompt)
      ? '<i>The command holds invisible characters. Answer at the laptop.</i>'
    : prompt.command !== null && !commandShownWhole(prompt)
      ? '<i>The command is too long to show here. Answer at the laptop.</i>'
      : input.closedBecause === 'permissions-off'
        ? '<i>Answer this at the laptop.</i>'
        : '<i>No buttons for this kind yet. Answer at the laptop.</i>'
  const text = footnoted(trailer ? `${base}\n\n${trailer}` : base)
  if (tokens === null) return { text, keyboard: null, base }
  const row: InlineButton[] = [{ text: 'Allow once', callback_data: tokens.allow }]
  if (tokens.deny !== null) row.push({ text: 'Deny', callback_data: tokens.deny })
  return { text, keyboard: [row], base }
}

/** A request without a structured prompt (`bmn ask`, a review, a handoff): answered by replying to the card. */
export function requestCard(header: CardHeader, record: Pick<AttentionRecord, 'kind' | 'title' | 'body'>): RenderedCard {
  const base = [
    headerLine(record.kind === 'permission' ? '🔐' : '❓', header),
    `<b>${escapeHtml(clip(said(record.title), 500))}</b>`,
    ...(record.body ? ['', agentText(record.body)] : [])
  ].join('\n')
  return { text: footnoted(`${base}\n\n<i>Reply to this message to answer.</i>`), keyboard: null, base }
}

/** A notice: a finished turn reads as the agent finishing, anything else as a warning with its title. */
export function noticeCard(
  header: CardHeader,
  record: Pick<AttentionRecord, 'title' | 'body' | 'requestKey'>
): RenderedCard {
  if (record.requestKey === 'turn') {
    const base = [headerLine('✓', header, ' finished'), ...(record.body ? ['', agentText(record.body)] : [])].join('\n')
    return { text: footnoted(`${base}\n<i>Reply to this message to continue.</i>`), keyboard: null, base }
  }
  const base = [
    headerLine('⚠', header),
    `<b>${escapeHtml(clip(said(record.title), 500))}</b>`,
    ...(record.body ? ['', agentText(record.body)] : [])
  ].join('\n')
  return { text: footnoted(`${base}\n\n<i>Reply to this message to answer.</i>`), keyboard: null, base }
}

export function exitCard(header: CardHeader): string {
  return footnoted(headerLine('■', header, ' exited'))
}

/** The italic line that replaces the options once a card is decided. */
export type CardEnding =
  | { type: 'acknowledged' }
  | { type: 'sending'; labels: string[] }
  | { type: 'outcome'; outcome: AnswerOutcome; permission: boolean }
  | { type: 'laptop' }
  | { type: 'telegram' }
  | { type: 'closed' }
  | { type: 'restarted' }
  | { type: 'restarted-sending' }

export const REFUSAL_WORDS: Readonly<Record<AnswerRefusal, string>> = Object.freeze({
  gone: 'Nothing was sent: this is no longer open.',
  changed: 'Nothing was sent: the dialog changed on the laptop.',
  'not-on-screen': 'Nothing was sent: that dialog is not on the screen.',
  unsupported: 'Nothing was sent: this kind cannot be answered from Telegram.',
  'permissions-off': 'Nothing was sent: permission answers from Telegram are off.',
  claimed: 'Another answer is already on its way.',
  'not-delivered': 'Nothing was sent: OpenCode did not pick up the answer.',
  'api-refused': 'OpenCode rejected the answer; nothing was applied.'
})

export function endingLine(ending: CardEnding): string {
  switch (ending.type) {
    case 'acknowledged':
      return '✓ <i>Update acknowledged. No terminal input sent.</i>'
    case 'sending':
      return `<i>Sending: ${escapeHtml(ending.labels.map(said).join(' · '))}…</i>`
    case 'laptop':
      return '<i>Answered at the laptop.</i>'
    case 'telegram':
      return '✓ <i>Answered from Telegram.</i>'
    case 'closed':
      return '<i>No longer open.</i>'
    case 'restarted':
      return '<i>BMN restarted — answer at the laptop.</i>'
    case 'restarted-sending':
      return '⚠ <i>Sent — not confirmed, check the laptop.</i>'
    case 'outcome': {
      const outcome = ending.outcome
      if (outcome.state === 'refused') return `⚠ <i>${escapeHtml(REFUSAL_WORDS[outcome.reason])}</i>`
      const sent = escapeHtml(outcome.sent.map(said).join(' · '))
      if (outcome.state === 'confirmed') {
        if (ending.permission) return outcome.sent[0] === 'Deny' ? '✓ <i>Denied</i>' : '✓ <i>Allowed once</i>'
        return `✓ <i>Sent: ${sent}</i>`
      }
      if (outcome.state === 'sent-unconfirmed') {
        return `⚠ <i>Sent${sent ? `: ${sent}` : ''} — not confirmed, check the laptop.</i>`
      }
      return `⚠ <i>Sent ${outcome.sent.length} of ${outcome.total} — stopped: the dialog changed. Check the laptop.</i>`
    }
  }
}

/** The short reply that makes the phone sound when an answer went wrong or is uncertain; null when it went right. */
export function endingReply(outcome: AnswerOutcome): string | null {
  if (outcome.state === 'confirmed') return null
  if (outcome.state === 'refused') return REFUSAL_WORDS[outcome.reason]
  if (outcome.state === 'partial') return `Sent ${outcome.sent.length} of ${outcome.total}, then the dialog changed. Check the laptop.`
  return 'Sent, but not confirmed. Check the laptop.'
}

export function endedCard(base: string, ending: CardEnding): string {
  return footnoted(`${saidHtml(base)}\n\n${endingLine(ending)}`)
}
