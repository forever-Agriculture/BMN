// MODULE: packaging-file-selection.test.mjs - staged builds never include older releases or source files, and carry the whole bmn CLI
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
  expect(loaded).toEqual(expect.arrayContaining(['agents-check.mjs', 'agents-guard.mjs', 'agents-context.mjs', 'agents-skills.mjs', 'agents-tools.mjs', 'agents-fence.mjs', 'agents-research.mjs', 'opencode-project-reader.mjs', 'opencode-project-git.mjs', 'opencode-reader-child.mjs', 'opencode-reader-plugin.mjs', 'opencode-child-accounting.mjs']))
  expect(loaded.filter(name => !packaged.has(name))).toEqual([])
})

it('loads every CLI module without starting a child program, as the packaged smoke does', () => {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/bin')
  const home = mkdtempSync(join(tmpdir(), 'bmn-cli-import-'))
  try {
    const modules = cliModules(bin).map(name => join(bin, name))
    // With node -e, argv[1..] holds module paths. A child program that runs on import mistakes
    // argv[3] (agents-check-base.mjs) for its temporary folder and fails with EEXIST.
    const result = spawnSync(process.execPath, [
      '-e', 'Promise.all(process.argv.slice(1).map(file => import(file))).then(() => console.log("loaded")).catch(error => { console.error(error.stack); process.exitCode = 1 })',
      ...modules
    ], { encoding: 'utf8', timeout: 10_000, env: {
      ...process.env, HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache')
    } })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('loaded')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
