// MODULE: preferences-dialog.test.ts - Telegram's status list says an error once, and in full (Story 40.3)
import type { TelegramStatus } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TelegramStatusList } from './preferences-dialog'

const ERROR = 'Another client is polling this bot token; stop the other client or revoke the token in BotFather'
const status = (lastError: string | null): TelegramStatus => ({
  state: lastError ? 'conflict' : 'polling', detail: 'Polling for replies', tokenMask: '1234…wxyz',
  lastPollAt: null, lastError, rejectedUpdates: 0, failingSince: null
})
const render = (lastError: string | null, cueShown: boolean): string =>
  renderToStaticMarkup(createElement(TelegramStatusList, { status: status(lastError), cueShown }))
const count = (markup: string, text: string): number => markup.split(text).length - 1

describe('Telegram status list (Story 40.3)', () => {
  it('leaves an error to the cue while the cue shows it', () => {
    const markup = render(ERROR, true)
    expect(count(markup, ERROR)).toBe(0)
    expect(markup).toContain('<dt>Last error</dt><dd class="none">shown above</dd>')
    expect(markup).toContain('<dt>State</dt><dd>conflict</dd>')
  })

  it('says the error once, in full, when no cue shows it', () => {
    const markup = render(ERROR, false)
    expect(count(markup, ERROR)).toBe(1)
    expect(markup).toContain(`<dd class="error">${ERROR}</dd>`)
    expect(markup).not.toContain('title=')
  })

  it('gives State its detail only when there is no error', () => {
    expect(render(null, false)).toContain('<dt>State</dt><dd>polling · Polling for replies</dd><dt>Token</dt>')
    expect(render(null, false)).toContain('<dt>Last error</dt><dd class="none">none</dd>')
  })
})
