interface RootScopedApplication {
  setPath(name: string, path: string): void
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean
  on(event: 'second-instance', listener: (event: unknown, argv: unknown) => void): unknown
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
  onSecondInstance: (argv: string[]) => void
): boolean {
  application.setPath('userData', dataRoot)
  const acquired = application.requestSingleInstanceLock({ dataRoot })
  if (!acquired) {
    application.quit()
    return false
  }
  application.on('second-instance', (_event: unknown, argv: unknown) => onSecondInstance(Array.isArray(argv) ? argv.filter((value): value is string => typeof value === 'string') : []))
  return true
}

export function focusExistingWindow(window: FocusableWindow | undefined): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
