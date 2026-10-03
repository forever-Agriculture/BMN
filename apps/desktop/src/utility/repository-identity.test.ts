import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectRepositoryIdentity } from './repository-identity'

const roots: string[] = []
const now = () => new Date('2026-09-24T10:00:00.000Z')

function fixture(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'bmn-repository-identity-')))
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

// Real subprocess fixtures exercise bounded reads on both operating systems.
function syntheticGit(root: string, symbolicRef = 'main', verifyHead = '0'.repeat(40), location = 'valid'): string {
  const executable = join(root, process.platform === 'win32' ? 'synthetic-git.exe' : 'synthetic-git')
  if (process.platform === 'win32') {
    if (!existsSync(executable)) {
      const source = `using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
public class SyntheticGit {
 static int Reply(string value) {
  if(value.StartsWith(":exit:")) return int.Parse(value.Substring(6));
  if(value.StartsWith(":sleep:")) {Thread.Sleep(int.Parse(value.Substring(7)));return 0;}
  Console.WriteLine(value);return 0;
 }
 public static int Main(string[] args) {
  Console.OutputEncoding=new UTF8Encoding(false);
  var config=File.ReadAllLines(Path.ChangeExtension(Environment.GetCommandLineArgs()[0],"fixture"));
  if(args.Contains("--is-inside-work-tree")) return Reply(config[3]=="valid"?"true\\n"+config[0]+"\\n"+Path.Combine(config[0],".git")+"\\n"+Path.Combine(config[0],".git"):(config[3].StartsWith(":")?config[3]:"unexpected"));
  if(args.Contains("symbolic-ref")) return Reply(config[1]);
  if(args.Contains("check-ref-format")) return Reply("main");
  if(args.Contains("--verify")) return Reply(config[2]);
  return 99;
 }
}`
      const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);$r=ConvertFrom-Json ([Console]::In.ReadToEnd());Add-Type -TypeDefinition $r.source -OutputAssembly $r.executable -OutputType ConsoleApplication`
      execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { input: JSON.stringify({ source, executable }), encoding: 'utf8', timeout: 15000, windowsHide: true })
    }
    writeFileSync(join(root, 'synthetic-git.fixture'), [root, symbolicRef, verifyHead, location].join('\n'))
  } else {
    const reply = (value: string): string => value.startsWith(':exit:') ? `exit ${value.slice(6)}` :
      value.startsWith(':sleep:') ? `sleep ${Number(value.slice(7)) / 1000}` : `printf '%s\\n' '${value}'`
    writeFileSync(executable, `#!/bin/sh
case "$*" in
 *--is-inside-work-tree*) ${reply(location === 'valid' ? `true\n${root}\n${root}/.git\n${root}/.git` : location.startsWith(':') ? location : 'unexpected')} ;;
 *symbolic-ref*) ${reply(symbolicRef)} ;;
 *check-ref-format*) ${reply('main')} ;;
 *--verify*) ${reply(verifyHead)} ;;
 *) exit 99 ;;
esac
`, { mode: 0o755 })
  }
  return executable
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

  it('reports one physical root through a symlink alias', async () => {
    const parent = fixture()
    const repository = join(parent, 'repository')
    mkdirSync(repository)
    init(repository)
    commit(repository)
    const alias = join(parent, 'alias')
    symlinkSync(repository, alias)
    expect((await inspectRepositoryIdentity(alias)).state).toBe('repository')
    expect(await inspectRepositoryIdentity(alias)).toMatchObject({ state: 'repository', root: repository })
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

  it('ends slow and malformed Git reads as unavailable without trusting inherited Git overrides', { timeout: 20000 }, async () => {
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
    const slow = syntheticGit(root, 'main', '0'.repeat(40), ':sleep:2000')
    // Sleep at the first query: no known HEAD may be inferred from a timeout.
    expect(await inspectRepositoryIdentity(root, { now, gitExecutable: slow, timeoutMs: 25 }))
      .toMatchObject({ state: 'unavailable', reason: 'Git inspection timed out' })
    const malformed = syntheticGit(root, 'main', '0'.repeat(40), 'malformed')
    expect(await inspectRepositoryIdentity(root, { now, gitExecutable: malformed }))
      .toMatchObject({ state: 'unavailable', reason: 'Git returned an invalid repository identity' })
  })

  it('does not report a known HEAD when a later Git query times out, fails, or returns malformed data', { timeout: 20000 }, async () => {
    const root = fixture()
    for (const [name, symbolicRef, verifyHead] of ([
      ['head-timeout', 'main', ':sleep:2000'],
      ['head-failure', 'main', ':exit:128'],
      ['head-malformed', 'main', 'not-an-oid'],
      ['head-41-branch', 'main', '0'.repeat(41)],
      ['head-41-detached', ':exit:1', '0'.repeat(41)],
      ['symbolic-failure', ':exit:128', '0'.repeat(40)],
      ['branch-malformed', 'bad branch', '0'.repeat(40)]
    ] as const)) {
      const executable = syntheticGit(root, symbolicRef, verifyHead)
      const identity = await inspectRepositoryIdentity(root, { now, gitExecutable: executable, timeoutMs: process.platform === 'win32' ? 1000 : 25 })
      expect(identity, name).toMatchObject({ state: 'unavailable', reason: name === 'head-timeout' ?
        'Git inspection timed out' : name === 'symbolic-failure' || name === 'head-failure' ?
          'Git could not read HEAD' : name === 'branch-malformed' ?
            'Git returned an invalid branch name' : 'Git returned an invalid HEAD' })
    }
  })
})
