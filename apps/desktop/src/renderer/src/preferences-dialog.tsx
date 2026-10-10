// MODULE: preferences-dialog.tsx - owner-facing preferences: a left navigation over pages for the team, the rules, appearance, terminal, notifications, voice, Telegram, local control, history and backup
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AppearanceSettings,
  AppSettings,
  BackupManifest,
  BackupVerifyResult,
  ControlInfo,
  HookCheckAgent,
  HookCheckReport,
  NotificationSettings,
  TerminalSettings,
  TelegramStatus,
  VoiceSettings
} from '@bmn/protocol'
import { COLOR_MODE_NAMES, DEFAULT_APP_SETTINGS, DEFAULT_TELEGRAM_QUIET_HOURS, DEFAULT_TELEGRAM_MORNING_DIGEST, IDENTITY_NAMES, TERMINAL_FONT_SIZE_RANGE, type AttentionKind } from '@bmn/protocol'
import { Icon } from './icons'
import { COLOR_MODE_PRESENTATION, IDENTITY_PRESENTATION } from './theme'
import { VoicePreferences } from './voice-preferences'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
import { HistoryPreferences } from './history-preferences'
import { TeamLedger, TeamPreferences, type TeamPage } from './team-preferences'
import { useTeamState } from './team-state'
import { RulesPreferences, useRulesState } from './rules-preferences'
import { Dot, RulesIcon, TeamIcon } from './roster-marks'
import { createHookCheckRunner } from './hook-check-runner'
import { parseTelegramForm, type TelegramFormFields } from './telegram-form'
import './preferences-dialog.css'

const DEFAULT_FONT_SIZE = DEFAULT_APP_SETTINGS.appearance.terminalFontSize

function clampFontSize(value: number): number {
  const rounded = Math.round(value)
  return Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.max(TERMINAL_FONT_SIZE_RANGE.min, rounded))
}

function idText(value: number | null): string {
  return value === null ? '' : String(value)
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const USAGE_LINES = [
  'bmn progress running "Story 2.2" --source epic-auto',
  'bmn ask pick-db "Which database?" --body "…"',
  'bmn publish ./report.png',
  'bmn send --submit -- "continue"'
]

const TEST_MESSAGE_DISABLED_TITLE = 'Send a test message once Telegram is connected and polling'

/** Request kinds quiet hours can let through, in display order; the stored values stay lowercase. */
const QUIET_ALLOW_KINDS: ReadonlyArray<{ kind: AttentionKind; label: string }> = [
  { kind: 'permission', label: 'Permission' },
  { kind: 'question', label: 'Question' },
  { kind: 'handoff', label: 'Handoff' },
  { kind: 'review', label: 'Review' },
  { kind: 'notice', label: 'Notice' }
]

const HOOK_CHECK_NAMES: Readonly<Record<HookCheckAgent, string>> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor'
}

/** Every page of the dialog. Team and Rules head the navigation and open their sub-pages; the rest are grouped. */
export type PreferencesPage = 'team' | 'roles' | 'changes' | 'rules' | 'health' | 'appearance' | 'terminal' | 'notifications' | 'voice' | 'telegram' | 'control' | 'history' | 'backup'

export const PREFERENCES_NAVIGATION: ReadonlyArray<
  | { parent: 'team' | 'rules'; label: string; pages: ReadonlyArray<{ page: PreferencesPage; label: string }> }
  | { group: string; pages: ReadonlyArray<{ page: PreferencesPage; label: string }> }
> = [
  { parent: 'team', label: 'Team', pages: [{ page: 'team', label: 'Agents' }, { page: 'roles', label: 'Roles' }, { page: 'changes', label: 'Changes' }] },
  { parent: 'rules', label: 'Rules', pages: [{ page: 'rules', label: 'Editor' }, { page: 'health', label: 'Health' }] },
  { group: 'Workspace', pages: [{ page: 'appearance', label: 'Appearance' }, { page: 'terminal', label: 'Terminal' }, { page: 'notifications', label: 'Notifications' }, { page: 'voice', label: 'Voice' }] },
  { group: 'Phone', pages: [{ page: 'telegram', label: 'Telegram' }] },
  { group: 'Machine', pages: [{ page: 'control', label: 'Local control' }, { page: 'history', label: 'History' }, { page: 'backup', label: 'Backup' }] }
]

/** The navigation parent a page sits under, or null for a grouped page. */
export function pageParent(page: PreferencesPage): 'team' | 'rules' | null {
  return page === 'team' || page === 'roles' || page === 'changes' ? 'team' : page === 'rules' || page === 'health' ? 'rules' : null
}

/**
 * Telegram's status as a list. An error is said once: in the cue while it shows, otherwise in full under Last error;
 * State then gives only its word.
 */
