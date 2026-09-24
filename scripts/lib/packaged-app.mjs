// MODULE: packaged-app.mjs - where `pnpm run package` leaves the unpacked build for a platform
import { join } from 'node:path'

/** electron-builder names the Linux executable from `linux.executableName`. */
const LINUX_EXECUTABLE = 'bmn'

/** electron-builder appends the architecture to the folder unless the target is the default x64. */
function unpackedDirectory(platform, arch) {
  if (platform === 'linux') return arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
  throw new Error(`BMN has no packaged build for ${platform}`)
}

/**
 * What `pnpm run package` produced: the folder it wrote, the binary to start, and the resources
 * beside it.
 */
export function packagedApp(repoRoot, platform = process.platform, arch = process.arch) {
  const root = join(repoRoot, 'apps/desktop/release', unpackedDirectory(platform, arch))
  const resources = join(root, 'resources')
  return {
    root,
    binary: join(root, LINUX_EXECUTABLE),
    resources,
    archive: join(resources, 'app.asar')
  }
}

/**
 * The native binaries the packaged app is allowed to carry: better-sqlite3 loads its prebuild for
 * this platform, and node-pty loads `build/Release/pty.node`, with its own prebuild kept beside it.
 */
export function packagedNativeModules(platform = process.platform, arch = process.arch) {
  const prebuild = `${platform}-${arch}`
  return [
    `/node_modules/better-sqlite3/prebuilds/${prebuild}.node`,
    new RegExp(`^/node_modules/node-pty/bin/${prebuild}-\\d+/node-pty\\.node$`, 'u'),
    '/node_modules/node-pty/build/Release/pty.node'
  ]
}
