// MODULE: packaged-native-modules.test.mjs - the packaged app carries exactly this platform's native binaries
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packagedApp, packagedNativeModules } from '../lib/packaged-app.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { archive } = packagedApp(repoRoot)

async function nativeFiles(root, current = root) {
  const files = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await nativeFiles(root, path)))
    else if (entry.isFile() && entry.name.endsWith('.node')) files.push(`/${relative(root, path)}`)
  }
  return files.sort()
}

// Inspects the output of `pnpm run package`; a fresh checkout has no packaged build to inspect.
describe.skipIf(!existsSync(archive))(
  `${process.platform} ${process.arch} native package selection (after pnpm run package)`,
  () => {
    it('contains exactly the host-loaded native binaries for this platform, all unpacked', async () => {
      const appRequire = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
      const builderRequire = createRequire(appRequire.resolve('electron-builder'))
      const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
      const { listPackage } = appBuilderRequire('@electron/asar')
      const nativeEntries = listPackage(archive, { isPack: false })
        .filter((entry) => entry.endsWith('.node'))
        .sort()

      expect(nativeEntries).toEqual(
        packagedNativeModules().map((expected) =>
          expected instanceof RegExp ? expect.stringMatching(expected) : expected
        )
      )
      for (const entry of nativeEntries) {
        expect((await stat(resolve(`${archive}.unpacked`, entry.slice(1)))).isFile()).toBe(true)
      }
      await expect(nativeFiles(`${archive}.unpacked`)).resolves.toEqual(nativeEntries)
    })
  }
)
