// MODULE: packaging-file-selection.test.mjs - staged builds never include older releases or source files, and carry the whole bmn CLI
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { cliModules } from '../lib/cli-modules.mjs'

it('packages compiled files without recursively including live, previous or staged releases', () => {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop')
  const appRequire = createRequire(join(appDir, 'package.json'))
  const builderRequire = createRequire(appRequire.resolve('electron-builder'))
  const require = createRequire(builderRequire.resolve('app-builder-lib'))
  const { doMergeConfigs } = require('./util/config/config')
  const { getMainFileMatchers } = require('./fileMatcher')
  const config = doMergeConfigs([require('js-yaml').load(readFileSync(join(appDir, 'electron-builder.yml'), 'utf8'))])
  const outDir = join(appDir, 'release/linux-unpacked.staging')
  const info = { projectDir: appDir, buildResourcesDir: join(appDir, 'build'), config, isPrepackedAppAsar: false, debugLogger: { isEnabled: false } }
  const matchers = getMainFileMatchers(appDir, outDir, value => value.replaceAll('${arch}', 'x64'), config.linux, { info }, outDir, false)
  const includes = file => matchers.some(matcher => matcher.createFilter()(join(appDir, file), { isDirectory: () => false }))

  expect(includes('out/main/index.js')).toBe(true)
  expect(includes('out/preload/index.js')).toBe(true)
  expect(includes('out/renderer/index.html')).toBe(true)
  expect(includes('package.json')).toBe(true)
  for (const file of [
    'release/linux-unpacked/resources/app.asar',
    'release/linux-unpacked.prev/resources/app.asar',
    'release/linux-unpacked.next/resources/app.asar',
    'release/linux-unpacked.staging/linux-unpacked/resources/app.asar',
    'src/main/index.ts'
  ]) expect(includes(file), file).toBe(false)
})

it('packages every file the bmn CLI loads beside bmn.mjs', () => {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop')
  const { load } = createRequire(createRequire(createRequire(join(appDir, 'package.json')).resolve('electron-builder')).resolve('app-builder-lib'))('js-yaml')
  const packaged = new Set(load(readFileSync(join(appDir, 'electron-builder.yml'), 'utf8')).extraResources
    .filter(entry => entry.to === entry.from && entry.from.startsWith('bin/'))
    .map(entry => entry.from.slice('bin/'.length)))
  const loaded = cliModules(join(appDir, 'bin'))

  // The guard, the dispatch check and one command each for context, skills and tools sit behind these.
  expect(loaded).toEqual(expect.arrayContaining(['agents-check.mjs', 'agents-guard.mjs', 'agents-context.mjs', 'agents-skills.mjs', 'agents-tools.mjs', 'agents-fence.mjs', 'agents-research.mjs']))
  expect(loaded.filter(name => !packaged.has(name))).toEqual([])
})
