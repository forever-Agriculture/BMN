// MODULE: grant-command.test.ts - Story 103.3: what a card may grant as a command, read with the guard's parser (D7, R103-NFR2)
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GrantCommandTerm } from '@bmn/protocol'
import { simpleCommandWords } from '../../bin/command-guard.mjs'
import { commandPinSha, grantCommandProblem, pinnedFileSha } from '../../bin/grant-command.mjs'

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

describe('every spelling of what is never on a card (the full review, finding 1)', () => {
  it.each([
    ['git rm package.json', 'deletion'],
    ['git -C /tmp/elsewhere rm a', 'deletion'],
    ['git checkout .', 'deletion'],
    ['git switch --discard-changes main', 'deletion'],
    ['git switch -f main', 'deletion'],
    ['git reflog expire --all', 'deletion'],
    ['git gc --prune=now', 'deletion'],
    ['git prune', 'deletion'],
    ['git filter-branch one', 'deletion'],
    ['git remote remove origin', 'deletion'],
    ['git symbolic-ref -d HEAD', 'deletion'],
    ['git credential fill', 'credential'],
    ['git -c alias.x=status x', 'config'],
    ['git -c core.sshCommand=other fetch', 'config'],
    ['git --config-env=alias.x=Y x', 'config'],
    ['git --exec-path=/tmp/elsewhere status', 'config'],
    ['docker container rm test', 'deletion'],
    ['docker container remove test', 'deletion'],
    ['docker image rm one', 'deletion'],
    ['docker image remove one', 'deletion'],
    ['podman image rm one', 'deletion'],
    ['docker --context other container rm one', 'deletion'],
    ['docker --made-up value rm one', 'deletion'],
    ['docker-compose rm', 'deletion'],
    ['docker compose rm', 'deletion'],
    ['docker compose down', 'deletion'],
    ['docker image push example/test', 'publish'],
    ['docker compose push', 'publish'],
    ['docker buildx build --push .', 'publish'],
    ['docker build --push .', 'publish'],
    ['gh issue delete 1', 'deletion'],
    ['gh -R o/r release view v1', 'release'],
    ['gh auth status --show-token', 'credential'],
    ['curl -sXDELETE https://example.test/one', 'deletion'],
    ['curl -sX DELETE https://example.test/one', 'deletion'],
    ['cargo --locked publish', 'publish'],
    ['poetry -q publish', 'publish'],
    ['uv publish', 'publish'],
    ['twine --verbose upload a', 'publish'],
    ['gem -V push a.gem', 'publish'],
    ['rsync -a --delete a b', 'deletion'],
    ['find . -name x -exec touch', 'another program'],
    ['cat --file=.env', 'credential']
  ])('refuses %s', (command, why) => {
    expect(grantCommandProblem(term(command))).toContain(why)
  })

  it.each([
    'git status',
    'git -C /tmp log',
    'git checkout main',
    'git switch main',
    'git rev-parse HEAD',
    'docker ps',
    'docker logs one',
    'docker container ls',
    'docker image ls',
    'docker compose ps',
    'docker build .',
    'curl -s https://example.test/one',
    'cargo test',
    'gh issue list',
    'rsync -a a b',
    'find . -name x'
  ])('still takes %s', (command) => {
    expect(grantCommandProblem(term(command))).toBeNull()
  })

  it('takes a name that is also a file as what git checkout would discard', () => {
    expect(grantCommandProblem(term('git checkout scripts/check.sh'))).toContain('deletion')
  })
})

