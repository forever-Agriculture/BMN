// MODULE: preferences-dialog.tsx - owner-facing preferences: appearance, notifications, voice, Telegram, archive, agent control, backup
import { useEffect, useRef, useState } from 'react'
import type {
  AppearanceSettings,
  AppSettings,
  ArchiveDeleteAfterDays,
  BackupManifest,
  BackupVerifyResult,
  ControlInfo,
  NotificationSettings,
  TelegramStatus
} from '@ai-terminal/protocol'
import { ARCHIVE_DELETE_AFTER_DAYS, COLOR_MODE_NAMES, DEFAULT_APP_SETTINGS, IDENTITY_NAMES, TERMINAL_FONT_SIZE_RANGE } from '@ai-terminal/protocol'
import { Icon } from './icons'
import { COLOR_MODE_PRESENTATION, IDENTITY_PRESENTATION } from './theme'
import { VoicePreferences } from './voice-preferences'
import { Dialog } from './dialog'
import { failureDetail } from './bridge-error'
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
  'aiterm progress running "Story 2.2" --source epic-auto',
  'aiterm ask pick-db "Which database?" --body "…"',
  'aiterm publish ./report.png',
  'aiterm send --submit -- "continue"'
]

const TEST_MESSAGE_DISABLED_TITLE = 'Send a test message once Telegram is connected and polling'

