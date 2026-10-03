import { createRequire } from 'node:module'

interface ApplicationLifetimeNative {
  protectApplicationLifetime?: () => void
}

/** Establish the Windows crash backstop before Electron starts any BMN child. */
export function protectWindowsApplicationLifetime(
  platform: NodeJS.Platform = process.platform,
  loadNative: () => ApplicationLifetimeNative = () => createRequire(__filename)('node-pty')
): void {
  if (platform !== 'win32') return
  const native = loadNative()
  if (typeof native.protectApplicationLifetime !== 'function') {
    throw new Error('BMN application lifetime protection is unavailable')
  }
  // The native handle belongs to the process, with no JS disposer or cleanup hook.
  // Closing it while main is alive would also terminate main.
  native.protectApplicationLifetime()
}
