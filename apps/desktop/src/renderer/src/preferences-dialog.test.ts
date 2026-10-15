// MODULE: preferences-dialog.test.ts - Telegram's status list says an error once, and in full (Story 40.3); digest and quiet-hours rows; the left navigation and its pages (Story 60.5)
import { DEFAULT_APP_SETTINGS, type AppSettings, type TelegramStatus } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PREFERENCES_NAVIGATION, PreferencesDialog, TelegramStatusList, pageParent } from './preferences-dialog'

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

describe('Morning digest and Quiet hours rows', () => {
  const settings = (digest: boolean, quiet: boolean): AppSettings => ({
    ...DEFAULT_APP_SETTINGS,
    telegram: { ...DEFAULT_APP_SETTINGS.telegram, morningDigest: { enabled: digest, time: '06:45' },
      quietHours: { enabled: quiet, start: '23:15', end: '06:30', allowKinds: ['question'], allowSessions: [] } }
  })
  const dialog = (digest: boolean, quiet: boolean): string => renderToStaticMarkup(createElement(PreferencesDialog, {
    settings: settings(digest, quiet), onSettings: () => undefined, onClose: () => undefined,
    saveVoice: async () => settings(digest, quiet), suggestVocabulary: () => ({ ok: false as const, reason: 'test' }) }))
  const input = (markup: string, id: string): string => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(markup)![0]

  it('uses labelled rows instead of outlined fieldsets', () => {
    const markup = dialog(true, true)
    expect(markup).not.toMatch(/<fieldset|<legend/)
    expect(markup).toContain('<label for="preferences-telegram-digest">Morning digest</label>')
    // The words beside each feature's checkbox label that checkbox, so clicking them turns the feature on.
    expect(markup).toContain('<label for="preferences-telegram-digest">Send daily at</label>')
    expect(markup).toContain('<label for="preferences-telegram-quiet">Hold phone messages from</label>')
    expect(input(markup, 'preferences-telegram-digest-time')).toContain('aria-label="Morning digest time"')
    expect(markup).toContain('<label for="preferences-telegram-quiet">Quiet hours</label>')
    expect(markup).toContain('role="group" aria-labelledby="preferences-telegram-quiet-allow"')
    for (const kind of ['Permission', 'Question', 'Handoff', 'Review', 'Notice']) expect(markup).toContain(`/>${kind}</label>`)
  })

  it('keeps dependent controls and their values while a feature is off, and disables them', () => {
    const off = dialog(false, false)
    expect(input(off, 'preferences-telegram-digest-time')).toMatch(/disabled="".*value="06:45"|value="06:45".*disabled=""/)
    expect(input(off, 'preferences-telegram-quiet-start')).toMatch(/value="23:15"/)
    expect(input(off, 'preferences-telegram-quiet-start')).toContain('disabled=""')
    expect(input(off, 'preferences-telegram-quiet-end')).toMatch(/value="06:30"/)
    const on = dialog(true, true)
    for (const id of ['preferences-telegram-digest-time', 'preferences-telegram-quiet-start', 'preferences-telegram-quiet-end']) {
      expect(input(on, id)).not.toContain('disabled=""')
    }
  })

  it('says held messages arrive as a summary and then each waiting request', () => {
    const markup = dialog(true, true)
    expect(markup).toContain('one summary with session names, request kinds and titles, then each request that is still waiting')
    expect(markup).toContain('Each workspace with its checkout name, epics, Status, Decided-for-you entries and owner-item titles.')
    expect(markup).not.toMatch(/arrive as one summary/)
  })
})