export function TelegramStatusList(props: { status: TelegramStatus; cueShown: boolean }): React.JSX.Element {
  const status = props.status
  return (
    <dl className="kv telegram-status" aria-label="Telegram status">
      <dt>State</dt>
      <dd>{status.lastError === null ? `${status.state} · ${status.detail}` : status.state}</dd>
      <dt>Token</dt>
      <dd className={status.tokenMask ? undefined : 'none'}>{status.tokenMask ?? 'not set'}</dd>
      <dt>Last poll</dt>
      <dd className={status.lastPollAt ? undefined : 'none'}>{status.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : 'never'}</dd>
      <dt>Last error</dt>
      {props.cueShown && status.lastError
        ? <dd className="none">shown above</dd>
        : <dd className={status.lastError ? 'error' : 'none'}>{status.lastError ?? 'none'}</dd>}
      <dt>Rejected updates</dt>
      <dd>{status.rejectedUpdates}</dd>
    </dl>
  )
}

export function PreferencesDialog(props: {
  settings: AppSettings
  initialSection?: 'agent-control' | undefined
  onSettings(next: AppSettings): void
  onClose(): void
  /** Saves the voice section through the app's queue, built from the latest settings. */
  saveVoice(change: (current: VoiceSettings) => VoiceSettings): Promise<AppSettings>
  /** Candidate dictation words from the selected live session, or why there are none. */
  suggestVocabulary(): { ok: true; words: string[] } | { ok: false; reason: string }
  /** Why the gear shows a dot for Telegram, or null. */
  telegramCue?: string | null
}): React.JSX.Element {
  const onSettings = useRef(props.onSettings)
  onSettings.current = props.onSettings

  // --- Pages ---------------------------------------------------------------
  const [page, setPage] = useState<PreferencesPage>(props.initialSection === 'agent-control' ? 'control' : 'team')
  // An agent and New agent open under Team › Agents, never as navigation items.
  const [teamPage, setTeamPage] = useState<TeamPage>({ name: 'agents' })
  const team = useTeamState()
  const rules = useRulesState()
  const main = useRef<HTMLElement | null>(null)
  const parent = pageParent(page)
  // What each app may read, and which app versions count as accepted, follow the approved team.
  const approvedVersion = team.snapshot?.approved?.generation ?? null
  const refreshRules = rules.refresh
  useEffect(() => refreshRules(), [approvedVersion, refreshRules])

  function go(next: PreferencesPage): void {
    setPage(next)
    if (next === 'team') setTeamPage({ name: 'agents' })
    main.current?.scrollTo({ top: 0 })
  }

  function goTeam(next: TeamPage): void {
    setTeamPage(next)
    setPage(next.name === 'roles' ? 'roles' : next.name === 'changes' ? 'changes' : 'team')
    main.current?.scrollTo({ top: 0 })
  }

  const shownTeamPage: TeamPage = page === 'roles' ? { name: 'roles' } : page === 'changes' ? { name: 'changes' } : teamPage
  const rulesNeedOwner = rules.snapshot?.health.state === 'checked' && rules.snapshot.master.exists && rules.snapshot.health.targets.some((target) => target.state !== 'current')
  // Staged edits are approved from the footer on the pages that stage them; New agent has its own.
  const ledger = (parent === 'team' && shownTeamPage.name !== 'new') || page === 'health'
  const pageOf = (id: PreferencesPage, children: ReactNode): React.JSX.Element => <div className="preferences-page" hidden={page !== id}>{children}</div>

  // --- Appearance ---------------------------------------------------------
  const [appearance, setAppearance] = useState<AppearanceSettings>(props.settings.appearance)
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [appearanceError, setAppearanceError] = useState<string | null>(null)

  async function saveAppearance(next: AppearanceSettings): Promise<void> {
    const previous = appearance
    setAppearance(next)
    setAppearanceBusy(true)
    setAppearanceError(null)
    try {
      const result = await window.aiTerminal.putSettings('appearance', next)
      setAppearance(result.appearance)
      onSettings.current(result)
    } catch (error) {
      setAppearance(previous)
      setAppearanceError(failureDetail(error, 'Could not save appearance settings'))
    } finally {
      setAppearanceBusy(false)
    }
  }

  function onFontSizeInput(raw: string): void {
    if (raw.trim().length === 0) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(parsed) })
  }

  // --- Notifications -------------------------------------------------------
  const [notifications, setNotifications] = useState<NotificationSettings>(props.settings.notifications)
  const [notificationsBusy, setNotificationsBusy] = useState(false)
  const [notificationsError, setNotificationsError] = useState<string | null>(null)

  async function saveNotifications(next: NotificationSettings): Promise<void> {
    const previous = notifications
    setNotifications(next)
    setNotificationsBusy(true)
    setNotificationsError(null)
    try {
      const result = await window.aiTerminal.putSettings('notifications', next)
      setNotifications(result.notifications)
      onSettings.current(result)
    } catch (error) {
      setNotifications(previous)
      setNotificationsError(failureDetail(error, 'Could not save notification settings'))
    } finally {
      setNotificationsBusy(false)
    }
  }

  // --- Terminal ---------------------------------------------------------
  const [terminal, setTerminal] = useState<TerminalSettings>(props.settings.terminal)
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [terminalError, setTerminalError] = useState<string | null>(null)

  async function saveTerminal(next: TerminalSettings): Promise<void> {
    const previous = terminal
    setTerminal(next)
    setTerminalBusy(true)
    setTerminalError(null)
    try {
      const result = await window.aiTerminal.putSettings('terminal', next)
      setTerminal(result.terminal)
      onSettings.current(result)
    } catch (error) {
      setTerminal(previous)
      setTerminalError(failureDetail(error, 'Could not save terminal settings'))
    } finally {
      setTerminalBusy(false)
    }
  }

  // --- Telegram: status ------------------------------------------------
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null)
  const [telegramStatusBusy, setTelegramStatusBusy] = useState(false)
  const [telegramStatusError, setTelegramStatusError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTelegramStatusBusy(true)
    window.aiTerminal
      .getTelegramStatus()
      .then((status) => {
        if (!cancelled) setTelegramStatus(status)
      })
      .catch((error: unknown) => {
        if (!cancelled) setTelegramStatusError(failureDetail(error, 'Could not load Telegram status'))
      })
      .finally(() => {
        if (!cancelled) setTelegramStatusBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function refreshTelegramStatus(): Promise<void> {
    setTelegramStatusBusy(true)
    setTelegramStatusError(null)
    try {
      setTelegramStatus(await window.aiTerminal.getTelegramStatus())
    } catch (error) {
      setTelegramStatusError(failureDetail(error, 'Could not load Telegram status'))
    } finally {
      setTelegramStatusBusy(false)
    }
  }

  // --- Telegram: token ---------------------------------------------------
  const [tokenInput, setTokenInput] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenSuccess, setTokenSuccess] = useState<string | null>(null)

  async function configureToken(token: string | null): Promise<void> {
    setTokenBusy(true)
    setTokenError(null)
    setTokenSuccess(null)
    try {
      const status = await window.aiTerminal.configureTelegram(token)
      setTelegramStatus(status)
      setTokenInput('')
      setTokenSuccess(token === null ? 'Token removed.' : 'Token saved.')
    } catch (error) {
      setTokenError(failureDetail(error, 'Could not save the bot token'))
    } finally {
      setTokenBusy(false)
    }
  }

  // --- Telegram: form (chat/user id, notifyOn, autoSubmitReplies, answerPermissions, enabled) ---
  const [chatIdInput, setChatIdInput] = useState(idText(props.settings.telegram.allowedChatId))
  const [userIdInput, setUserIdInput] = useState(idText(props.settings.telegram.allowedUserId))
  const [notifyOn, setNotifyOn] = useState(props.settings.telegram.notifyOn)
  const [autoSubmitReplies, setAutoSubmitReplies] = useState(props.settings.telegram.autoSubmitReplies)
  const [answerPermissions, setAnswerPermissions] = useState(props.settings.telegram.answerPermissions)
  const [telegramEnabled, setTelegramEnabled] = useState(props.settings.telegram.enabled)
  const [quietHours, setQuietHours] = useState(props.settings.telegram.quietHours ?? DEFAULT_TELEGRAM_QUIET_HOURS)
  const [morningDigest, setMorningDigest] = useState(props.settings.telegram.morningDigest ?? DEFAULT_TELEGRAM_MORNING_DIGEST)
  const [telegramFormBusy, setTelegramFormBusy] = useState(false)
  const [telegramFormError, setTelegramFormError] = useState<string | null>(null)
  const [telegramFormSuccess, setTelegramFormSuccess] = useState<string | null>(null)

  async function saveTelegramForm(): Promise<void> {
    const fields: TelegramFormFields = {
      enabled: telegramEnabled,
      allowedChatId: chatIdInput,
      allowedUserId: userIdInput,
      notifyOn,
      autoSubmitReplies,
      answerPermissions,
      quietHours,
      morningDigest
    }
    const parsed = parseTelegramForm(fields)
    if (!parsed.ok) {
      setTelegramFormError(parsed.message)
      setTelegramFormSuccess(null)
      return
    }
    setTelegramFormBusy(true)
    setTelegramFormError(null)
    setTelegramFormSuccess(null)
    try {
      const result = await window.aiTerminal.putSettings('telegram', parsed.value)
      setChatIdInput(idText(result.telegram.allowedChatId))
      setUserIdInput(idText(result.telegram.allowedUserId))
      setNotifyOn(result.telegram.notifyOn)
      setAutoSubmitReplies(result.telegram.autoSubmitReplies)
      setAnswerPermissions(result.telegram.answerPermissions)
      setTelegramEnabled(result.telegram.enabled)
      setQuietHours(result.telegram.quietHours ?? DEFAULT_TELEGRAM_QUIET_HOURS)
      setMorningDigest(result.telegram.morningDigest ?? DEFAULT_TELEGRAM_MORNING_DIGEST)
      onSettings.current(result)
      setTelegramFormSuccess('Telegram settings saved.')
      void refreshTelegramStatus()
    } catch (error) {
      setTelegramFormError(failureDetail(error, 'Could not save Telegram settings'))
    } finally {
      setTelegramFormBusy(false)
    }
  }

  // --- Telegram: test message ---------------------------------------------
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [testSuccess, setTestSuccess] = useState<string | null>(null)
  const canSendTest = telegramStatus?.state === 'polling'

  async function sendTest(): Promise<void> {
    setTestBusy(true)
    setTestError(null)
    setTestSuccess(null)
    try {
      const status = await window.aiTerminal.testTelegram()
      setTelegramStatus(status)
      setTestSuccess('Test message sent.')
    } catch (error) {
      setTestError(failureDetail(error, 'Could not send the test message'))
    } finally {
      setTestBusy(false)
    }
  }

  // --- Local agent control -------------------------------------------------
  const [controlInfo, setControlInfo] = useState<ControlInfo | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [hookCheck, setHookCheck] = useState<HookCheckReport | null>(null)
  const [hookCheckBusy, setHookCheckBusy] = useState(false)
  const [hookCheckError, setHookCheckError] = useState<string | null>(null)
  const hookCheckRunner = useRef<ReturnType<typeof createHookCheckRunner> | null>(null)
  if (hookCheckRunner.current === null) {
    hookCheckRunner.current = createHookCheckRunner(
      () => window.aiTerminal.checkHookConfiguration(),
      (event) => {
        if (event.kind === 'started') {
          setHookCheckBusy(true)
          setHookCheckError(null)
        } else if (event.kind === 'checked') {
          setHookCheck(event.report)
          setHookCheckBusy(false)
        } else {
          setHookCheck(null)
          setHookCheckError(failureDetail(event.cause, 'Hook configuration check unavailable'))
          setHookCheckBusy(false)
        }
      }
    )
  }
  const [copying, setCopying] = useState<'socket' | 'cli' | null>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.aiTerminal
      .getControlInfo()
      .then((info) => {
        if (!cancelled) setControlInfo(info)
      })
      .catch((error: unknown) => {
        if (!cancelled) setControlError(failureDetail(error, 'Could not load agent control info'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => { hookCheckRunner.current?.cancel() }, [])

  async function checkHooks(): Promise<void> {
    await hookCheckRunner.current?.run()
  }

  async function copyText(kind: 'socket' | 'cli', text: string): Promise<void> {
    setCopying(kind)
    setCopyError(null)
    setCopyMessage(null)
    try {
      await window.aiTerminal.writeClipboardText(text)
      setCopyMessage(kind === 'socket' ? 'Socket path copied.' : 'CLI path copied.')
    } catch (error) {
      setCopyError(failureDetail(error, 'Could not copy to the clipboard'))
    } finally {
      setCopying(null)
    }
  }

  // --- Backup ---------------------------------------------------------------
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<{ directory: string; manifest: BackupManifest } | null>(null)

  async function runExportBackup(): Promise<void> {
    setExportBusy(true)
    setExportError(null)
    try {
      const outcome = await window.aiTerminal.exportBackup()
      if (outcome) setExportResult(outcome)
    } catch (error) {
      setExportError(failureDetail(error, 'Could not export the backup'))
    } finally {
      setExportBusy(false)
    }
  }

  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<BackupVerifyResult | null>(null)

  async function runVerifyBackup(): Promise<void> {
    setVerifyBusy(true)
    setVerifyError(null)
    try {
      const outcome = await window.aiTerminal.verifyBackup()
      if (outcome) setVerifyResult(outcome)
    } catch (error) {
      setVerifyError(failureDetail(error, 'Could not verify the backup'))
    } finally {
      setVerifyBusy(false)
    }
  }

  return (
    <Dialog label="Preferences" className="preferences-dialog" onClose={props.onClose}>
      <div className="preferences-frame">
      <nav className="preferences-nav" aria-label="Preference pages">
        {PREFERENCES_NAVIGATION.map((entry) => 'parent' in entry ? (
          <div key={entry.parent} className="nav-parent">
            <button type="button" className="nav-item" aria-current={parent === entry.parent ? 'true' : undefined} aria-expanded={parent === entry.parent}
              onClick={() => go(entry.parent)}>
              {entry.parent === 'team' ? <TeamIcon /> : <RulesIcon />}{entry.label}
              {(entry.parent === 'team' ? team.needsOwner : rulesNeedOwner) ? <Dot label="Needs you" /> : null}
            </button>
            {parent === entry.parent ? (
              <div className="nav-sub">
                {entry.pages.map((item) => (
                  <button key={item.page} type="button" className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div key={entry.group} className="nav-group" role="group" aria-label={entry.group}>
            <span className="nav-head" aria-hidden="true">{entry.group}</span>
            {entry.pages.map((item) => (
              <button key={item.page} type="button" className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
            ))}
          </div>
        ))}
      </nav>
      <main className="preferences-main" ref={main}>
      {parent === 'team' ? <div className="preferences-page team-page"><TeamPreferences team={team} page={shownTeamPage} go={goTeam} /></div> : null}
      {parent === 'rules' ? <div className="preferences-page rules-page"><RulesPreferences rules={rules} team={team} page={page === 'health' ? 'health' : 'editor'} /></div> : null}
      {pageOf('appearance', <>
      <section className="preferences-section">
        <h3>Appearance</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Identity</span>
          </div>
          <div className="preferences-row-control preferences-identities" role="radiogroup" aria-label="Identity">
            {IDENTITY_NAMES.map((identity) => (
              <label className="preferences-radio" key={identity}>
                <input
                  type="radio"
                  name="preferences-identity"
                  checked={appearance.identity === identity}
                  disabled={appearanceBusy}
                  onChange={() => void saveAppearance({ ...appearance, identity })}
                />
                <Icon name={IDENTITY_PRESENTATION[identity].icon} size={14} />
                {IDENTITY_PRESENTATION[identity].label} ({IDENTITY_PRESENTATION[identity].motto})
              </label>
            ))}
          </div>
        </div>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Color mode</span>
          </div>
          <div className="preferences-row-control" role="radiogroup" aria-label="Color mode">
            {COLOR_MODE_NAMES.map((colorMode) => (
              <label className="preferences-radio" key={colorMode}>
                <input
                  type="radio"
                  name="preferences-color-mode"
                  checked={appearance.colorMode === colorMode}
                  disabled={appearanceBusy}
                  onChange={() => void saveAppearance({ ...appearance, colorMode })}
                />
                {COLOR_MODE_PRESENTATION[colorMode].label} ({COLOR_MODE_PRESENTATION[colorMode].description})
              </label>
            ))}
          </div>
        </div>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Terminal font size</span>
          </div>
          <div className="preferences-row-control">
            <div className="preferences-font-size">
              <button
                type="button"
                className="icon-button"
                aria-label="Decrease terminal font size"
                disabled={appearanceBusy || appearance.terminalFontSize <= TERMINAL_FONT_SIZE_RANGE.min}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(appearance.terminalFontSize - 1) })}
              >
                −
              </button>
              <input
                type="number"
                aria-label="Terminal font size"
                min={TERMINAL_FONT_SIZE_RANGE.min}
                max={TERMINAL_FONT_SIZE_RANGE.max}
                value={appearance.terminalFontSize}
                disabled={appearanceBusy}
                onChange={(event) => onFontSizeInput(event.target.value)}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Increase terminal font size"
                disabled={appearanceBusy || appearance.terminalFontSize >= TERMINAL_FONT_SIZE_RANGE.max}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: clampFontSize(appearance.terminalFontSize + 1) })}
              >
                +
              </button>
              <button
                type="button"
                disabled={appearanceBusy || appearance.terminalFontSize === DEFAULT_FONT_SIZE}
                onClick={() => void saveAppearance({ ...appearance, terminalFontSize: DEFAULT_FONT_SIZE })}
              >
                Reset
              </button>
              <span className="preferences-help">{TERMINAL_FONT_SIZE_RANGE.min}–{TERMINAL_FONT_SIZE_RANGE.max}px</span>
            </div>
            <div className="preferences-font-preview" style={{ fontFamily: 'var(--font-mono)', fontSize: `${appearance.terminalFontSize}px` }}>
              Ґґ Єє Іі Її — Hello, terminal ─┼─ ✓
            </div>
          </div>
        </div>
        {appearanceError && (
          <p className="preferences-error" role="alert">
            {appearanceError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('terminal', <>
      <section className="preferences-section">
        <h3>Terminal</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Clipboard</span>
          </div>
          <div className="preferences-row-control">
            <label className="preferences-radio">
              <input
                id="preferences-program-clipboard"
                type="checkbox"
                checked={terminal.programClipboard}
                disabled={terminalBusy}
                onChange={(event) => void saveTerminal({ programClipboard: event.target.checked })}
              />
              Let programs copy to the clipboard
            </label>
            <p className="preferences-help">tmux, Neovim or SSH can copy; no program can read it.</p>
          </div>
        </div>
        {terminalError && (
          <p className="preferences-error" role="alert">
            {terminalError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('notifications', <>
      <section className="preferences-section">
        <h3>Notifications</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-desktop-notifications">Desktop notifications</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-desktop-notifications"
              type="checkbox"
              checked={notifications.desktop}
              disabled={notificationsBusy}
              onChange={(event) => void saveNotifications({ desktop: event.target.checked })}
            />
            <p className="preferences-help">When a session needs you and no BMN window is focused.</p>
          </div>
        </div>
        {notificationsError && (
          <p className="preferences-error" role="alert">
            {notificationsError}
          </p>
        )}
      </section>
      </>)}

      {pageOf('voice', <VoicePreferences settings={props.settings.voice} save={props.saveVoice} suggest={props.suggestVocabulary} />)}

      {pageOf('telegram', <>
      <section className="preferences-section">
        <div className="preferences-section-head">
          <h3>Telegram</h3>
          <button type="button" className="small" disabled={telegramStatusBusy} onClick={() => void refreshTelegramStatus()}>
            {telegramStatusBusy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {props.telegramCue ? (
          <div className="history-confirm telegram-cue" role="status">
            <span className="status-dot needs-you" aria-hidden="true" />
            <p>{props.telegramCue}</p>
          </div>
        ) : null}
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-enabled">Enabled</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-enabled"
              type="checkbox"
              checked={telegramEnabled}
              disabled={telegramFormBusy}
              onChange={(event) => setTelegramEnabled(event.target.checked)}
            />
          </div>
        </div>
        {telegramStatus ? (
          <TelegramStatusList status={telegramStatus} cueShown={!!props.telegramCue} />
        ) : (
          !telegramStatusBusy && <p className="preferences-help">Status unavailable.</p>
        )}
        {telegramStatusError && (
          <p className="preferences-error" role="alert">
            {telegramStatusError}
          </p>
        )}

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-token">Bot token</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              disabled={tokenBusy}
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <div className="preferences-button-row">
              <button type="button" disabled={tokenBusy || tokenInput.trim().length === 0} onClick={() => void configureToken(tokenInput.trim())}>
                {tokenBusy ? 'Saving…' : 'Save token'}
              </button>
              <button type="button" disabled={tokenBusy} onClick={() => void configureToken(null)}>
                Remove token
              </button>
            </div>
          </div>
        </div>
        {tokenError && (
          <p className="preferences-error" role="alert">
            {tokenError}
          </p>
        )}
        {tokenSuccess && (
          <p className="preferences-success" role="status">
            {tokenSuccess}
          </p>
        )}

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-chat-id">Allowed chat ID</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-chat-id"
              type="text"
              inputMode="numeric"
              value={chatIdInput}
              disabled={telegramFormBusy}
              onChange={(event) => setChatIdInput(event.target.value)}
            />
            <p className="preferences-help">Only the allowed chat can reply, and only to a notification.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-user-id">Allowed user ID</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-user-id"
              type="text"
              inputMode="numeric"
              value={userIdInput}
              disabled={telegramFormBusy}
              onChange={(event) => setUserIdInput(event.target.value)}
            />
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-notify-on">Notify on</label>
          </div>
          <div className="preferences-row-control">
            <select
              id="preferences-telegram-notify-on"
              value={notifyOn}
              disabled={telegramFormBusy}
              onChange={(event) => setNotifyOn(event.target.value as 'attention' | 'attention-and-exit')}
            >
              <option value="attention">Needs-you requests</option>
              <option value="attention-and-exit">Needs-you requests and session exits</option>
            </select>
          </div>
        </div>

        {/* Morning digest and Quiet hours keep the dialog's label/control rows; dependent controls stay rendered and keep
            their values while their feature is off, and only Save Telegram settings persists them. */}
        <div className="telegram-group">
          <div className="preferences-row">
            <div className="preferences-row-label">
              <label htmlFor="preferences-telegram-digest">Morning digest</label>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-schedule">
                <input
                  id="preferences-telegram-digest"
                  type="checkbox"
                  checked={morningDigest.enabled}
                  disabled={telegramFormBusy}
                  onChange={(event) => setMorningDigest({ ...morningDigest, enabled: event.target.checked })}
                />
                <span>
                  <label htmlFor="preferences-telegram-digest">Send daily at</label>
                  <input
                    id="preferences-telegram-digest-time"
                    aria-label="Morning digest time"
                    type="time"
                    value={morningDigest.time}
                    disabled={telegramFormBusy || !morningDigest.enabled}
                    onChange={(event) => setMorningDigest({ ...morningDigest, time: event.target.value })}
                  />
                </span>
              </div>
              <p className="preferences-help">Local time. Waits while quiet hours are on; a missed day is skipped.</p>
              {!telegramEnabled && (
                <p className="preferences-help">Telegram is off; no digest will be sent. Enable and connect Telegram to deliver it.</p>
              )}
              <details className="advanced">
                <summary>What the digest includes</summary>
                <div className="advanced-body">
                  <p>Each workspace with its checkout name, epics, Status, Decided-for-you entries and owner-item titles.</p>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="telegram-group">
          <div className="preferences-row">
            <div className="preferences-row-label">
              <label htmlFor="preferences-telegram-quiet">Quiet hours</label>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-schedule">
                <input
                  id="preferences-telegram-quiet"
                  type="checkbox"
                  checked={quietHours.enabled}
                  disabled={telegramFormBusy}
                  onChange={(event) => setQuietHours({ ...quietHours, enabled: event.target.checked })}
                />
                <span>
                  <label htmlFor="preferences-telegram-quiet">Hold phone messages from</label>
                  <input
                    id="preferences-telegram-quiet-start"
                    aria-label="Quiet hours start"
                    type="time"
                    value={quietHours.start}
                    disabled={telegramFormBusy || !quietHours.enabled}
                    onChange={(event) => setQuietHours({ ...quietHours, start: event.target.value })}
                  />
                </span>
                <span>
                  <span>to</span>
                  <input
                    id="preferences-telegram-quiet-end"
                    aria-label="Quiet hours end"
                    type="time"
                    value={quietHours.end}
                    disabled={telegramFormBusy || !quietHours.enabled}
                    onChange={(event) => setQuietHours({ ...quietHours, end: event.target.value })}
                  />
                </span>
              </div>
              <p className="preferences-help">Local time. Held messages are sent when quiet hours end.</p>
            </div>
          </div>

          <div className="preferences-row">
            <div className="preferences-row-label">
              <span id="preferences-telegram-quiet-allow">Let through</span>
            </div>
            <div className="preferences-row-control">
              <div className="telegram-kinds" role="group" aria-labelledby="preferences-telegram-quiet-allow">
                {QUIET_ALLOW_KINDS.map(({ kind, label }) => (
                  <label key={kind} className="preferences-radio">
                    <input
                      type="checkbox"
                      checked={quietHours.allowKinds.includes(kind)}
                      disabled={telegramFormBusy || !quietHours.enabled}
                      onChange={(event) => setQuietHours({ ...quietHours, allowKinds: event.target.checked
                        ? [...quietHours.allowKinds, kind] : quietHours.allowKinds.filter(value => value !== kind) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="preferences-help">Single sessions can also be let through from their session menu (up to 20).</p>
            </div>
          </div>

          {telegramStatus?.quietHours ? (
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>Now</span>
              </div>
              <div className="preferences-row-control">
                <div className="telegram-quiet-now" role="status">
                  <p className="telegram-quiet-state" data-active={telegramStatus.quietHours.active}>
                    {telegramStatus.quietHours.active ? `Active until ${telegramStatus.quietHours.until}` : 'Not active'}
                    {' · '}{telegramStatus.quietHours.waiting} waiting
                  </p>
                  {telegramStatus.quietHours.capacityBlocked ? (
                    <p className="preferences-error">Delivery history is full; uncertain messages need checking.</p>
                  ) : null}
                </div>
                {telegramStatus.quietHours.problem ? (
                  <p className="preferences-error" role="alert">
                    Phone delivery history is unavailable. Automatic delivery is paused until it can be read.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="preferences-row">
            <div className="preferences-row-label" />
            <div className="preferences-row-control">
              <details className="advanced">
                <summary>How quiet hours work</summary>
                <div className="advanced-body">
                  <p>When quiet hours end, Telegram gets one summary with session names, request kinds and titles, then each request that is still waiting.</p>
                  <p>Session dots stay current throughout.</p>
                  <p>The kinds and sessions you let through still arrive immediately.</p>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-auto-submit">Type replies into the session</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-auto-submit"
              type="checkbox"
              checked={autoSubmitReplies}
              disabled={telegramFormBusy}
              onChange={(event) => setAutoSubmitReplies(event.target.checked)}
            />
            <p className="preferences-help">Presses Enter too. Off: replies are kept as drafts in Files.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-answer-permissions">Answer permissions</label>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-answer-permissions"
              type="checkbox"
              checked={answerPermissions}
              disabled={telegramFormBusy}
              onChange={(event) => setAnswerPermissions(event.target.checked)}
            />
            <p className="preferences-help">Allow once/Deny for native cards. Also lets phone taps send manual authorization decisions as messages.</p>
          </div>
        </div>

        <div className="preferences-row">
          <div className="preferences-row-label" />
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" className="primary" disabled={telegramFormBusy} onClick={() => void saveTelegramForm()}>
                {telegramFormBusy ? 'Saving…' : 'Save Telegram settings'}
              </button>
              <button
                type="button"
                disabled={!canSendTest || testBusy}
                title={canSendTest ? undefined : TEST_MESSAGE_DISABLED_TITLE}
                onClick={() => void sendTest()}
              >
                {testBusy ? 'Sending…' : 'Send test message'}
              </button>
            </div>
          </div>
        </div>
        {telegramFormError && (
          <p className="preferences-error" role="alert">
            {telegramFormError}
          </p>
        )}
        {telegramFormSuccess && (
          <p className="preferences-success" role="status">
            {telegramFormSuccess}
          </p>
        )}
        {testError && (
          <p className="preferences-error" role="alert">
            {testError}
          </p>
        )}
        {testSuccess && (
          <p className="preferences-success" role="status">
            {testSuccess}
          </p>
        )}
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <p>A reply must answer a notification; it never goes to the focused session.</p>
            <p>A permission tap answers only the exact prompt on screen.</p>
          </div>
        </details>
      </section>
      </>)}

      {pageOf('history', <HistoryPreferences settings={props.settings} onSettings={(next) => onSettings.current(next)} />)}

      {pageOf('control', <>
      <section className="preferences-section" id="agent-control-section">
        <h3>Local control</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Listening</span>
          </div>
          <div className="preferences-row-control">
            {controlInfo ? (
              <p>
                {controlInfo.listening ? 'Yes' : 'No'} · {controlInfo.detail}
              </p>
            ) : (
              <p className="preferences-help">Loading…</p>
            )}
          </div>
        </div>
        {controlInfo && (
          <>
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>Socket path</span>
              </div>
              <div className="preferences-row-control">
                <code className="preferences-mono preferences-path" title={controlInfo.socketPath}><bdi>{controlInfo.socketPath}</bdi></code>
                <button type="button" disabled={copying === 'socket'} onClick={() => void copyText('socket', controlInfo.socketPath)}>
                  Copy
                </button>
              </div>
            </div>
            <div className="preferences-row">
              <div className="preferences-row-label">
                <span>CLI path</span>
              </div>
              <div className="preferences-row-control">
                <code className="preferences-mono preferences-path" title={controlInfo.cliPath}><bdi>{controlInfo.cliPath}</bdi></code>
                <button type="button" disabled={copying === 'cli'} onClick={() => void copyText('cli', controlInfo.cliPath)}>
                  Copy
                </button>
              </div>
            </div>
          </>
        )}
        {controlError && (
          <p className="preferences-error" role="alert">
            {controlError}
          </p>
        )}
        <div className="preferences-row">
          <div className="preferences-row-label"><span>Harness hooks</span></div>
          <div className="preferences-row-control">
            <button type="button" onClick={() => void checkHooks()}>
              {hookCheckBusy ? 'Checking…' : 'Check configured hooks'}
            </button>
            <p className="preferences-help">Configured entries do not prove hooks fired.</p>
            {hookCheck ? (
              <div className="hook-check-report" role="status">
                <p>Checked {new Date(hookCheck.checkedAt).toLocaleString()} · snapshot of harness files</p>
                {hookCheck.state === 'failed' ? (
                  <p>Unavailable: {hookCheck.reason}</p>
                ) : hookCheck.agents.map((agent) => (
                  <section key={agent.agent} aria-label={agent.agent === 'claude' ? 'Claude Code hooks' : `${agent.agent} hooks`}>
                    <h4>{HOOK_CHECK_NAMES[agent.agent]}</h4>
                    <p>{agent.state === 'read'
                      ? agent.missing.length === 0 ? 'Configured' : 'Missing entry'
                      : agent.state === 'missing' ? 'File missing · Missing entry' : 'Unable to read'}
                      {' · '}file {agent.state}: <code>{agent.file}</code>
                    </p>
                    <ul>
                      {agent.entries.map((entry) => <li key={entry.event}>
                        {entry.event} · {entry.state === 'missing'
                          ? entry.optional ? 'Optional entry absent' : 'Missing entry'
                          : entry.state === 'wired (older wording)' ? 'Configured (older wording)' : 'Configured'}
                      </li>)}
                    </ul>
                    {agent.missing.length > 0 ? <p>Missing entries: {agent.missing.join(', ')}</p> : null}
                  </section>
                ))}
              </div>
            ) : null}
            {hookCheckError ? <p className="preferences-error" role="alert">{hookCheckError}</p> : null}
          </div>
        </div>
        {copyError && (
          <p className="preferences-error" role="alert">
            {copyError}
          </p>
        )}
        {copyMessage && (
          <p className="preferences-success" role="status">
            {copyMessage}
          </p>
        )}
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-body">
            <p>For Codex, trust hooks with /hooks in Codex and check a real Hook events entry.</p>
            <pre className="preferences-usage">{USAGE_LINES.join('\n')}</pre>
            <p>Sessions started by BMN get BMN_CONTROL_SOCKET and BMN_TOKEN automatically.</p>
          </div>
        </details>
      </section>
      </>)}

      {pageOf('backup', <>
      <section className="preferences-section">
        <h3>Backup</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Export and verify</span>
          </div>
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" disabled={exportBusy} onClick={() => void runExportBackup()}>
                {exportBusy ? 'Exporting…' : 'Export backup…'}
              </button>
              <button type="button" disabled={verifyBusy} onClick={() => void runVerifyBackup()}>
                {verifyBusy ? 'Verifying…' : 'Verify a backup…'}
              </button>
            </div>
            <p className="preferences-help">Saves the database and artifacts to a folder you choose.</p>
          </div>
        </div>
        {exportError && (
          <p className="preferences-error" role="alert">
            {exportError}
          </p>
        )}
        {exportResult && (
          <p className="preferences-success" role="status">
            Exported to {exportResult.directory}: database plus {pluralize(exportResult.manifest.artifacts.length, 'artifact')}.
            {exportResult.manifest.excluded.length > 0 && <> Not included: {exportResult.manifest.excluded.join(', ')}.</>}
          </p>
        )}
        {verifyError && (
          <p className="preferences-error" role="alert">
            {verifyError}
          </p>
        )}
        {verifyResult &&
          (verifyResult.ok ? (
            <p className="preferences-success" role="status">
              Backup verified: {pluralize(verifyResult.checked, 'file')} checked.
            </p>
          ) : (
            <div className="preferences-error" role="alert">
              <p>Backup verification failed:</p>
              <ul>
                {verifyResult.failures.map((failure) => (
                  <li key={failure.file}>
                    {failure.file}: {failure.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </section>
      </>)}
      </main>
      </div>
      {ledger ? <TeamLedger team={team} /> : null}
    </Dialog>
  )
}
