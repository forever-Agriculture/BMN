// MODULE: staged-build.mjs - an update packages and smoke-tests beside the live build while BMN is open; only a passed build is swapped in
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The folders an update uses, siblings of the live one so every move is a rename on one file system:
 * the live build; `staging`, where electron-builder packages; `next`, where the packaged build is smoke-tested (the
 * AppArmor profile `scripts/sandbox/bmn-electron` lets Chromium sandbox itself only there); `ready`, the build that
 * passed and waits for BMN to exit (Story 134.2), so a newer commit can be tested in `next` meanwhile; and `prev`,
 * the build the last swap replaced.
 */
export function buildFolders(live) {
  return { live, next: `${live}.next`, ready: `${live}.ready`, prev: `${live}.prev`, staging: `${live}.staging` }
}

const defaultFs = { existsSync, renameSync, rmSync }

/**
 * What the live path holds: `whole` when a build is there; `half-swapped` when it is missing while the
 * update's other folders exist (the worker stopped between the two renames); `missing` otherwise.
 */
export function liveBuildState(folders, fs = defaultFs) {
  if (fs.existsSync(folders.live)) return 'whole'
  return [folders.prev, folders.ready, folders.next].some((path) => fs.existsSync(path)) ? 'half-swapped' : 'missing'
}

/**
 * Starts an update with at most the live build on disk: a build an earlier stop left half swapped is put
 * back first, then the previous generation and anything an earlier worker staged are removed.
 */
export function prepareBuildFolders(folders, fs = defaultFs) {
  const restored = liveBuildState(folders, fs) === 'half-swapped' && fs.existsSync(folders.prev)
  if (restored) fs.renameSync(folders.prev, folders.live)
  for (const path of [folders.prev, folders.next, folders.ready, `${folders.ready}.old`, folders.staging]) fs.rmSync(path, { recursive: true, force: true })
  return { restored }
}

/**
 * Packages into `staging`, moves the unpacked build to `next` and smoke-tests it there; never touches the live build,
 * so it runs while BMN is open (Story 134.2). `step(label, args)` runs one pnpm step and rejects on failure. A failed
 * smoke leaves `next` for inspection until the next attempt.
 */
export async function packageAndSmoke({ folders, step, log, fs = defaultFs }) {
  for (const path of [folders.next, folders.staging]) fs.rmSync(path, { recursive: true, force: true })
  await step('package', ['run', 'package', `--config.directories.output=${folders.staging}`])
  const built = join(folders.staging, basename(folders.live))
  if (!fs.existsSync(built)) throw new Error(`package left no build at ${built}`)
  fs.renameSync(built, folders.next)
  fs.rmSync(folders.staging, { recursive: true, force: true })
  log(`STAGED ${folders.next}`)
  await step('packaged smoke test', ['run', 'smoke:packaged', '--root', folders.next])
}

/**
 * The smoked `next` build becomes the one that waits for BMN to exit, replacing an older passed one. The older one is
 * moved aside first and removed only once the new one is in place; a failed rename puts it back, so a passed build
 * that still waits is never lost.
 */
export function keepPassedBuild(folders, fs = defaultFs) {
  const older = `${folders.ready}.old`
  fs.rmSync(older, { recursive: true, force: true })
  const hadOlder = fs.existsSync(folders.ready)
  if (hadOlder) fs.renameSync(folders.ready, older)
  try {
    fs.renameSync(folders.next, folders.ready)
  } catch (error) {
    if (hadOlder) fs.renameSync(older, folders.ready)
    throw error
  }
  fs.rmSync(older, { recursive: true, force: true })
}

/**
 * Puts the passed `ready` build in place: live → prev, then ready → live. If the second rename fails the
 * first is undone. The result says which build the live path holds: `new`, `previous` (rolled back) or
 * `none` (the rollback failed too; `prev` still holds the old build).
 */
export function swapInReadyBuild(folders, fs = defaultFs) {
  fs.rmSync(folders.prev, { recursive: true, force: true })
  const hadLive = fs.existsSync(folders.live)
  if (hadLive) fs.renameSync(folders.live, folders.prev)
  try {
    fs.renameSync(folders.ready, folders.live)
    return { liveBuild: 'new' }
  } catch (error) {
    if (!hadLive) return { liveBuild: 'none', error }
    try {
      fs.renameSync(folders.prev, folders.live)
      return { liveBuild: 'previous', error }
    } catch {
      return { liveBuild: 'none', error }
    }
  }
}

/**
 * Puts the previous build back after a swap whose install failed: live → ready, then prev → live; if the second rename
 * fails the first is undone. The result says which build the live path holds, as `swapInReadyBuild` does.
 */
export function undoSwap(folders, fs = defaultFs) {
  if (!fs.existsSync(folders.prev)) return { liveBuild: 'new', error: new Error(`no previous build in ${folders.prev}`) }
  fs.rmSync(folders.ready, { recursive: true, force: true })
  fs.renameSync(folders.live, folders.ready)
  try {
    fs.renameSync(folders.prev, folders.live)
    return { liveBuild: 'previous' }
  } catch (error) {
    try {
      fs.renameSync(folders.ready, folders.live)
      return { liveBuild: 'new', error }
    } catch {
      return { liveBuild: 'none', error }
    }
  }
}
