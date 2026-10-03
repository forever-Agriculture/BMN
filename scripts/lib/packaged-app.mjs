// MODULE: packaged-app.mjs - where `pnpm run package` leaves the unpacked build for a platform
import { join } from 'node:path'

/** electron-builder names the Linux executable from `linux.executableName`. */
const EXECUTABLES = { linux: 'bmn', win32: 'BMN.exe' }

/** electron-builder appends the architecture to the folder unless the target is the default x64. */
function unpackedDirectory(platform, arch) {
  if (platform === 'linux') return arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`
  if (platform === 'win32') return arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`
  throw new Error(`BMN has no packaged build for ${platform}`)
}

/**
 * A packaged build's folder, the binary to start and the resources beside it. With no `root` it is
 * the live build `pnpm run package` writes; an update passes its staging or previous folder.
 */
export function packagedApp(repoRoot, { platform = process.platform, arch = process.arch, root } = {}) {
  const folder = unpackedDirectory(platform, arch)
  root ??= join(repoRoot, 'apps/desktop/release', folder)
  const resources = join(root, 'resources')
  return {
    root,
    binary: join(root, EXECUTABLES[platform]),
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
    ...(platform === 'win32' ? [
      '/node_modules/node-pty/build/Release/conpty.node',
      '/node_modules/node-pty/build/Release/conpty_console_list.node'
    ] : []),
    '/node_modules/node-pty/build/Release/pty.node'
  ]
}

/** Windows node-pty runtime sidecars, restored after its native rebuild. */
export function packagedNativeSidecars(platform = process.platform) {
  return platform === 'win32' ? [
    '/node_modules/node-pty/build/Release/conpty/conpty.dll',
    '/node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
    '/node_modules/node-pty/build/Release/winpty.dll',
    '/node_modules/node-pty/build/Release/winpty-agent.exe'
  ] : []
}
