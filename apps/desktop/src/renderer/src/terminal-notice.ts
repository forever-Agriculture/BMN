// MODULE: terminal-notice.ts - turns a terminal's own OSC notification sequence into a title and body
import {
  TERMINAL_NOTICE_BODY_MAX,
  TERMINAL_NOTICE_TITLE_MAX,
  type TerminalNoticeCode
} from '@bmn/protocol'

export interface TerminalNotice {
  title: string
  body?: string
}

/**
 * Control characters never reach a request: the control socket rejects them in a title and the body
 * is one block of text, not a screen. Newlines and tabs survive in a body and become spaces in a title.
 */
function clean(value: string, keepLines: boolean): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return keepLines ? stripped.trim() : stripped.replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max - 1
  const last = value.charCodeAt(end - 1)
  // Never split a surrogate pair: half an emoji is not a character.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${value.slice(0, end)}…`
}

/**
 * The payload of one OSC sequence, by the convention its number belongs to:
 *
 * - OSC 9 (iTerm2) `ESC ] 9 ; text BEL` — the whole payload is the message.
 * - OSC 777 (urxvt) `ESC ] 777 ; notify ; title ; body BEL` — anything but `notify` is not ours.
 * - OSC 99 (kitty) `ESC ] 99 ; <metadata> ; text BEL` — the metadata says how kitty would draw it,
 *   which BMN does not do, so only the payload after the first `;` is read.
 *
 * Returns null for a sequence that carries no text, which is nothing to show the owner.
 */
export function parseTerminalNotice(code: TerminalNoticeCode, data: string): TerminalNotice | null {
  if (code === 777) {
    const [kind, title, ...rest] = data.split(';')
    if (kind !== 'notify') return null
    return notice(clean(title ?? '', false), clean(rest.join(';'), true))
  }
  const text = code === 99 ? data.slice(data.indexOf(';') + 1) : data
  const body = clean(code === 99 && !data.includes(';') ? data : text, true)
  if (body === '') return null
  const [first, ...lines] = body.split('\n')
  // A one-line message is the whole notice; a longer one keeps its first line as the row's title.
  return notice(clean(first ?? '', false), lines.length === 0 ? '' : body)
}

function notice(title: string, body: string): TerminalNotice | null {
  const capped = cap(title, TERMINAL_NOTICE_TITLE_MAX)
  if (capped === '') return null
  return body === '' ? { title: capped } : { title: capped, body: cap(body, TERMINAL_NOTICE_BODY_MAX) }
}
