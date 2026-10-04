import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildFrozenWindowsSource, readWindowsSourceState } from '../lib/windows-source-build.mjs'

const commit = 'a'.repeat(40), repo = join(process.cwd(), 'synthetic-source')
function fixture() {
  const calls = [], identity = { repo, commit, node: process.execPath, pnpm: join(repo, 'pnpm.cjs') }
  let changed = false
  const execute = vi.fn((command, args, cwd) => {
    calls.push({ command, args, cwd })
    if (args[0] === 'branch') return 'main'
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'status') return changed && cwd === repo ? ' M changed' : ''
    return ''
  })
  const capabilities = { execute, makeWorkspace: () => join(repo, 'synthetic-scratch'),
    readDescriptor: () => ({ commit, payloadSha256: 'b'.repeat(64), schemaVersion: 23 }), validatePayload: vi.fn(async () => {}) }
  return { calls, identity, capabilities, drift: () => { changed = true } }
}
it('builds the queued immutable commit separately through the explicitly recorded Node and pnpm', async () => {
  const f = fixture(), result = await buildFrozenWindowsSource(f.identity, f.capabilities)
  const commands = f.calls.filter(call => call.command === process.execPath)
  expect(commands.map(call => call.args)).toEqual([[f.identity.pnpm, 'install', '--frozen-lockfile'], [f.identity.pnpm, 'run', 'package']])
  for (const call of commands) expect(call.cwd).toBe(join(repo, 'synthetic-scratch/checkout'))
  expect(result.commit).toBe(commit); expect(result.root).toBe(join(repo, 'synthetic-scratch/checkout/apps/desktop/release/win-unpacked'))
  expect(f.capabilities.validatePayload).toHaveBeenCalledOnce()
})
it('rejects contributor source drift after packaging and never returns a candidate', async () => {
  const f = fixture(), original = f.capabilities.execute
  f.capabilities.execute = (...args) => { const result = original(...args); if (args[1][1] === 'run') f.drift(); return result }
  await expect(buildFrozenWindowsSource(f.identity, f.capabilities)).rejects.toThrow('not clean')
  expect(f.capabilities.validatePayload).not.toHaveBeenCalled()
})
it('does not reinterpret the contributor checkout as a frozen main branch', () => {
  const f = fixture()
  expect(readWindowsSourceState(repo, f.capabilities.execute)).toEqual({ branch: 'main', head: commit, originHead: commit, status: '' })
})
