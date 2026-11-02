// MODULE: package-preflight.mjs - Story 102.9: `pnpm run package` in the main checkout refuses while packaged BMN is open, because it would replace the live build
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedApp } from '../lib/packaged-app.mjs'
import { runningAppPids } from './update-desktop.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Why this package run must not start, or null. A linked worktree and the updater (which builds into staging) never touch the live build. */
export function packageRefusal({ linkedWorktree, staged, runningPids }) {
  if (linkedWorktree || staged || runningPids.length === 0) return null
  return `packaged BMN is open (process ${runningPids.join(', ')}), and this would replace the build it runs from. Queue \`pnpm run update:desktop\` instead, or close BMN first.`
}

function isLinkedWorktree() {
  const ask = (flag) => spawnSync('git', ['rev-parse', '--path-format=absolute', flag], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
  return ask('--git-dir') !== ask('--git-common-dir')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refusal = packageRefusal({
    linkedWorktree: isLinkedWorktree(),
    staged: process.env.BMN_PACKAGE_STAGED === '1',
    runningPids: runningAppPids(packagedApp(repoRoot).binary)
  })
  if (refusal !== null) {
    console.error(`pnpm run package refused: ${refusal}`)
    process.exitCode = 1
  }
}
