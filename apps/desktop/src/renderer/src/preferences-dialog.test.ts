// MODULE: preferences-dialog.test.ts - Telegram's status list says an error once, and in full (Story 40.3); digest and quiet-hours rows; the left navigation and its pages (Story 60.5)
import { DEFAULT_APP_SETTINGS, type AppSettings, type BackupExportResult, type TelegramStatus } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENTS_VIEWS, BackupOutcome, INTEGRATIONS_VIEWS, PREFERENCES_PAGES, PreferencesDialog, TelegramStatusList, openedAt, type PreferencesPlace } from './preferences-dialog'

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
    for (const kind of ['Permission', 'Question', 'Review', 'Notice']) expect(markup).toContain(`/>${kind}</label>`)
    // A handoff delivers itself to its agent (Story 75.5): Let through holds four boxes.
    expect(markup).not.toContain('/>Handoff</label>')
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
    expect(markup).toContain('one summary (session names, request kinds, titles), then each request still waiting')
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
    // The limits are rows of a key and its value (docs/design.md W2), never one paragraph joined with semicolons.
    expect(help).toContain('<dt>CPU</dt><dd>100 °C on one reading, or 95 °C on 3 in a row</dd>')
    expect(help).toContain('<dt>NVIDIA GPU</dt><dd>87 °C</dd><dt>Integrated GPU</dt><dd>95 °C</dd><dt>Drive</dt><dd>80 °C</dd>')
    expect(help).toContain('<dt>Battery</dt><dd>outside 3.0–4.45 V per cell, or no longer detected</dd>')
    expect(help).toContain('<dt>Mains</dt><dd>power lost</dd><dt>CPU reading</dt><dd>cannot be read</dd>')
    // The rows are led by what they are; no sentence trails after them (Fable's review of 80.5). No visual state opens this disclosure, so this render is their check.
    expect(help).toContain('<p>Alerts at these fixed limits:</p><dl class="kv" aria-label="Alerts at these fixed limits"><dt>CPU</dt>')
    expect(help).not.toContain('These are the alert limits')
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

