interface RootScopedApplication {
  setPath(name: string, path: string): void
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean
  on(event: 'second-instance', listener: () => void): unknown
  quit(): void
}

interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function acquireRootScopedSingleInstance(
  application: RootScopedApplication,
  dataRoot: string,
  onSecondInstance: () => void
): boolean {
  application.setPath('userData', dataRoot)
  const acquired = application.requestSingleInstanceLock({ dataRoot })
  if (!acquired) {
    application.quit()
    return false
  }
  application.on('second-instance', onSecondInstance)
  return true
}

export function focusExistingWindow(window: FocusableWindow | undefined): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
