import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRepositoryIdentity } from './repository-identity'

const roots: string[] = []
const now = () => new Date('2026-09-24T10:00:00.000Z')

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bmn-repository-identity-'))
  roots.push(directory)
  return directory
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

function init(directory: string): void {
  git(directory, 'init', '-q', '-b', 'main')
}

function commit(directory: string): void {
  git(directory, '-c', 'user.name=BMN Test', '-c', 'user.email=bmn@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('read-only repository identity', () => {
  it('selects the nearest nested repository and reports the branch and observation time', async () => {
    const root = fixture()
    init(root)
    commit(root)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    init(nested)
    commit(nested)
    const inside = join(nested, 'child')
    mkdirSync(inside)

    expect(await inspectRepositoryIdentity(inside, { now })).toEqual({
      state: 'repository', directory: inside, root: nested, observedAt: now().toISOString(),
      head: { state: 'branch', name: 'main' }, linkedWorktree: false
    })
  })

  it('distinguishes a linked worktree, detached HEAD and an unborn branch', async () => {
    const root = fixture()
    const repository = join(root, 'repository')
    mkdirSync(repository)
    init(repository)
    commit(repository)
    const linked = join(root, 'linked')
    git(repository, 'worktree', 'add', '-qb', 'feature', linked)
    expect(await inspectRepositoryIdentity(linked, { now })).toMatchObject({
      state: 'repository', root: linked, head: { state: 'branch', name: 'feature' },
      linkedWorktree: true
    })
    git(linked, 'checkout', '-q', '--detach')
    expect(await inspectRepositoryIdentity(linked, { now })).toMatchObject({
      state: 'repository', head: { state: 'detached' }, linkedWorktree: true
    })
    const unborn = join(root, 'unborn')
    mkdirSync(unborn)
    init(unborn)
    expect(await inspectRepositoryIdentity(unborn, { now })).toMatchObject({
      state: 'repository', head: { state: 'unborn', name: 'main' }
    })
  })

  it('separates non-repositories from missing directories and missing Git', async () => {
    const root = fixture()
    expect(await inspectRepositoryIdentity(root, { now })).toEqual({
      state: 'not-repository', directory: root, observedAt: now().toISOString()
    })
    expect(await inspectRepositoryIdentity(join(root, 'missing'), { now })).toMatchObject({
      state: 'unavailable', reason: 'The selected directory is not accessible'
    })
    expect(await inspectRepositoryIdentity(root, { now, gitExecutable: join(root, 'no-git') })).toMatchObject({
      state: 'unavailable', reason: 'Git is not installed'
    })
  })

  it('ends slow and malformed Git reads as unavailable without trusting inherited Git overrides', async () => {
    const root = fixture()
    init(root)
    commit(root)
    const oldGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = join(root, 'nonexistent-override')
    try {
      expect(await inspectRepositoryIdentity(root, { now })).toMatchObject({ state: 'repository', root })
    } finally {
      if (oldGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = oldGitDir
    }
    const slow = join(root, 'slow-git')
    writeFileSync(slow, '#!/bin/sh\nsleep 2\n', { mode: 0o755 })
    chmodSync(slow, 0o755)
    expect(await inspectRepositoryIdentity(root, { now, gitExecutable: slow, timeoutMs: 25 }))
      .toMatchObject({ state: 'unavailable', reason: 'Git inspection timed out' })
    const malformed = join(root, 'malformed-git')
    writeFileSync(malformed, '#!/bin/sh\necho unexpected\n', { mode: 0o755 })
    chmodSync(malformed, 0o755)
    expect(await inspectRepositoryIdentity(root, { now, gitExecutable: malformed }))
      .toMatchObject({ state: 'unavailable', reason: 'Git returned an invalid repository identity' })
  })

  it('does not report a known HEAD when a later Git query times out, fails, or returns malformed data', async () => {
    const root = fixture()
    for (const [name, symbolicRef, verifyHead] of ([
      ['head-timeout', 'printf "main\\n"', 'sleep 2'],
      ['head-failure', 'printf "main\\n"', 'exit 128'],
      ['head-malformed', 'printf "main\\n"', 'printf "not-an-oid\\n"'],
      ['head-41-branch', 'printf "main\\n"', `printf '${'0'.repeat(41)}\\n'`],
      ['head-41-detached', 'exit 1', `printf '${'0'.repeat(41)}\\n'`],
      ['symbolic-failure', 'exit 128', 'printf "0123456789012345678901234567890123456789\\n"'],
      ['branch-malformed', 'printf "bad branch\\n"', 'printf "0123456789012345678901234567890123456789\\n"']
    ] as const)) {
      const executable = join(root, name)
      writeFileSync(executable, `#!/bin/sh
case "$*" in
  *--is-inside-work-tree*) printf 'true\\n${root}\\n${root}/.git\\n${root}/.git\\n' ;;
  *symbolic-ref*) ${symbolicRef} ;;
  *check-ref-format*) printf 'main\\n' ;;
  *--verify*) ${verifyHead} ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 })
      chmodSync(executable, 0o755)
      const identity = await inspectRepositoryIdentity(root, { now, gitExecutable: executable, timeoutMs: 25 })
      expect(identity, name).toMatchObject({ state: 'unavailable' })
    }
  })
})