describe('the file a command really runs (the full review, finding 2)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const pin = (path: string, text: string) => ({ path, sha256: sha(text) })
  const shSha = pinnedFileSha({ path: '/bin/sh', sha256: SHA }, '/')!

  it('reads an interpreter given by its absolute path as an interpreter: the script is what is pinned', () => {
    expect(grantCommandProblem(term('/bin/sh scripts/check.sh'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('/bin/sh scripts/check.sh', { script: { path: '/bin/sh', sha256: shSha } }))).toContain('that is the file to pin')
    expect(grantCommandProblem(term('/bin/sh scripts/check.sh', { script: { path: 'scripts/check.sh', sha256: SHA } }))).toBeNull()
  })

  it('refuses what it cannot read for sure: options before a script, no script, no such file', () => {
    expect(grantCommandProblem(term('python3 -u scripts/check.sh'))).toContain('before the script')
    expect(grantCommandProblem(term('node -r ./other.sh scripts/check.sh'))).toContain('before the script')
    expect(grantCommandProblem(term('python3 -m tool'))).toContain('before the script')
    expect(grantCommandProblem(term('python3'))).toContain('no script')
    expect(grantCommandProblem(term('python3 gone.py'))).toContain('not a file')
    expect(grantCommandProblem(term('deno task build'))).toContain('not a file')
    expect(grantCommandProblem(term('bun run scripts/check.sh'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('python3 scripts/check.sh -c anything'))).toContain('name that script on the card')
  })

  it('refuses a writable interpreter or runner by path: two files would decide what runs', () => {
    const own = mkdtempSync(join(folder, 'own-'))
    writeFileSync(join(own, 'python3'), '#!/bin/sh\n')
    writeFileSync(join(own, 'make'), '#!/bin/sh\n')
    expect(grantCommandProblem(term('./own-x/python3 scripts/check.sh'))).toContain('does not exist yet')
    expect(grantCommandProblem(term(`${own}/python3 scripts/check.sh`))).toContain('one file')
    expect(grantCommandProblem(term(`${own}/make all`))).toContain('one file')
  })

  it('does not take a version word as a version unless it is the only word', () => {
    const runners = mkdtempSync(join(folder, 'version-'))
    writeFileSync(join(runners, 'package.json'), '{}\n')
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    expect(grantCommandProblem(term('pnpm run lint -- --version', { folder: runners }))).toContain('package.json')
    expect(grantCommandProblem(term('pnpm run lint -- --version', { folder: runners, script: pin('Makefile', 'all:\n') }))).toContain('that is the file to pin')
    expect(grantCommandProblem(term('make -v all', { folder: runners }))).toContain('Makefile')
    expect(grantCommandProblem(term('./scripts/check.sh --version'))).toContain('name that script on the card')
    expect(grantCommandProblem(term('make --version', { folder: runners }))).toBeNull()
  })

  it('reads how a runner names its file, each spelling; options after -- belong to the script', () => {
    const runners = mkdtempSync(join(folder, 'named-'))
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    writeFileSync(join(runners, 'other.mk'), 'x:\n')
    mkdirSync(join(runners, 'sub'))
    writeFileSync(join(runners, 'sub', 'inner.mk'), 'y:\n')
    writeFileSync(join(runners, 'package.json'), '{}\n')
    writeFileSync(join(runners, 'sub', 'package.json'), '{"name":"sub"}\n')
    const at = { folder: runners }
    for (const command of ['make -fother.mk x', 'make -sfother.mk x', 'make -f other.mk x', 'make --file=other.mk x', 'make --makefile other.mk x']) {
      expect(grantCommandProblem(term(command, at))).toContain('other.mk')
      expect(grantCommandProblem(term(command, { ...at, script: pin('Makefile', 'all:\n') }))).toContain('that is the file to pin')
      expect(grantCommandProblem(term(command, { ...at, script: pin('other.mk', 'x:\n') }))).toBeNull()
    }
    expect(grantCommandProblem(term('make -Csub -f inner.mk y', { ...at, script: pin('sub/inner.mk', 'y:\n') }))).toBeNull()
    expect(grantCommandProblem(term('make -f other.mk -f Makefile', at))).toContain('more than one')
    expect(grantCommandProblem(term('make -f', at))).toContain('not a file')
    expect(grantCommandProblem(term('make -f missing.mk', at))).toContain('not a file')
    expect(grantCommandProblem(term('npm --prefix=sub run x', at))).toContain('sub/package.json')
    expect(grantCommandProblem(term('pnpm -C sub run x', at))).toContain('sub/package.json')
    expect(grantCommandProblem(term('pnpm run x -- -C sub', { ...at, script: pin('package.json', '{}\n') }))).toBeNull()
  })

  it('refuses a runner that picks among several files', () => {
    const runners = mkdtempSync(join(folder, 'several-'))
    writeFileSync(join(runners, 'package.json'), '{}\n')
    for (const command of ['pnpm --filter one run x', 'pnpm --filter=one run x', 'pnpm -r run x', 'npm --workspaces run x', 'npm -w one run x']) {
      expect(grantCommandProblem(term(command, { folder: runners }))).toContain('more than one')
    }
  })

  it('finds a package manager\'s file in a folder above, as it does', () => {
    const runners = mkdtempSync(join(folder, 'above-'))
    writeFileSync(join(runners, 'package.json'), '{}\n')
    mkdirSync(join(runners, 'deep'))
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    expect(grantCommandProblem(term('pnpm run x', { folder: join(runners, 'deep') }))).toContain('package.json')
    expect(grantCommandProblem(term('make all', { folder: join(runners, 'deep') }))).toBeNull()
  })

  it('refuses a pin on a command that runs no file it can name: the pin would say nothing', () => {
    expect(grantCommandProblem(term('git status', { script: { path: 'scripts/check.sh', sha256: SHA } }))).toContain('no file')
  })
})

describe('commandPinSha: the hash a use is recorded under (the full review, findings 2 and 3)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  it('hashes the pin while the command still selects it; another file in front of it, or a change, is another answer', () => {
    const runners = mkdtempSync(join(folder, 'use-'))
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    const held = { command: 'make all', folder: runners, script: { path: 'Makefile', sha256: sha('all:\n') } }
    expect(commandPinSha(held)).toBe(sha('all:\n'))
    writeFileSync(join(runners, 'Makefile'), 'all: other\n')
    expect(commandPinSha(held)).toBe(sha('all: other\n'))
    writeFileSync(join(runners, 'Makefile'), 'all:\n')
    writeFileSync(join(runners, 'GNUmakefile'), 'all:\n\techo another\n')
    expect(commandPinSha(held)).toBeNull()
  })

  it('reads nothing as no hash: no pin, or a command that names no file', () => {
    expect(commandPinSha({ command: './scripts/check.sh', folder, script: null })).toBeNull()
    expect(commandPinSha({ command: 'git status', folder, script: { path: 'scripts/check.sh', sha256: SHA } })).toBeNull()
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