describe('six pages in one flat list (Story 75.10 AC1)', () => {
  const dialog = (initialPage?: PreferencesPlace): string => renderToStaticMarkup(createElement(PreferencesDialog, {
    settings: DEFAULT_APP_SETTINGS, initialPage, onSettings: () => undefined, onClose: () => undefined,
    saveVoice: async () => DEFAULT_APP_SETTINGS, suggestVocabulary: () => ({ ok: false as const, reason: 'test' }) }))
  const navigation = (markup: string): string => /<nav class="preferences-nav"[^>]*>(.*?)<\/nav>/s.exec(markup)![1] as string
  const items = (markup: string): string[] => [...navigation(markup).matchAll(/<button[^>]*class="nav-item"[^>]*>([A-Za-z ]+)/g)].map((match) => match[1] as string)
  /** The view control under a page head: each segment's word and whether it is lit. */
  const views = (markup: string): string[] => [...(/<div class="page-views">(.*?)<\/div><\/div>/s.exec(markup)?.[1] ?? '').matchAll(/aria-checked="(true|false)"[^>]*>([A-Za-z ]+)<\/button>/g)]
    .map((match) => `${match[2]}${match[1] === 'true' ? ' (lit)' : ''}`)

  it('lists General, Agents, Integrations, Notifications, Voice and Data, with no icon, group head or sub-list', () => {
    expect(PREFERENCES_PAGES.map((entry) => entry.label)).toEqual(['General', 'Agents', 'Integrations', 'Notifications', 'Voice', 'Data'])
    const markup = dialog()
    expect(markup).toContain('<nav class="preferences-nav" aria-label="Preference pages">')
    expect(items(markup)).toEqual(['General', 'Agents', 'Integrations', 'Notifications', 'Voice', 'Data'])
    expect(navigation(markup)).not.toMatch(/<svg|nav-head|nav-sub|nav-parent|nav-group|aria-expanded/)
  })

  it('opens on Agents › Team, with the view control under the head: Team, Roles, Models, Changes, Asks', () => {
    expect(AGENTS_VIEWS.map((entry) => entry.label)).toEqual(['Team', 'Roles', 'Models', 'Changes', 'Asks'])
    const markup = dialog()
    expect(markup).toContain('<button type="button" class="nav-item" aria-current="page">Agents</button>')
    expect(markup).toContain('<div class="preferences-page team-page">')
    // The team is still being read, and the head already says the page's name rather than the view's.
    expect(markup).toMatch(/<header class="page-head"><h3 class="page-title" id="[^"]+">Agents<\/h3>/)
    expect(views(markup)).toEqual(['Team (lit)', 'Roles', 'Models', 'Changes', 'Asks'])
  })

  it('opens Integrations on Health, or on the view it was asked for: Health, Rules, Skills, Tools', () => {
    expect(INTEGRATIONS_VIEWS.map((entry) => entry.label)).toEqual(['Health', 'Rules', 'Skills', 'Tools'])
    const health = dialog('health')
    expect(health).toContain('<button type="button" class="nav-item" aria-current="page">Integrations</button>')
    expect(health).toMatch(/<h3 class="page-title" id="[^"]+">Integrations<\/h3>/)
    expect(views(health)).toEqual(['Health (lit)', 'Rules', 'Skills', 'Tools'])
    expect(views(dialog('skills'))).toEqual(['Health', 'Rules', 'Skills (lit)', 'Tools'])
  })

  it('opens Session details\' Hooks link on Integrations › Health, and keeps the head and its views together at the top', () => {
    expect(openedAt({ page: 'general', agents: 'roles', integrations: 'tools' }, 'hooks')).toEqual({ page: 'integrations', agents: 'roles', integrations: 'health' })
    const hooks = dialog('hooks')
    expect(hooks).toContain('<button type="button" class="nav-item" aria-current="page">Integrations</button>')
    expect(views(hooks)).toEqual(['Health (lit)', 'Rules', 'Skills', 'Tools'])
    expect(hooks).toMatch(/<div class="page-top"><header class="page-head"><h3 class="page-title" id="[^"]+">Integrations<\/h3>.*?<\/header><div class="page-views">/s)
    // A page without views keeps its head alone.
    expect(dialog('general')).toMatch(/<div class="preferences-page"><header class="page-head"><h3 class="page-title">General<\/h3>/)
  })

  it('makes Local control Health\'s last section, keeping its id, and shows it on no other view', () => {
    const health = dialog('integrations')
    expect(health).toMatch(/<section class="preferences-section" id="agent-control-section"><h4 class="group-head">Local control<span class="caption">/)
    expect(health.indexOf('id="agent-control-section"')).toBeGreaterThan(health.indexOf('class="preferences-page rules-page"'))
    expect(dialog('rules')).not.toContain('agent-control-section')
    expect(dialog('agents')).not.toContain('agent-control-section')
  })

  it('merges Appearance and Terminal into General, Desktop and Telegram into Notifications, History and Backup into Data, each under its own section head', () => {
    const heads = (markup: string, page: string): string[] => {
      const shown = new RegExp(`<div class="preferences-page"><header class="page-head"><h3 class="page-title"[^>]*>${page}</h3>.*?(?=<div class="preferences-page"|</main>)`, 's').exec(markup)?.[0] ?? ''
      return [...shown.matchAll(/<h4 class="group-head"[^>]*>([A-Za-z ]+)/g)].map((match) => match[1] as string)
    }
    expect(heads(dialog('general'), 'General')).toEqual(['Appearance', 'Terminal'])
    expect(heads(dialog('notifications'), 'Notifications')).toEqual(['Desktop', 'Telegram'])
    expect(heads(dialog('data'), 'Data')).toEqual(['History', 'Backup'])
    // One page shows at a time; the others are rendered hidden.
    const general = dialog('general')
    expect(count(general, '<div class="preferences-page" hidden="">')).toBe(3)
    expect(count(general, '<div class="preferences-page">')).toBe(1)
    // Every setting stays reachable: the rows of the pages that merged.
    for (const row of ['Identity', 'Color mode', 'Terminal font size', 'Let programs copy to the clipboard', 'Desktop notifications', 'Bot token', 'Keep agent history', 'Export backup…']) {
      expect(dialog(), row).toContain(row)
    }
  })

  it('opens where it was left, unless it was opened for a page or view', () => {
    const last = { page: 'data', agents: 'models', integrations: 'tools' } as const
    expect(openedAt(last)).toEqual(last)
    expect(openedAt(last, 'health')).toEqual({ page: 'integrations', agents: 'models', integrations: 'health' })
    expect(openedAt(last, 'roles')).toEqual({ page: 'agents', agents: 'roles', integrations: 'tools' })
    expect(openedAt(last, 'voice')).toEqual({ ...last, page: 'voice' })
    expect(openedAt(last, 'agents')).toEqual({ ...last, page: 'agents' })
  })
})

