// MODULE: electron-normal-start.mjs - a start without `--self-test` carries and loads no self-test code (Stories 39.1, 39.2)
// usage: node scripts/test/electron-normal-start.mjs [--binary PACKAGED_BMN]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const binaryFlag = process.argv.indexOf('--binary')
const packagedBinary = binaryFlag === -1 ? undefined : resolve(process.argv[binaryFlag + 1] ?? '')
const executablePath = packagedBinary ?? createRequire(join(appDirectory, 'package.json'))('electron')

/**
 * One string unique to each main-process self-test module. Error messages and fixture words survive minification,
 * and each module gets its own, so a static import of any one of them (not only the runner) is caught.
 */
const MAIN_SELF_TEST_MARKERS = [
  'native failure self-test timed out', // self-test/runner.ts
  'the stopped session tree button was not rendered', // self-test/probes.ts
  'codex harness ready', // self-test/harnesses.ts
  'Stored arguments are unavailable in the renderer boundary probe.', // self-test/taps.ts
  'Conflict: terminated by other getUpdates request', // fake-bot-api.ts
  'ses_f1b971253ffeDV9XIFvU67lmdh', // agent-history-self-test.ts
  'launch set exact command preview missing' // launch-set-repository-self-test.ts
]

/** One message unique to each renderer self-test module; none may sit in the renderer's entry chunk. */
const RENDERER_SELF_TEST_MARKERS = [
  'renderer behavioural integration step timed out',
  'file-reference integration: the probe session record is missing',
  'progress evidence integration: the strip had no state button',
  'voice integration: the Preferences button was not rendered'
]

const runtime = process.env.XDG_RUNTIME_DIR
const display = process.env.WAYLAND_DISPLAY
const waylandDisplay = runtime && display && !isAbsolute(display) ? join(runtime, display) : display

const loaded = await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const application = await electron.launch({
    executablePath,
    args: [...(packagedBinary ? [] : [appDirectory]), '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  try {
    const page = await application.firstWindow()
    // A live session means startup finished: host launched, window loaded, IPC installed.
    await page.waitForSelector('.session-row', { timeout: 30_000 })
    // Enabling the debugger replays every script the renderer has parsed, dynamic chunks included.
    const cdp = await page.context().newCDPSession(page)
    const scripts = []
    cdp.on('Debugger.scriptParsed', (event) => { if (event.url.endsWith('.js')) scripts.push(event.url) })
    await cdp.send('Debugger.enable')
    await cdp.send('Debugger.disable')
    const main = await application.evaluate((_electron, { markers, mainMarkers }) => {
      const main = process.mainModule
      if (!main) throw new Error('the main process has no main module to read the module list from')
      const modules = Object.keys(main.constructor._cache)
      const entry = modules.find((path) => /[\\/]out[\\/]main[\\/]index\.js$/u.test(path))
      if (!entry) throw new Error(`the module list does not hold the main entry: ${JSON.stringify(modules)}`)
      // Electron's fs reads inside app.asar too, so the same check covers a packaged build.
      const fs = main.require('node:fs')
      const path = main.require('node:path')
      const renderer = path.join(path.dirname(entry), '../renderer')
      const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8')
      const rendererEntry = /<script[^>]+src="\.\/assets\/([^"]+\.js)"/u.exec(html)?.[1]
      if (!rendererEntry) throw new Error('the renderer index.html names no entry script')
      const assets = fs.readdirSync(path.join(renderer, 'assets')).filter((name) => name.endsWith('.js'))
      const text = (name) => fs.readFileSync(path.join(renderer, 'assets', name), 'utf8')
      const chunkDirectory = path.join(path.dirname(entry), 'chunks')
      const chunks = fs.readdirSync(chunkDirectory)
      const loadedMain = modules.filter((file) => /[\\/]out[\\/]main[\\/]/u.test(file))
      return {
        modules,
        chunks,
        mainMarkersLoaded: loadedMain.flatMap((file) => mainMarkers.filter((marker) => fs.readFileSync(file, 'utf8').includes(marker))
          .map((marker) => `${path.basename(file)}: ${marker}`)),
        mainMarkerChunks: mainMarkers.map((marker) => chunks.filter((name) =>
          fs.readFileSync(path.join(chunkDirectory, name), 'utf8').includes(marker))),
        rendererEntry,
        markersInEntry: markers.filter((marker) => text(rendererEntry).includes(marker)),
        markerChunks: markers.map((marker) => assets.filter((name) => name !== rendererEntry && text(name).includes(marker)))
      }
    }, { markers: RENDERER_SELF_TEST_MARKERS, mainMarkers: MAIN_SELF_TEST_MARKERS })
    return { ...main, scripts }
  } finally {
    // The close prompt would wait for an answer about the live session; nothing here needs a graceful quit.
    application.process().kill('SIGKILL')
  }
})

// The self-test must stay out of every module a normal start loads: a static import of any of its modules would
// inline it into index.js or a shared chunk and load it every start. Each marker must still be in some chunk.
assert.deepEqual(loaded.mainMarkersLoaded, [], 'a normal start loaded main-process self-test code')
assert.ok(loaded.mainMarkerChunks.every((chunks) => chunks.length > 0),
  `a main-process self-test module is missing from the build's chunks: ${JSON.stringify(loaded.mainMarkerChunks)}`)
assert.equal(loaded.chunks.filter((name) => /^runner-[^/]*\.js$/u.test(name)).length, 1,
  `the build has no single self-test chunk: ${JSON.stringify(loaded.chunks)}`)
const mainModules = loaded.modules.filter((path) => /[\\/]out[\\/]main[\\/]/u.test(path))
const selfTest = mainModules.filter((path) => /[\\/]chunks[\\/]runner-[^\\/]*\.js$/u.test(path))
assert.deepEqual(selfTest, [], 'a normal start loaded the self-test chunk')

// Story 39.2: the renderer's self-test sits in its own chunk, which a normal start never fetches.
assert.deepEqual(loaded.markersInEntry, [], 'the renderer entry chunk holds self-test code')
const selfTestChunks = [...new Set(loaded.markerChunks.flat())]
assert.ok(loaded.markerChunks.every((chunks) => chunks.length > 0),
  `a renderer self-test module is missing from the build: ${JSON.stringify(loaded.markerChunks)}`)
assert.ok(loaded.scripts.some((url) => url.endsWith(`/${loaded.rendererEntry}`)),
  `the renderer's parsed scripts do not include its entry: ${JSON.stringify(loaded.scripts)}`)
const fetched = loaded.scripts.filter((url) => selfTestChunks.some((name) => url.endsWith(`/${name}`)))
assert.deepEqual(fetched, [], 'a normal start loaded the renderer self-test chunk')
console.log(JSON.stringify({
  normalStart: 'passed', binary: packagedBinary ?? 'development', mainModules,
  rendererEntry: loaded.rendererEntry, rendererSelfTestChunks: selfTestChunks, rendererScripts: loaded.scripts
}))
