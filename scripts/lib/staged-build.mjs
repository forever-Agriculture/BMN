// MODULE: staged-build.mjs - an update packages beside the live build and swaps it in only after the smoke passes
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The folders an update uses, siblings of the live one so every move is a rename on one file system:
 * the live build, the staged new one, the build it replaced (kept for one update), and the output
 * folder electron-builder packages into before its unpacked build moves to `next`.
 */
export function buildFolders(live) {
  return { live, next: `${live}.next`, prev: `${live}.prev`, staging: `${live}.staging` }
}

const defaultFs = { existsSync, renameSync, rmSync }

/**
 * What the live path holds: `whole` when a build is there; `half-swapped` when it is missing while the
 * update's other folders exist (the worker stopped between the two renames); `missing` otherwise.
 */
export function liveBuildState(folders, fs = defaultFs) {
  if (fs.existsSync(folders.live)) return 'whole'
  return fs.existsSync(folders.prev) || fs.existsSync(folders.next) ? 'half-swapped' : 'missing'
}

/**
 * Starts an update with at most the live build on disk: a build an earlier stop left half swapped is put
 * back first, then the previous generation and any earlier staging are removed.
 */
export function prepareBuildFolders(folders, fs = defaultFs) {
  const restored = liveBuildState(folders, fs) === 'half-swapped' && fs.existsSync(folders.prev)
  if (restored) fs.renameSync(folders.prev, folders.live)
  for (const path of [folders.prev, folders.next, folders.staging]) fs.rmSync(path, { recursive: true, force: true })
  return { restored }
}

/** Moves the unpacked build electron-builder wrote under `staging` to the `next` folder. */
export function stageBuiltFolder(folders, unpackedName, fs = defaultFs) {
  const built = join(folders.staging, unpackedName)
  if (!fs.existsSync(built)) throw new Error(`package left no build at ${built}`)
  fs.renameSync(built, folders.next)
  fs.rmSync(folders.staging, { recursive: true, force: true })
}

/**
 * Puts the smoked `next` build in place: live → prev, then next → live. If the second rename fails the
 * first is undone. The result says which build the live path holds: `new`, `previous` (rolled back) or
 * `none` (the rollback failed too; `prev` still holds the old build).
 */
export function swapInStagedBuild(folders, fs = defaultFs) {
  const hadLive = fs.existsSync(folders.live)
  if (hadLive) fs.renameSync(folders.live, folders.prev)
  try {
    fs.renameSync(folders.next, folders.live)
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
 * The whole staged update: package into staging, move it to `next`, smoke `next`, wait until BMN is
 * closed, swap. `step(label, args)` runs one pnpm step and throws on failure; the live build is touched
 * only by the swap. `onLiveBuild` hears which build the live path holds as soon as that changes.
 */
export async function packageSmokeAndSwap({ folders, step, waitForExit, log, onLiveBuild, fs = defaultFs }) {
  if (prepareBuildFolders(folders, fs).restored) log(`RESTORED ${folders.live} from ${folders.prev}; an earlier update stopped between its renames`)
  step('package', ['run', 'package', `--config.directories.output=${folders.staging}`])
  stageBuiltFolder(folders, basename(folders.live), fs)
  log(`STAGED ${folders.next}`)
  step('packaged smoke test', ['run', 'smoke:packaged', '--root', folders.next])
  // BMN may have been started straight from its binary while the new build was checked.
  await waitForExit()
  const swap = swapInStagedBuild(folders, fs)
  onLiveBuild(swap.liveBuild)
  if (swap.error) throw new Error(`could not put the new build in place: ${swap.error.message}`)
  log(`SWAPPED the new build into ${folders.live}; the one it replaced is ${folders.prev}`)
}
