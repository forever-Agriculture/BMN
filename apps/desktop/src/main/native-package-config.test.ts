import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function nativeFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await nativeFiles(root, path)))
    else if (entry.isFile() && entry.name.endsWith('.node')) {
      files.push(`/${relative(root, path)}`)
    }
  }
  return files.sort()
}

const archivePath = resolve('apps/desktop/release/linux-unpacked/resources/app.asar')

// Inspects the output of `pnpm run package`; a fresh checkout has no packaged build to inspect.
describe.skipIf(!existsSync(archivePath))('Linux x64 native package selection (after pnpm run package)', () => {
  it('contains exactly the three host-loaded Linux x64 native binaries in the built artifact', async () => {
    const appRequire = createRequire(resolve('apps/desktop/package.json'))
    const builderRequire = createRequire(appRequire.resolve('electron-builder'))
    const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
    const { listPackage } = appBuilderRequire('@electron/asar') as {
      listPackage(path: string, options: { isPack: boolean }): string[]
    }
    const nativeEntries = listPackage(archivePath, { isPack: false })
      .filter((entry) => entry.endsWith('.node'))
      .sort()

    expect(nativeEntries).toEqual([
      '/node_modules/better-sqlite3/prebuilds/linux-x64.node',
      expect.stringMatching(/^\/node_modules\/node-pty\/bin\/linux-x64-\d+\/node-pty\.node$/u),
      '/node_modules/node-pty/build/Release/pty.node'
    ])
    for (const entry of nativeEntries) {
      expect((await stat(resolve(`${archivePath}.unpacked`, entry.slice(1)))).isFile()).toBe(true)
    }
    await expect(nativeFiles(`${archivePath}.unpacked`)).resolves.toEqual(nativeEntries)
  })
})
