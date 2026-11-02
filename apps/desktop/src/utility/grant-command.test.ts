// MODULE: grant-command.test.ts - Story 103.3: what a card may grant as a command, read with the guard's parser (D7, R103-NFR2)
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GrantCommandTerm } from '@bmn/protocol'
import { simpleCommandWords } from '../../bin/command-guard.mjs'
import { grantCommandProblem, pinnedFileSha } from '../../bin/grant-command.mjs'

const folder = mkdtempSync(join(tmpdir(), 'bmn-grant-command-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
mkdirSync(join(folder, 'scripts'))
const SCRIPT = '#!/bin/sh\necho hello\n'
writeFileSync(join(folder, 'scripts', 'check.sh'), SCRIPT)
chmodSync(join(folder, 'scripts', 'check.sh'), 0o755)
writeFileSync(join(folder, 'other.sh'), '#!/bin/sh\n')
const SHA = createHash('sha256').update(SCRIPT).digest('hex')
const term = (command: string, over: Partial<GrantCommandTerm> = {}): GrantCommandTerm => ({ id: 'c', kind: 'command', command, folder, script: null, count: 1, proposed: 'yes', reason: 'r', ...over })

describe('simpleCommandWords (D7: one simple command, exactly as it will run)', () => {
  it.each([
    ['pnpm run lint', ['pnpm', 'run', 'lint']],
    ['git status --short', ['git', 'status', '--short']],
    ["git commit -m 'one; two'", ['git', 'commit', '-m', 'one; two']],
    ['python3 scripts/check.py --all', ['python3', 'scripts/check.py', '--all']],
    ['./scripts/check.sh', ['./scripts/check.sh']]
  ])('reads %s', (command, words) => {
    expect(simpleCommandWords(command)).toEqual({ words })
  })

  it.each([
    ['', 'empty'],
    ['a; b', 'chains'],
    ['a && b', 'chains'],
    ['a || b', 'chains'],
    ['a | b', 'chains'],
    ['a &', 'chains'],
    ['a > f', 'redirect'],
    ['a < f', 'redirect'],
    ['(a)', 'subshell'],
    ['a $(b)', 'substitution'],
    ['a `b`', 'substitution'],
    ['a "$(b)"', 'substitution'],
    ['a "$HOME"', 'variable'],
    ['a $HOME', 'variable'],
    ['ls *.ts', 'wildcard'],
    ['ls file?', 'wildcard'],
    ['ls {a,b}', 'wildcard'],
    ['a # note', 'shell syntax'],
    ["a 'b", 'quotes'],
    ['FOO=1 a', 'sets a variable'],
    ['eval a', 'runs other code'],
    ['exec a', 'runs other code'],
    ['source f', 'runs other code'],
    ['. f', 'runs other code'],
    ['sh -c a', 'shell code'],
    ['bash -lc a', 'shell code'],
    ['bash', 'shell code'],
    ['sudo a', 'wraps'],
    ['env a', 'wraps'],
    ['nohup a', 'wraps'],
    ['timeout 5 a', 'wraps'],
    ['xargs a', 'wraps']
  ])('refuses %s', (command, why) => {
    const answer = simpleCommandWords(command)
    expect(answer).toMatchObject({ problem: expect.stringContaining(why) })
  })

  it('takes those characters inside single quotes, and no expansion inside double ones', () => {
    expect(simpleCommandWords("grep 'a|b;c>$d' file")).toEqual({ words: ['grep', 'a|b;c>$d', 'file'] })
    expect(simpleCommandWords('grep "a|b;c" file')).toEqual({ words: ['grep', 'a|b;c', 'file'] })
  })

  it('does not read a non-string as a command', () => {
    expect(simpleCommandWords(null)).toHaveProperty('problem')
    expect(simpleCommandWords(['ls'])).toHaveProperty('problem')
  })
})

describe('grantCommandProblem (R103-NFR2: what is never on a card)', () => {
  it.each([
    'pnpm run lint',
    'git status',
    'git push origin main',
    'gh pr view 12',
    'python3 --version',
    'cat .env.example'
  ])('takes %s', (command) => {
    expect(grantCommandProblem(term(command))).toBeNull()
  })

  it.each([
    ['rm build/out', 'deletion'],
    ['rmdir build', 'deletion'],
    ['shred f', 'deletion'],
    ['truncate -s0 f', 'deletion'],
    ['find . -delete', 'deletion'],
    ['git branch -D old', 'deletion'],
    ['git branch --delete old', 'deletion'],
    ['git tag v1', 'release'],
    ['git worktree remove old', 'deletion'],
    ['git clean -fd', 'deletion'],
    ['git -C /tmp/elsewhere clean -fd', 'deletion'],
    ['git -c core.editor=true branch -D old', 'deletion'],
    ['git --git-dir /tmp/x tag v1', 'release'],
    ['docker --context other rm one', 'deletion'],
    ['git update-ref -d refs/heads/old', 'deletion'],
    ['git reset --hard', 'deletion'],
    ['git restore src/a.ts', 'deletion'],
    ['git checkout -- src/a.ts', 'deletion'],
    ['git stash drop', 'holds it'],
    ['gh api -X DELETE repos/o/r/git/refs/heads/old', 'deletion'],
    ['gh api --method=DELETE repos/o/r/issues/1', 'deletion'],
    ['curl -X DELETE https://example.test/one', 'deletion'],
    ['curl -XDELETE https://example.test/one', 'deletion'],
    ['docker rm one', 'deletion'],
    ['docker rmi one', 'deletion'],
    ['gh release create v1', 'release'],
    ['docker push one', 'publish'],
    ['cargo publish', 'publish'],
    ['twine upload dist/a', 'publish'],
    ['gem push a.gem', 'publish'],
    ['npm publish', 'publish'],
    ['pnpm publish', 'publish'],
    ['kill 12', 'stopping'],
    ['pkill bmn', 'stopping'],
    ['killall bmn', 'stopping'],
    ['gh auth token', 'credential'],
    ['gh auth login', 'credential'],
    ['printenv', 'credential'],
    ['cat .env', 'credential'],
    ['cat config/.env.production', 'credential'],
    ['cat ~/.ssh/id_ed25519', 'credential'],
    ['bmn plan set a done', 'BMN'],
    ['python3 -c pass', 'code'],
    ['node -e "console.log(1)"', 'code']
  ])('refuses %s', (command, why) => {
    expect(grantCommandProblem(term(command))).toContain(why)
  })

  it.each([
    ['docker system prune -af'],
    ['docker volume rm data'],
    ['prime-select nvidia'],
    ['git push --force origin main']
  ])('refuses %s because the guard holds it', (command) => {
    expect(grantCommandProblem(term(command))).toContain("command guard holds it")
  })

  it('refuses a folder that is not there', () => {
    expect(grantCommandProblem(term('git status', { folder: join(folder, 'missing') }))).toContain('not a folder')
    expect(grantCommandProblem(term('git status', { folder: join(folder, 'other.sh') }))).toContain('not a folder')
  })

  it('says it cannot pin a program that is not there yet', () => {
    expect(grantCommandProblem(term('./scripts/missing.sh'))).toContain('does not exist yet')
  })

  it('needs a pin on a script in a folder the agent can write', () => {
    expect(grantCommandProblem(term('./scripts/check.sh'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('python3 scripts/check.sh --all'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('python3 -u scripts/check.sh'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('./scripts/check.sh', { script: { path: 'scripts/check.sh', sha256: SHA } }))).toBeNull()
    expect(grantCommandProblem(term('python3 scripts/check.sh', { script: { path: join(folder, 'scripts/check.sh'), sha256: SHA } }))).toBeNull()
  })

  it('refuses a pin with another hash, on another file, or on a secret', () => {
    expect(grantCommandProblem(term('./scripts/check.sh', { script: { path: 'scripts/check.sh', sha256: 'b'.repeat(64) } }))).toContain('does not have the SHA-256')
    expect(grantCommandProblem(term('./scripts/check.sh', { script: { path: 'other.sh', sha256: createHash('sha256').update('#!/bin/sh\n').digest('hex') } }))).toContain('that is the file to pin')
    expect(grantCommandProblem(term('pnpm run lint', { script: { path: '.env', sha256: 'b'.repeat(64) } }))).toContain('credential')
  })

  it('treats a runner\'s own file as what it runs: writable, it is pinned; absent, there is nothing to pin (the pre-review)', () => {
    const runners = mkdtempSync(join(folder, 'runners-'))
    const pin = (path: string, text: string) => ({ path, sha256: createHash('sha256').update(text).digest('hex') })
    expect(grantCommandProblem(term('make all', { folder: runners }))).toBeNull()
    expect(grantCommandProblem(term('pnpm run lint', { folder: runners }))).toBeNull()
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    writeFileSync(join(runners, 'package.json'), '{}\n')
    mkdirSync(join(runners, 'sub'))
    writeFileSync(join(runners, 'sub', 'other.mk'), 'x:\n')
    expect(grantCommandProblem(term('make all', { folder: runners }))).toContain('Makefile')
    expect(grantCommandProblem(term('make -f sub/other.mk x', { folder: runners }))).toContain('other.mk')
    expect(grantCommandProblem(term('pnpm run lint', { folder: runners }))).toContain('package.json')
    expect(grantCommandProblem(term('pnpm --version', { folder: runners }))).toBeNull()
    expect(grantCommandProblem(term('make all', { folder: runners, script: pin('Makefile', 'all:\n') }))).toBeNull()
    expect(grantCommandProblem(term('pnpm run lint', { folder: runners, script: pin('package.json', '{}\n') }))).toBeNull()
    expect(grantCommandProblem(term('make all', { folder: runners, script: pin('package.json', '{}\n') }))).toContain('that is the file to pin')
  })
})

describe('pinnedFileSha (103.3 AC3)', () => {
  it('hashes the file the pin names, relative to its folder', () => {
    expect(pinnedFileSha({ path: 'scripts/check.sh', sha256: SHA }, folder)).toBe(SHA)
    expect(pinnedFileSha({ path: join(folder, 'scripts/check.sh'), sha256: SHA }, '/')).toBe(SHA)
  })

  it('reads nothing as no hash: a missing file, or a folder', () => {
    expect(pinnedFileSha({ path: 'missing', sha256: SHA }, folder)).toBeNull()
    expect(pinnedFileSha({ path: 'scripts', sha256: SHA }, folder)).toBeNull()
  })
})
