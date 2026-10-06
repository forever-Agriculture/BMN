import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import { readWindowsInstallation, releaseDirectory } from '../../../../scripts/lib/windows-release-transaction.mjs'

interface InstallLease { close(): void }
interface NativeInstallLease {
  bmnInstallLeaseVersion?: number
  acquireInstallLease?: (path: string, exclusive: boolean) => InstallLease
}
const loadInstallNative = (): NativeInstallLease => createRequire(__filename)('node-pty/lib/utils').loadNativeModule('conpty').module

/** All Windows copies sharing data participate, including an unpacked build. */
export function retainWindowsDataLease(dataRoot: string, {
  platform = process.platform, loadNative = loadInstallNative
}: { platform?: NodeJS.Platform; loadNative?: () => NativeInstallLease } = {}): InstallLease | null {
  if (platform !== 'win32') return null
  const native = loadNative()
  if (native.bmnInstallLeaseVersion !== 1 || !native.acquireInstallLease) {
    throw new Error('BMN data update protection is unavailable')
  }
  return native.acquireInstallLease(win32.join(dataRoot, 'update.lock'), false)
}

/** A versioned installation has no direct old-version launch against current data. */
export function retainWindowsInstalledRelease(
  executable: string,
  {
    platform = process.platform,
    loadNative = loadInstallNative,
    readInstallation = readWindowsInstallation,
    canonicalExecutable = realpathSync.native
  }: {
    platform?: NodeJS.Platform
    loadNative?: () => NativeInstallLease
    readInstallation?: typeof readWindowsInstallation
    canonicalExecutable?: (path: string) => string
  } = {}
): InstallLease | null {
  if (platform !== 'win32') return null
  executable = canonicalExecutable(executable)
  if (win32.basename(executable).toLowerCase() === 'bmn-worker.exe') {
    throw new Error('Open BMN from its installed shortcut; this executable cannot open application data.')
  }
  const version = win32.dirname(executable), versions = win32.dirname(version)
  if (win32.basename(version).toLowerCase() === 'bootstrap') {
    throw new Error('The offline installation runtime cannot open application data. Open BMN from its installed shortcut.')
  }
  if (win32.basename(versions).toLowerCase() !== 'versions') return null
  const root = win32.dirname(versions)
  const native = loadNative()
  if (native.bmnInstallLeaseVersion !== 1 || !native.acquireInstallLease) {
    throw new Error('BMN installation startup protection is unavailable')
  }
  // Retain before reading selection, through the host's whole lifetime. The
  // installer holds an exclusive lease while validating and activating updates.
  const lease = native.acquireInstallLease(win32.join(root, 'run.lock'), false)
  try {
    const installation = readInstallation(root)
    if (!installation || win32.normalize(releaseDirectory(root, installation.current)).toLowerCase() !== win32.normalize(version).toLowerCase()) {
      throw new Error('This BMN version is not selected. Open BMN from its installed shortcut; recovery must preserve compatible data.')
    }
    return lease
  } catch (error) { lease.close(); throw error }
}