export function PreferencesDialog(props: {
  settings: AppSettings
  onSettings(next: AppSettings): void
  onClose(): void
}): React.JSX.Element {
  const onSettings = useRef(props.onSettings)
  onSettings.current = props.onSettings

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

  // --- Archive ---------------------------------------------------------------
  const [archiveDeleteAfter, setArchiveDeleteAfter] = useState<ArchiveDeleteAfterDays>(props.settings.archive.deleteAfterDays)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  async function saveArchive(next: ArchiveDeleteAfterDays): Promise<void> {
    const previous = archiveDeleteAfter
    setArchiveDeleteAfter(next)
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      const result = await window.aiTerminal.putSettings('archive', { deleteAfterDays: next })
      setArchiveDeleteAfter(result.archive.deleteAfterDays)
      onSettings.current(result)
    } catch (error) {
      setArchiveDeleteAfter(previous)
      setArchiveError(failureDetail(error, 'Could not save archive settings'))
    } finally {
      setArchiveBusy(false)
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

  // --- Telegram: form (chat/user id, notifyOn, autoSubmitReplies, enabled) ---
  const [chatIdInput, setChatIdInput] = useState(idText(props.settings.telegram.allowedChatId))
  const [userIdInput, setUserIdInput] = useState(idText(props.settings.telegram.allowedUserId))
  const [notifyOn, setNotifyOn] = useState(props.settings.telegram.notifyOn)
  const [autoSubmitReplies, setAutoSubmitReplies] = useState(props.settings.telegram.autoSubmitReplies)
  const [telegramEnabled, setTelegramEnabled] = useState(props.settings.telegram.enabled)
  const [telegramFormBusy, setTelegramFormBusy] = useState(false)
  const [telegramFormError, setTelegramFormError] = useState<string | null>(null)
  const [telegramFormSuccess, setTelegramFormSuccess] = useState<string | null>(null)

  async function saveTelegramForm(): Promise<void> {
    const fields: TelegramFormFields = {
      enabled: telegramEnabled,
      allowedChatId: chatIdInput,
      allowedUserId: userIdInput,
      notifyOn,
      autoSubmitReplies
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
      setTelegramEnabled(result.telegram.enabled)
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
      <section className="preferences-section">
        <h3>Appearance</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Identity</span>
            <p className="preferences-help">The emblem and motto in the header.</p>
          </div>
          <div className="preferences-row-control" role="radiogroup" aria-label="Identity">
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
            <p className="preferences-help">Colors of the app and the terminal.</p>
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
            <p className="preferences-help">
              {TERMINAL_FONT_SIZE_RANGE.min}–{TERMINAL_FONT_SIZE_RANGE.max}px
            </p>
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

      <section className="preferences-section">
        <h3>Notifications</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-desktop-notifications">Desktop notifications when a session needs you</label>
            <p className="preferences-help">Shown only while no BMN window is focused.</p>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-desktop-notifications"
              type="checkbox"
              checked={notifications.desktop}
              disabled={notificationsBusy}
              onChange={(event) => void saveNotifications({ desktop: event.target.checked })}
            />
          </div>
        </div>
        {notificationsError && (
          <p className="preferences-error" role="alert">
            {notificationsError}
          </p>
        )}
      </section>

      <VoicePreferences settings={props.settings.voice} onSettings={(next) => onSettings.current(next)} />

      <section className="preferences-section">
        <h3>Telegram</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <span>Status</span>
          </div>
          <div className="preferences-row-control">
            {telegramStatus ? (
              <div className="preferences-status">
                <p>
                  <strong>{telegramStatus.state}</strong> · {telegramStatus.detail}
                </p>
                <p className="preferences-help">Token: {telegramStatus.tokenMask ?? 'not set'}</p>
                <p className="preferences-help">Last poll: {telegramStatus.lastPollAt ?? 'never'}</p>
                <p className="preferences-help">Last error: {telegramStatus.lastError ?? 'none'}</p>
                <p className="preferences-help">Rejected updates: {telegramStatus.rejectedUpdates}</p>
              </div>
            ) : (
              !telegramStatusBusy && <p className="preferences-help">Status unavailable.</p>
            )}
            <button type="button" disabled={telegramStatusBusy} onClick={() => void refreshTelegramStatus()}>
              {telegramStatusBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
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

        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-telegram-auto-submit">Type replies into the session and press Enter</label>
            <p className="preferences-help">Off: replies are kept as drafts in the Files panel.</p>
          </div>
          <div className="preferences-row-control">
            <input
              id="preferences-telegram-auto-submit"
              type="checkbox"
              checked={autoSubmitReplies}
              disabled={telegramFormBusy}
              onChange={(event) => setAutoSubmitReplies(event.target.checked)}
            />
          </div>
        </div>

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

        <div className="preferences-row">
          <div className="preferences-row-label" />
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" disabled={telegramFormBusy} onClick={() => void saveTelegramForm()}>
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
        <p className="preferences-help">
          Only the allowed chat can reply. Replies must answer a notification; they never go to the focused session.
        </p>
      </section>

      <section className="preferences-section">
        <h3>Archive</h3>
        <div className="preferences-row">
          <div className="preferences-row-label">
            <label htmlFor="preferences-archive-delete-after">Delete archived sessions and workspaces</label>
            <p className="preferences-help">
              Checked when BMN starts. Items archived longer than this are deleted for good, with their saved
              output, requests and Telegram history. Published files are kept.
            </p>
          </div>
          <div className="preferences-row-control">
            <select
              id="preferences-archive-delete-after"
              value={archiveDeleteAfter === null ? 'never' : String(archiveDeleteAfter)}
              disabled={archiveBusy}
              onChange={(event) => void saveArchive(
                ARCHIVE_DELETE_AFTER_DAYS.find((days) => String(days ?? 'never') === event.target.value) ?? null
              )}
            >
              {ARCHIVE_DELETE_AFTER_DAYS.map((days) => (
                <option key={days ?? 'never'} value={days ?? 'never'}>
                  {days === null ? 'Never' : `After ${days} days`}
                </option>
              ))}
            </select>
          </div>
        </div>
        {archiveError && (
          <p className="preferences-error" role="alert">
            {archiveError}
          </p>
        )}
      </section>

      <section className="preferences-section">
        <h3>Local agent control</h3>
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
                <code className="preferences-mono">{controlInfo.socketPath}</code>
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
                <code className="preferences-mono">{controlInfo.cliPath}</code>
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
        <pre className="preferences-usage">{USAGE_LINES.join('\n')}</pre>
        <p className="preferences-help">Sessions started by BMN get AITERM_CONTROL_SOCKET and AITERM_TOKEN automatically.</p>
      </section>

      <section className="preferences-section">
        <h3>Backup</h3>
        <div className="preferences-row">
          <div className="preferences-row-label" />
          <div className="preferences-row-control">
            <div className="preferences-button-row">
              <button type="button" disabled={exportBusy} onClick={() => void runExportBackup()}>
                {exportBusy ? 'Exporting…' : 'Export backup…'}
              </button>
              <button type="button" disabled={verifyBusy} onClick={() => void runVerifyBackup()}>
                {verifyBusy ? 'Verifying…' : 'Verify a backup…'}
              </button>
            </div>
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
    </Dialog>
  )
}
