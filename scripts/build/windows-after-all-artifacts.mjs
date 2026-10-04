import { join } from 'node:path'
import { buildWindowsOfflineInstaller } from './windows-offline-installer.mjs'

export default async function afterAllArtifactBuild(context) {
  if (process.platform !== 'win32') return []
  const targets = [...context.platformToTargets.keys()]
  if (!targets.some(platform => platform.nodeName === 'win32')) return []
  await buildWindowsOfflineInstaller({ root: join(context.outDir, 'win-unpacked') })
  // Installer publication remains a separate owner decision. This hook creates
  // a local artifact and never adds it to electron-builder's upload list.
  return []
}
