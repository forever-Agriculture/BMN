// MODULE: packaged-app.mjs - where `pnpm run package` leaves the unpacked build for a platform
import { join } from 'node:path'

const PRODUCT_NAME = 'BMN'
/** electron-builder names the Linux executable from `linux.executableName`; macOS uses the product name. */
const LINUX_EXECUTABLE = 'bmn'

/** electron-builder appends the architecture to the folder unless the target is the default x64. */
function unpackedDirectory(platform, arch) {
  if (platform === 'darwin') return arch === 'x64' ? 'mac' : `mac-${arch}`
  if (platform === 'linux') return arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
  throw new Error(`BMN has no packaged build for ${platform}`)
}

/**
 * What `pnpm run package` produced: the folder it wrote, the thing the desktop launches, the binary
 * to start, and the resources beside it. macOS wraps the last three in an application bundle.
 */
export function packagedApp(repoRoot, platform = process.platform, arch = process.arch) {
  const root = join(repoRoot, 'apps/desktop/release', unpackedDirectory(platform, arch))
  if (platform === 'darwin') {
    const application = join(root, `${PRODUCT_NAME}.app`)
    const resources = join(application, 'Contents', 'Resources')
    return {
      root,
      application,
      binary: join(application, 'Contents', 'MacOS', PRODUCT_NAME),
      resources,
      archive: join(resources, 'app.asar')
    }
  }
  const resources = join(root, 'resources')
  return {
    root,
    application: root,
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
  const prebuild = platform === 'darwin' ? `darwin-${arch}` : `${platform}-${arch}`
  return [
    `/node_modules/better-sqlite3/prebuilds/${prebuild}.node`,
    new RegExp(`^/node_modules/node-pty/bin/${prebuild}-\\d+/node-pty\\.node$`, 'u'),
    '/node_modules/node-pty/build/Release/pty.node'
  ]
}
