// The contributor build reads an immutable Git commit into a separate worktree.
// Existing packaged BMN and the contributor's working files are never built over.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsSourceReadiness } from './windows-source-update.mjs'
import { readInstallerDescriptor, validateWindowsReleasePayload } from './windows-release-payload.mjs'
import { windowsUpdateFailure } from './windows-update-progress.mjs'

export function executeWindowsSourceCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 1800000,
    maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw windowsUpdateFailure('Windows source build command failed; previous installation is retained', 'command', result.status ?? undefined)
  }
  return result.stdout.trim()
}
export function readWindowsSourceState(repo, execute = executeWindowsSourceCommand) {
  const git = args => execute('git', args, repo)
  return { branch: git(['branch', '--show-current']), head: git(['rev-parse', 'HEAD']),
    originHead: git(['rev-parse', 'origin/main']), status: git(['status', '--porcelain']) }
}
export async function buildFrozenWindowsSource(identity, {
  execute = executeWindowsSourceCommand,
  makeWorkspace = () => {
    const scratch = join(tmpdir(), `bmn-windows-source-build-${randomUUID()}`)
    ensurePrivateDirectories([scratch]); return scratch
  }, readDescriptor = readInstallerDescriptor, validatePayload = validateWindowsReleasePayload, onWorkspace = async () => {},
  observe = () => {}
} = {}) {
  const { repo, commit, node, pnpm } = identity
  const verify = () => {
    const readiness = windowsSourceReadiness(readWindowsSourceState(repo, execute), commit)
    if (readiness !== null) throw windowsUpdateFailure(readiness, 'source')
  }
  verify()
  const scratch = makeWorkspace(), frozen = join(scratch, 'checkout')
  await onWorkspace({ scratch, frozen })
  execute('git', ['worktree', 'add', '--detach', frozen, commit], repo)
  assert.equal(execute('git', ['rev-parse', 'HEAD'], frozen), commit, 'Snapshot has the wrong source commit')
  assert.equal(execute('git', ['status', '--porcelain'], frozen), '', 'Snapshot is not clean')
  verify()
  observe('install'); execute(node, [pnpm, 'install', '--frozen-lockfile'], frozen)
  observe('package'); execute(node, [pnpm, 'run', 'package'], frozen)
  assert.equal(execute('git', ['rev-parse', 'HEAD'], frozen), commit, 'Source identity changed during packaging')
  assert.equal(execute('git', ['status', '--porcelain'], frozen), '', 'Packaging changed tracked source')
  verify()
  const root = join(frozen, 'apps/desktop/release/win-unpacked'), descriptor = readDescriptor(root)
  assert.equal(descriptor.commit, commit, 'Packaged candidate has another source identity')
  await validatePayload(root, descriptor)
  return { ...descriptor, root, scratch, frozen, repo }
}

/** Best-effort removal of this worker's known worktree; mapped Windows DLLs may
 * require a later invocation. Failure retains the scratch path for recovery.
 */
export function removeFrozenWindowsSource(candidate, execute = executeWindowsSourceCommand) {
  execute('git', ['worktree', 'remove', '--force', candidate.frozen], candidate.repo)
}
