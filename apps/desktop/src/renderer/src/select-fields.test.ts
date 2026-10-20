// MODULE: select-fields.test.ts - Every option reaches the existing saved settings and launch parameters unchanged
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, VOICE_LANGUAGES, type VoiceSettings } from '@bmn/protocol'
import { INITIAL_SESSION_FORM, sessionCreateParams, sessionUpdateParams } from './launch-template'
import { BackgroundChoiceSelect, NotifyOnSelect, TerminalGraphicsSelect, VoiceLanguageSelect } from './select-fields'
import { parseTelegramForm, type TelegramFormFields } from './telegram-form'
import type { SelectMenu } from './select-menu'

type ChoiceProps = Parameters<typeof SelectMenu>[0]
const choices = (element: React.JSX.Element): ChoiceProps => element.props as ChoiceProps

describe('the five native selects retain their saved values (80.4 AC1)', () => {
  it('When windows close saves ask, keep-running and stop in both create and edit parameters', () => {
    let form = { ...INITIAL_SESSION_FORM }
    const field = choices(BackgroundChoiceSelect({ value: null, onChange: (backgroundChoice) => { form = { ...form, backgroundChoice } } }))
    expect(field.options.map((option) => option.value)).toEqual(['', 'hide', 'stop'])
    for (const option of field.options) {
      field.onChange(option.value)
      const expected = option.value === '' ? null : option.value
      expect(sessionCreateParams('synthetic-workspace', form, { cols: 80, rows: 24 }).backgroundChoice).toBe(expected)
      expect(sessionUpdateParams({ sessionId: 'synthetic-session', revision: 1 }, form).backgroundChoice).toBe(expected)
    }
  })

  it('Terminal images saves default, on and off as null, sixel and standard', () => {
    let form = { ...INITIAL_SESSION_FORM }
    const field = choices(TerminalGraphicsSelect({ value: null, onChange: (terminalGraphics) => { form = { ...form, terminalGraphics } } }))
    expect(field.options.map((option) => option.value)).toEqual(['', 'sixel', 'standard'])
    for (const option of field.options) {
      field.onChange(option.value)
      const expected = option.value === '' ? null : option.value
      expect(sessionCreateParams('synthetic-workspace', form, { cols: 80, rows: 24 }).terminalGraphics).toBe(expected)
      expect(sessionUpdateParams({ sessionId: 'synthetic-session', revision: 1 }, form).terminalGraphics).toBe(expected)
    }
  })

  it('Notify on preserves both stored policies through the settings parser', () => {
    let form: TelegramFormFields = { enabled: false, allowedChatId: '', allowedUserId: '', notifyOn: 'attention', autoSubmitReplies: false, answerPermissions: false }
    const field = choices(NotifyOnSelect({ value: form.notifyOn, disabled: false, onChange: (notifyOn) => { form = { ...form, notifyOn } } }))
    expect(field.options.map((option) => option.value)).toEqual(['attention', 'attention-and-exit'])
    for (const option of field.options) {
      field.onChange(option.value)
      const result = parseTelegramForm(form)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.notifyOn).toBe(option.value)
    }
  })

  it('Language passes every supported code, including automatic detection, into voice settings', () => {
    let voice: VoiceSettings = { ...DEFAULT_APP_SETTINGS.voice }
    const field = choices(VoiceLanguageSelect({ value: voice.language, disabled: false, onChange: (language) => { voice = { ...voice, language } } }))
    expect(field.options.map((option) => option.value)).toEqual(VOICE_LANGUAGES.map((language) => language.code))
    for (const option of field.options) {
      field.onChange(option.value)
      expect(voice.language).toBe(option.value)
    }
  })

  it('busy settings and unavailable launcher choices are disabled menu buttons (AC3)', () => {
    const onChange = (): void => undefined
    for (const element of [createElement(BackgroundChoiceSelect, { value: null, disabled: true, onChange }),
      createElement(TerminalGraphicsSelect, { value: null, disabled: true, onChange }),
      createElement(NotifyOnSelect, { value: 'attention', disabled: true, onChange }),
      createElement(VoiceLanguageSelect, { value: DEFAULT_APP_SETTINGS.voice.language, disabled: true, onChange })]) {
      const markup = renderToStaticMarkup(element)
      expect(markup).toContain('aria-expanded="false"')
      expect(markup).toContain('disabled=""')
      expect(markup).not.toContain('<select')
    }
  })
})
