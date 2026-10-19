// MODULE: commit-subject-hook.test.mjs - real git commits against .githooks/commit-msg
// Story 80.10 AC1-AC2. Every repository here is disposable, in its own temporary folder removed in `finally`;
// git runs with no GIT_* variables from the caller, no system or global config, and a discovery ceiling, so
// nothing can reach this checkout's shared config.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hooksDir = join(repoRoot, '.githooks')

const REFUSAL = /the subject line is (\d+) characters; the limit is 100\.\nMove the detail into the body/u

function isolatedEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'no-global-gitconfig'),
    GIT_CEILING_DIRECTORIES: root,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Hook Test',
    GIT_AUTHOR_EMAIL: 'hook-test@example.invalid',
    GIT_COMMITTER_NAME: 'Hook Test',
    GIT_COMMITTER_EMAIL: 'hook-test@example.invalid'
  }
}

/** A disposable repository with one commit, a linked worktree of it, and git/message helpers bound to them. */
function withRepository(run, { hooksPath = hooksDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-commit-hook-'))
  const env = isolatedEnv(root)
  let messages = 0
  const git = (cwd, args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  const ok = (cwd, args) => {
    const result = git(cwd, args)
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const message = (text) => {
    const path = join(root, `message-${++messages}.txt`)
    writeFileSync(path, text)
    return path
  }
  const commit = (cwd, text, extra = []) => git(cwd, ['commit', '-q', '--allow-empty', ...extra, '-F', message(text)])
  const subject = (cwd) => ok(cwd, ['log', '-1', '--format=%s'])
  try {
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    ok(root, ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'file.txt'), 'one\n')
    ok(repo, ['add', 'file.txt'])
    ok(repo, ['commit', '-q', '-m', 'chore: first commit'])
    if (hooksPath) ok(repo, ['config', 'core.hooksPath', hooksPath])
    ok(repo, ['worktree', 'add', '-q', '-b', 'side-worktree', worktree])
    return run({ root, env, repo, worktree, git, ok, message, commit, subject })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ascii = (prefix, total) => prefix + 'a'.repeat(total - prefix.length)

describe.each([['repository'], ['linked worktree']])('commit-msg hook in a disposable %s', (where) => {
  const pick = (context) => (where === 'repository' ? context.repo : context.worktree)

  it('refuses a 101-code-point subject and says the limit, the body and how to remove the hook', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const before = context.subject(cwd)
      const result = context.commit(cwd, `${ascii('feat: ', 101)}\n\nbody\n`)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(REFUSAL)
      expect(result.stderr.match(REFUSAL)[1]).toBe('101')
      expect(result.stderr).toContain('To remove this hook: git config --unset core.hooksPath')
      expect(context.subject(cwd)).toBe(before)
    })
  })

  it('accepts a 100-code-point subject, the Conventional prefix counted, with a long body', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const line = ascii('feat: ', 100)
      const result = context.commit(cwd, `${line}\n\n${'body '.repeat(100)}\n`)
      expect(result.status).toBe(0)
      expect(context.subject(cwd)).toBe(line)
    })
  })

  it('accepts a 100-code-point subject followed by trailing spaces the hook itself removes', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const line = ascii('fix: ', 100)
      // verbatim: git would otherwise strip the spaces before the hook runs, as it does not after an editor.
      expect(context.commit(cwd, `${line}   \t\n`, ['--cleanup=verbatim']).status).toBe(0)
      expect(context.subject(cwd)).toBe(line)
    })
  })

  it('counts multi-byte subjects by code points: 100 accepted, 101 refused', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const wide = String.fromCodePoint(0x1f600)
      const accented = String.fromCodePoint(0xe9)
      const hundred = `docs: ${accented.repeat(47)}${wide.repeat(47)}`
      expect([...hundred].length).toBe(100)
      expect(hundred.length).toBeGreaterThan(100)
      expect(Buffer.byteLength(hundred)).toBeGreaterThan(100)
      expect(context.commit(cwd, `${hundred}\n`).status).toBe(0)
      expect(context.subject(cwd)).toBe(hundred)

      const result = context.commit(cwd, `${hundred}${wide}\n`)
      expect(result.status).toBe(1)
      expect(result.stderr.match(REFUSAL)?.[1]).toBe('101')
      expect(context.subject(cwd)).toBe(hundred)
    })
  })

  it('accepts a real merge commit with a long "Merge " subject', () => {
    withRepository((context) => {
      const cwd = pick(context)
      context.ok(cwd, ['checkout', '-q', '-b', 'topic'])
      writeFileSync(join(cwd, 'topic.txt'), 'topic\n')
      context.ok(cwd, ['add', 'topic.txt'])
      context.ok(cwd, ['commit', '-q', '-m', 'feat: topic'])
      context.ok(cwd, ['checkout', '-q', '-'])
      context.ok(cwd, ['merge', '-q', '--no-ff', '--no-commit', 'topic'])
      const line = ascii('Merge branch \'topic\' ', 160)
      expect(context.commit(cwd, `${line}\n`).status).toBe(0)
      expect(context.subject(cwd)).toBe(line)
      expect(context.ok(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3)
    })
  })

  it('accepts a real revert commit with a long \'Revert "\' subject', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const original = ascii('feat: ', 100)
      writeFileSync(join(cwd, 'file.txt'), 'two\n')
      context.ok(cwd, ['add', 'file.txt'])
      expect(context.commit(cwd, `${original}\n`).status).toBe(0)
      context.ok(cwd, ['revert', '--no-commit', 'HEAD'])
      const line = `Revert "${original}"`
      expect([...line].length).toBe(109)
      expect(context.commit(cwd, `${line}\n\nThis reverts the previous commit.\n`).status).toBe(0)
      expect(context.subject(cwd)).toBe(line)
    })
  })

  it('refuses --amend to a long subject and keeps the commit; accepts --amend to a short one', () => {
    withRepository((context) => {
      const cwd = pick(context)
      expect(context.commit(cwd, 'fix: short\n').status).toBe(0)
      const head = context.ok(cwd, ['rev-parse', 'HEAD'])
      const refused = context.commit(cwd, `${ascii('fix: ', 130)}\n`, ['--amend'])
      expect(refused.status).toBe(1)
      expect(refused.stderr.match(REFUSAL)?.[1]).toBe('130')
      expect(context.ok(cwd, ['rev-parse', 'HEAD'])).toBe(head)
      expect(context.commit(cwd, 'fix: shorter\n', ['--amend']).status).toBe(0)
      expect(context.subject(cwd)).toBe('fix: shorter')
    })
  })

  it('skips a long leading comment line and blank lines, and still checks the subject after them', () => {
    withRepository((context) => {
      const cwd = pick(context)
      const comment = `# ${'note '.repeat(40)}`
      expect(context.commit(cwd, `${comment}\n\n\nfix: short\n`, ['--cleanup=strip']).status).toBe(0)
      expect(context.subject(cwd)).toBe('fix: short')

      const result = context.commit(cwd, `# note\n\n${ascii('fix: ', 101)}\n`, ['--cleanup=strip'])
      expect(result.status).toBe(1)
      expect(result.stderr.match(REFUSAL)?.[1]).toBe('101')
    })
  })

  it('honours core.commentChar for the skipped lines', () => {
    withRepository((context) => {
      const cwd = pick(context)
      context.ok(cwd, ['config', 'core.commentChar', ';'])
      const result = context.commit(cwd, `; ${'note '.repeat(40)}\nfix: short\n`, ['--cleanup=strip'])
      expect(result.status).toBe(0)
      expect(context.subject(cwd)).toBe('fix: short')
    })
  })
})
