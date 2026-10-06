import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packagedApp, packagedNativeModules } from '../lib/packaged-app.mjs'

describe('unpacked platform locations', () => {
  it.each([
    ['linux', 'x64', 'linux-unpacked', 'bmn'],
    ['linux', 'arm64', 'linux-arm64-unpacked', 'bmn'],
    ['win32', 'x64', 'win-unpacked', 'BMN.exe'],
    ['win32', 'arm64', 'win-arm64-unpacked', 'BMN.exe']
  ])('%s %s resolves its native executable', (platform, arch, folder, executable) => {
    const app = packagedApp('/repo', { platform, arch })
    expect(app.root).toBe(join('/repo', 'apps/desktop/release', folder))
    expect(app.binary).toBe(join(app.root, executable))
    expect(app.archive).toBe(join(app.root, 'resources', 'app.asar'))
  })
  it('uses the Windows binary for an explicit staged root', () => {
    expect(packagedApp('/repo', { platform: 'win32', root: '/staged' }).binary).toBe(join('/staged', 'BMN.exe'))
  })
  it('refuses an unsupported platform even with an explicit root', () => {
    expect(() => packagedApp('/repo', { platform: 'darwin', root: '/staged' })).toThrow(/no packaged build/)
  })
  it('requires ConPTY and its process-list addon in a Windows package', () => {
    const modules = packagedNativeModules('win32', 'x64')
    expect(modules).toContain('/node_modules/node-pty/build/Release/conpty.node')
    expect(modules).toContain('/node_modules/node-pty/build/Release/conpty_console_list.node')
    expect(modules).toContain('/node_modules/better-sqlite3/prebuilds/win32-x64.node')
  })
})