describe('Health alerts row (Story 62.2)', () => {
  const settings = (enabled: boolean, offAt: string | null, telegram = false): AppSettings => ({
    ...DEFAULT_APP_SETTINGS,
    telegram: { ...DEFAULT_APP_SETTINGS.telegram, enabled: telegram, allowedChatId: telegram ? 7 : null, healthAlerts: { enabled, offAt } }
  })
  const dialog = (value: AppSettings): string => renderToStaticMarkup(createElement(PreferencesDialog, {
    settings: value, onSettings: () => undefined, onClose: () => undefined,
    saveVoice: async () => value, suggestVocabulary: () => ({ ok: false as const, reason: 'test' }) }))
  const input = (markup: string, id: string): string => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(markup)![0]
  const row = (markup: string): string => /<label for="preferences-telegram-health">Health alerts<\/label>.*?<label for="preferences-telegram-quiet">Quiet hours<\/label>/s.exec(markup)![0]

  it('sits between Morning digest and Quiet hours as a labelled row, off with no time by default', () => {
    const markup = dialog(DEFAULT_APP_SETTINGS)
    expect(markup.indexOf('>Morning digest</label>')).toBeLessThan(markup.indexOf('>Health alerts</label>'))
    expect(markup.indexOf('>Health alerts</label>')).toBeLessThan(markup.indexOf('>Quiet hours</label>'))
    expect(input(markup, 'preferences-telegram-health')).not.toContain('checked=""')
    expect(input(markup, 'preferences-telegram-health-off')).toMatch(/type="time"/)
    expect(input(markup, 'preferences-telegram-health-off')).toContain('value=""')
    expect(input(markup, 'preferences-telegram-health-off')).toContain('disabled=""')
    expect(row(markup)).not.toMatch(/<fieldset|<legend|<select/)
  })

  it('shows a saved watch and its switch-off time', () => {
    const markup = dialog(settings(true, '20:00'))
    expect(input(markup, 'preferences-telegram-health')).toContain('checked=""')
    expect(input(markup, 'preferences-telegram-health-off')).toContain('value="20:00"')
    expect(input(markup, 'preferences-telegram-health-off')).not.toContain('disabled=""')
  })

  it('names what is checked, the limits, what a message holds and what the watch cannot do', () => {
    const help = row(dialog(settings(true, null)))
    expect(help).toContain('CPU 100 °C on one reading or 95 °C on 3 in a row')
    expect(help).toContain('NVIDIA GPU 87 °C; integrated GPU 95 °C; a drive 80 °C')
    expect(help).toContain('battery voltage outside 3.0–4.45 V per cell')
    expect(help).toContain('mains power lost')
    expect(help).toContain('A message holds the time, this machine&#x27;s name, each problem with one line of advice, and all readings.')
    expect(help).toContain('repeats every 10 minutes')
    expect(help).toContain('It runs only while BMN is open. It cannot see smoke, a swelling battery, or a machine that has died.')
    expect(help).toContain('BMN never stops, slows or suspends anything')
  })

  it('says nothing will be sent while Telegram is off or not connected, and keeps Send test disabled', () => {
    const off = row(dialog(settings(true, null, false)))
    expect(off).toContain('Telegram is off; nothing will be sent.')
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Send test<\/button>/)
    // Before the status has loaded, an enabled Telegram is not known to be polling either.
    const waiting = row(dialog(settings(true, null, true)))
    expect(waiting).toContain('Telegram is not connected; nothing will be sent until it is.')
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Send test<\/button>/)
  })

  it('tells in the Quiet hours help that health alerts are sent anyway', () => {
    expect(dialog(DEFAULT_APP_SETTINGS)).toContain('Held messages are sent when quiet hours end. Health alerts are sent anyway.')
  })
})

describe('the left navigation and its pages (Story 60.5 AC1)', () => {
  const dialog = (initialSection?: 'agent-control'): string => renderToStaticMarkup(createElement(PreferencesDialog, {
    settings: DEFAULT_APP_SETTINGS, initialSection, onSettings: () => undefined, onClose: () => undefined,
    saveVoice: async () => DEFAULT_APP_SETTINGS, suggestVocabulary: () => ({ ok: false as const, reason: 'test' }) }))
  const navigation = (markup: string): string => /<nav class="preferences-nav"[^>]*>(.*?)<\/nav>/s.exec(markup)![1] as string
  const items = (markup: string): string[] => [...navigation(markup).matchAll(/<button[^>]*class="nav-item"[^>]*>(?:<svg.*?<\/svg>)?([A-Za-z ]+)/g)].map((match) => match[1] as string)

  it('lists Team and Rules first with their icons, then Workspace, Phone and Machine', () => {
    expect(PREFERENCES_NAVIGATION.map((entry) => 'parent' in entry ? `${entry.label}: ${entry.pages.map((page) => page.label).join(', ')}` : `${entry.group}: ${entry.pages.map((page) => page.label).join(', ')}`)).toEqual([
      'Team: Agents, Roles, Asks, Models, Changes', 'Rules: Editor, Skills, Tools, Health', 'Workspace: Appearance, Terminal, Notifications, Voice', 'Phone: Telegram', 'Machine: Local control, History, Backup'
    ])
    const markup = dialog()
    expect(markup).toContain('<nav class="preferences-nav" aria-label="Preference pages">')
    expect(count(navigation(markup), '<svg class="page-icon"')).toBe(2)
    expect(markup).not.toMatch(/Jump to section|<select aria-label="Preferences section"/)
  })

  it('opens on Team with only Team\'s sub-pages showing', () => {
    expect(items(dialog())).toEqual(['Team', 'Agents', 'Roles', 'Asks', 'Models', 'Changes', 'Rules', 'Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup'])
    expect(dialog()).toMatch(/aria-current="true" aria-expanded="true">.*?Team/)
    expect(dialog()).toContain('<button type="button" class="nav-item" aria-current="page">Agents</button>')
    expect([pageParent('team'), pageParent('models'), pageParent('changes'), pageParent('health'), pageParent('skills'), pageParent('voice')]).toEqual(['team', 'team', 'team', 'rules', 'rules', null])
  })

  it('keeps every earlier section as its own page, one showing at a time', () => {
    const markup = dialog('agent-control')
    expect(items(markup)).toEqual(['Team', 'Rules', 'Appearance', 'Terminal', 'Notifications', 'Voice', 'Telegram', 'Local control', 'History', 'Backup'])
    expect(markup).toContain('<button type="button" class="nav-item" aria-current="page">Local control</button>')
    expect(count(markup, '<div class="preferences-page" hidden="">')).toBe(7)
    expect(count(markup, '<div class="preferences-page">')).toBe(1)
    expect(markup).toMatch(/<div class="preferences-page"><section class="preferences-section" id="agent-control-section"><h3>Local control<\/h3>/)
    for (const title of ['Appearance', 'Terminal', 'Notifications', 'Voice', 'History', 'Backup']) expect(markup).toMatch(new RegExp(`<h3[^>]*>${title}</h3>`))
  })
})