describe('Backup checks what it wrote at once (Story 75.7)', () => {
  const manifest = {
    formatVersion: 1 as const, createdAt: '2026-10-16T12:00:00.000Z', database: { file: 'state.sqlite3', sha256: 'a'.repeat(64), byteLength: 10 },
    artifacts: [{ file: 'artifacts/bb/artifact-1', artifactId: 'artifact-1', sha256: 'b'.repeat(64), byteLength: 5 }], excluded: ['Telegram bot token']
  }
  const outcome = (verification: BackupExportResult['verification']): string =>
    renderToStaticMarkup(createElement(BackupOutcome, { result: { directory: '/backups/bmn-backup-1', manifest, verification } }))

  it('offers one Export, which says it checks the copy, and no Verify', () => {
    const markup = renderToStaticMarkup(createElement(PreferencesDialog, {
      settings: DEFAULT_APP_SETTINGS, onSettings: () => undefined, onClose: () => undefined,
      saveVoice: async () => DEFAULT_APP_SETTINGS, suggestVocabulary: () => ({ ok: false as const, reason: 'test' }) }))
    expect(markup).toContain('>Export backup…</button>')
    expect(markup).toContain('Saves the database and artifacts to a folder you choose and checks the copy.')
    expect(markup).not.toMatch(/Verify a backup|Export and verify/)
  })

  it('says what was written and that the copy checked out', () => {
    const markup = outcome({ directory: '/backups/bmn-backup-1', ok: true, checked: 2, failures: [] })
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Exported to /backups/bmn-backup-1: database plus 1 artifact · verified, 2 files checked. Not included: Telegram bot token.')
  })

  it('says a copy that failed its check, file by file, as an alert', () => {
    const markup = outcome({ directory: '/backups/bmn-backup-1', ok: false, checked: 2, failures: [
      { file: 'artifacts/bb/artifact-1', reason: 'hash-mismatch' }, { file: 'state.sqlite3', reason: 'unreadable-database' }
    ] })
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('the copy failed its check; keep the earlier backup and export again.')
    expect(markup).toContain('<li>artifacts/bb/artifact-1: differs from what was written</li>')
    expect(markup).toContain('<li>state.sqlite3: cannot be read as a database</li>')
    expect(markup).not.toContain('verified, ')
  })
})

describe('QA: Health alerts help', () => {
  it('keeps switch-off timing instructions inside the existing limitations disclosure', () => {
    const markup = renderToStaticMarkup(createElement(PreferencesDialog, {
      initialPage: 'notifications', settings: DEFAULT_APP_SETTINGS, onSettings: () => undefined, onClose: () => undefined,
      saveVoice: async () => DEFAULT_APP_SETTINGS, suggestVocabulary: () => ({ ok: false as const, reason: 'test' })
    }))
    const disclosure = /<details class="advanced"><summary>What is checked, and what it cannot see<\/summary>.*?<\/details>/s.exec(markup)?.[0]
    expect(disclosure).toContain('Leave the time empty to keep watching; a time already past means that time tomorrow.')
  })
})
