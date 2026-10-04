import { fileURLToPath } from 'node:url'
import { installWindowsPayload, launchWindowsInstalled, uninstallWindowsPayload, observeWindowsSelectedApps, startWindowsInstallNotice, showWindowsInstallNotice } from '../lib/windows-installed-worker.mjs'
import { readInstallerDescriptor } from '../lib/windows-release-payload.mjs'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'
import { join } from 'node:path'
import { windowsInstallFailureMessage, writeWindowsInstallResult } from '../lib/windows-install-result.mjs'
import { readWindowsSourceUpdate } from '../lib/windows-source-update.mjs'
import { windowsQueuedStartMode } from '../lib/windows-update-launch.mjs'
import { resumeWindowsSourceUpdate } from '../lib/windows-source-resume.mjs'
import { assertWindowsWorkerImage, delegateWindowsInstalledEngine } from '../lib/windows-installed-engine.mjs'

// Bundling replaces this anchor with __filename; the installed entry has no
// dependency on a source checkout and uses only its included Electron runtime.
const entry = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
const arguments_ = process.argv.slice(2)
async function main() {
  assertWindowsWorkerImage()
  if (arguments_[0] === '--install') {
    if (![4, 5].includes(arguments_.length)) throw new Error('Installer requires source, installation and data locations')
    const [, source, root, dataRoot] = arguments_
    await installWindowsPayload({ source, root, dataRoot, descriptor: readInstallerDescriptor(source) })
    console.log(JSON.stringify({ windowsInstall: 'complete' }))
    return 0
  }
  const engine = await delegateWindowsInstalledEngine(entry, arguments_)
  if (engine.delegated) return engine.exitCode
  const { root, payload: engineRoot } = engine
  if (arguments_[0] === '--uninstall') {
    const local = windowsEnvironmentValue(process.env, 'LOCALAPPDATA')
    if (!local || arguments_.length > 2 || (arguments_.length === 2 && arguments_[1] !== '--remove-data')) throw new Error('Invalid uninstall request')
    // The registered path offers an explicit retain/delete choice itself.
    await uninstallWindowsPayload({ root, dataRoot: join(local, 'BMN/data'), engineRoot, removeData: arguments_[1] === '--remove-data' })
    return 0
  }
  const local = windowsEnvironmentValue(process.env, 'LOCALAPPDATA')
  if (!local) throw new Error('Windows user data location is unavailable')
  const queued = readWindowsSourceUpdate(join(root, 'requests/source-update.json'))
  if (queued && ['queued', 'waiting'].includes(queued.phase) && windowsQueuedStartMode(queued, observeWindowsSelectedApps(root)) === 'forward') {
    return launchWindowsInstalled(root, arguments_, { engineRoot })
  }
  let progress
  if (queued && !['complete', 'failed'].includes(queued.phase)) {
    progress = startWindowsInstallNotice('BMN is updating and will open when the update finishes. Close any running BMN to let it finish. This notice closes when the work finishes; dismissing it keeps the update running.')
  }
  try {
    await resumeWindowsSourceUpdate(root, { dataRoot: join(local, 'BMN/data'), engineRoot, installPayload: installWindowsPayload,
      waitForExit: async () => (await import('../lib/windows-installed-worker.mjs')).waitForWindowsAppsToExit(),
      notify: async request => { progress?.close(); return showWindowsInstallNotice(request.phase === 'complete'
        ? `BMN ${request.commit.slice(0, 12)} is installed. Open BMN to use it.`
        : windowsInstallFailureMessage(root)) } })
  } finally { progress?.close() }
  return launchWindowsInstalled(root, arguments_, { engineRoot })
}
main().then(code => { process.exitCode = code ?? 0 }).catch(() => {
  // Detailed paths and inherited environment never appear in a public dialog.
  if (arguments_[0] === '--install' && arguments_[2]) {
    const message = windowsInstallFailureMessage(arguments_[2])
    console.error(message)
    // A unique NSIS attempt writes outside the sealed payload. Older attempt
    // receipts cannot misreport the current selected release after extraction fails.
    if (arguments_[4]) {
      try { writeWindowsInstallResult(arguments_[4], message) } catch { /* Unsafe paths are never adopted to write a diagnostic. */ }
    }
  }
  console.error('BMN installation is incomplete. A candidate may already be selected; close BMN and rerun the installer to repair it.')
  process.exitCode = 1
})
