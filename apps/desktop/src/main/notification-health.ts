// MODULE: notification-health.ts - whether BMN's last desktop notification reached the system, said honestly (Story 53.9 AC1)

export interface NotificationHealth {
  /** `unknown` until a notification is raised; then the outcome of the latest one. */
  readonly state: 'unknown' | 'shown' | 'failed' | 'unsupported'
  /** The system's own reason for a failure, bounded; never shown as the owner's instructions. */
  readonly reason: string | null
}

/** The Electron Notification events this reads: `show` once displayed; `failed` (Windows) with the system's error. */
export interface WatchedNotification {
  on(event: 'show', listener: () => void): unknown
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown
}

export function createNotificationHealth(): {
  current(): NotificationHealth
  /** The system cannot show notifications at all. */
  unsupported(): void
  /** Follows one notification before it is shown; the latest notification's outcome replaces the earlier one's. */
  watch(notification: WatchedNotification): void
} {
  let health: NotificationHealth = { state: 'unknown', reason: null }
  let latest = 0
  return {
    current: () => health,
    unsupported: () => {
      latest += 1
      health = { state: 'unsupported', reason: null }
    },
    watch: (notification) => {
      const id = ++latest
      notification.on('show', () => {
        if (id === latest) health = { state: 'shown', reason: null }
      })
      notification.on('failed', (_event, error) => {
        if (id === latest) health = { state: 'failed', reason: String(error).slice(0, 200) }
      })
    }
  }
}

/**
 * What Preferences says under Desktop notifications, or null while notifications work or none was raised yet. A
 * request a notification could not announce stays open in BMN (and on the phone when Telegram is on); this only tells
 * the owner that the desktop bubble did not appear and where to turn it back on.
 */
export function notificationHealthCue(health: NotificationHealth, platform: NodeJS.Platform): string | null {
  if (health.state === 'unsupported') {
    return 'This system cannot show desktop notifications. Requests still appear in BMN, and on your phone when Telegram is on.'
  }
  if (health.state !== 'failed') return null
  return platform === 'win32'
    ? 'Windows did not show BMN\'s last notification. Turn on notifications for BMN in Settings › System › Notifications.'
    : 'The system did not show BMN\'s last notification. Check that notifications are allowed for BMN.'
}
