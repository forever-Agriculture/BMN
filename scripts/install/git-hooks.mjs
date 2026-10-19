// MODULE: git-hooks.mjs - postinstall step: points core.hooksPath at the tracked .githooks only when it is unset
// Story 80.10: the commit-msg hook refuses subjects over 100 characters. Every worktree shares the repository's
// config, so one install covers them all. A hooksPath already set elsewhere is the owner's and is left alone.
// This step never fails an install: every path ends with exit 0.
import { spawnSync } from 'node:child_process'

const HOOKS_PATH = '.githooks'

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return { status: result.status, stdout: (result.stdout ?? '').trim(), error: result.error }
}

function installHooksPath() {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.error) return `git hooks: git is not available (${inside.error.code ?? inside.error.message}); commit-msg hook not installed.`
  if (inside.status !== 0 || inside.stdout !== 'true') return 'git hooks: not a git checkout; commit-msg hook not installed.'

  const current = git(['config', '--get', 'core.hooksPath'])
  if (current.status === 0) {
    if (current.stdout === HOOKS_PATH) return null
    return `git hooks: core.hooksPath is already "${current.stdout}", left as is; the commit-subject hook in ${HOOKS_PATH} is not active (to use it: git config core.hooksPath ${HOOKS_PATH}).`
  }
  if (current.status !== 1) return `git hooks: could not read core.hooksPath (git config exit ${current.status}); left as is.`

  const set = git(['config', 'core.hooksPath', HOOKS_PATH])
  if (set.status !== 0) return `git hooks: could not set core.hooksPath (git config exit ${set.status}); commit-msg hook not installed.`
  return `git hooks: set core.hooksPath to ${HOOKS_PATH}: commit subjects over 100 characters are refused (undo: git config --unset core.hooksPath).`
}

try {
  const line = installHooksPath()
  if (line) console.log(line)
} catch (error) {
  console.log(`git hooks: skipped (${error instanceof Error ? error.message : String(error)}).`)
}
process.exit(0)
