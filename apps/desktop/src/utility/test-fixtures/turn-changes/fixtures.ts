// MODULE: fixtures.ts - made-up Git repositories for the turn changes tests: a scratch place with its own home and data root, two captures around a change, and what a folder holds byte for byte
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { capture, isRefusal, type CaptureOptions, type CaptureOutcome, type StagedCapture } from '../../turn-changes-capture'
import { compareCaptures, type TurnComparison, type TurnFileRow } from '../../turn-changes-compare'
import { turnGitExecutable } from '../../turn-changes-git'
import { TurnStore, type TurnCaptureRecord } from '../../turn-changes-store'

export const GIT = turnGitExecutable() ?? '/usr/bin/git'
export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export type FixtureGit = (cwd: string, ...args: string[]) => string

export interface Place {
  base: string
  home: string
  repo: string
  dataRoot: string
  git: FixtureGit
  options: CaptureOptions
  done: () => void
}

/** Git for building a fixture: a made-up HOME, no system settings, a made-up author. Never used by a capture. */
export function builder(home: string): FixtureGit {
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Made Up', GIT_AUTHOR_EMAIL: 'made@example.test', GIT_COMMITTER_NAME: 'Made Up', GIT_COMMITTER_EMAIL: 'made@example.test'
  }
  return (cwd, ...args) => execFileSync(GIT, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function write(folder: string, name: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(folder, name)), { recursive: true })
  writeFileSync(join(folder, name), content)
}

/** A new scratch folder with a made-up home, a data root that does not exist yet, and a repository with one commit. */
export function scratch(name: string, { commit = true, init = [] as string[] } = {}): Place {
  const base = mkdtempSync(join(tmpdir(), `bmn-turn-${name}-`))
  const home = join(base, 'home')
  const repo = join(base, 'repo')
  mkdirSync(home)
  mkdirSync(repo)
  const git = builder(home)
  git(repo, 'init', '-q', '-b', 'main', ...init)
  if (commit) {
    write(repo, 'keep.txt', 'k\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'made-up start')
  }
  const dataRoot = join(base, 'data')
  return { base, home, repo, dataRoot, git, options: { home, dataRoot, session: 's-case' }, done: () => rmSync(base, { recursive: true, force: true }) }
}

export interface Around {
  one: TurnCaptureRecord
  two: TurnCaptureRecord
  store: TurnStore
  compared: TurnComparison
}

const told = (outcome: CaptureOutcome): string => (isRefusal(outcome) ? `${outcome.state}: ${outcome.reason}` : `${outcome.state}: ${outcome.record.bound ?? ''}`)

/** Publishes a staged capture and gives its record as it stands on disk. Throws when the publication was stopped. */
export async function published(staged: StagedCapture): Promise<TurnCaptureRecord> {
  const done = await staged.publish()
  if (done === null) throw new Error('the publication was stopped')
  return done.record
}

/** Two published captures around `change`, compared. Throws when either is not whole. */
export async function around(
  place: Place,
  change: () => void | Promise<void>,
  { folder = place.repo, secondOptions = {} as Partial<CaptureOptions> } = {}
): Promise<Around> {
  const first = await capture(folder, place.options)
  if (isRefusal(first) || first.state !== 'whole') throw new Error(`first capture: ${told(first)}`)
  const one = await published(first)
  // A file is taken as read before only when it had been still for a moment when it was read.
  await sleep(25)
  await change()
  const second = await capture(folder, { ...place.options, base: one.id, ...secondOptions })
  if (isRefusal(second) || second.state !== 'whole') throw new Error(`second capture: ${told(second)}`)
  const two = await published(second)
  const store = new TurnStore(place.dataRoot, place.options.session, one.root)
  const compared = compareCaptures(store, one.id, two.id)
  if (compared.state !== 'compared') throw new Error(`comparison: ${compared.state}: ${compared.reason}`)
  return { one, two, store, compared }
}

/** A comparison's rows by path, without the path. */
export function rows(compared: TurnComparison): Record<string, Omit<TurnFileRow, 'path'>> {
  return Object.fromEntries(compared.files.map(({ path, ...rest }) => [path, rest]))
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Everything under a folder: per path its kind, mode, size, times of its bytes and their SHA-256. Access times are left out. */
export function snapshot(folder: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(folder, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      const stat = lstatSync(join(folder, path), { bigint: true })
      if (entry.isDirectory()) {
        out[`${path}/`] = `folder ${stat.mode.toString(8)} ino ${stat.ino}`
        walk(path)
      } else if (entry.isSymbolicLink()) out[path] = `link ${readlinkSync(join(folder, path))} ino ${stat.ino}`
      else out[path] = `file ${stat.mode.toString(8)} ${stat.size} ${stat.mtimeNs} ${stat.ctimeNs} ino ${stat.ino} ${stat.isFile() ? sha(readFileSync(join(folder, path))) : 'special'}`
    }
  }
  walk('')
  return out
}

export function unequal(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name])
}

/** True when any file under `folder` holds `needle`. */
export function holds(folder: string, needle: string | Buffer): boolean {
  if (!existsSync(folder)) return false
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(needle)) return true
  }
  return false
}

/** Bytes of every file under a folder, counted here and by nothing of BMN's own. */
export function bytesUnder(folder: string): number {
  if (!existsSync(folder)) return 0
  let total = 0
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) total += lstatSync(join(entry.parentPath, entry.name)).size
  }
  return total
}

export function filesUnder(folder: string): number {
  return existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).length : 0
}

const HOOK_NAMES = [
  'applypatch-msg', 'commit-msg', 'fsmonitor-watchman', 'post-applypatch', 'post-checkout', 'post-commit', 'post-index-change', 'post-merge',
  'post-rewrite', 'post-update', 'pre-applypatch', 'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'pre-receive',
  'prepare-commit-msg', 'proc-receive', 'push-to-checkout', 'reference-transaction', 'sendemail-validate', 'update'
]

/**
 * Settings that name a program for everything Git can be made to run, each a script that leaves a
 * marker file under `ran` when it runs: filters, fsmonitor (also through an included file), every
 * hook, an external diff, a diff command, a textconv program, an alias, a pager, an editor, a
 * credential helper, an SSH command and automatic maintenance, in a partial clone.
 */
export function hostileSettings(place: Place, prefix: string, extra = ''): { settings: string; ran: string } {
  const tools = join(place.base, `${prefix}tools`)
  const ran = join(place.base, 'markers')
  const hooks = join(place.base, `${prefix}hooks`)
  for (const folder of [tools, ran, hooks]) mkdirSync(folder, { recursive: true })
  // Each passes its input through, as a filter must; `answers: false` is a program that leaves at once, so that Git does not wait for it.
  const tool = (name: string, answers = true): string => {
    const path = join(tools, `${name}.sh`)
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> ${join(ran, `${prefix}${name}`)}\n${answers ? 'cat 2>/dev/null\n' : ''}exit 0\n`, { mode: 0o755 })
    return path
  }
  for (const name of HOOK_NAMES) {
    const body = `#!/bin/sh\necho "$0 $*" >> ${join(ran, `${prefix}hook-${name}`)}\nexit 0\n`
    writeFileSync(join(hooks, name), body, { mode: 0o755 })
    writeFileSync(join(place.repo, '.git/hooks', name), body, { mode: 0o755 })
  }
  const included = join(place.repo, '.git', `${prefix}included.config`)
  writeFileSync(included, `[core]\n\tfsmonitor = ${tool('included-fsmonitor')}\n[uploadpack]\n\tpackObjectsHook = ${tool('pack-objects')}\n[merge "evil"]\n\tdriver = ${tool('merge-driver')} %O %A %B\n`)
  const settings = `[core]
	repositoryformatversion = 1
	filemode = true
	bare = false
	logallrefupdates = true
	fsmonitor = ${tool('fsmonitor')}
	hooksPath = ${hooks}
	pager = ${tool('pager')}
	editor = ${tool('editor')}
	sshCommand = ${tool('ssh')}
	askPass = ${tool('askpass')}
	alternateRefsCommand = ${tool('alternate-refs')}
	gitProxy = ${tool('proxy')}
${extra}[extensions]
	partialClone = origin
[remote "origin"]
	url = ${join(place.base, 'promisor.git')}
	fetch = +refs/heads/*:refs/remotes/origin/*
	promisor = true
	partialclonefilter = blob:none
	uploadpack = ${tool('upload-pack', false)}
[filter "evil"]
	clean = ${tool('clean')}
	smudge = ${tool('smudge')}
	process = ${tool('process', false)}
	required = true
[diff]
	external = ${tool('external-diff')}
[diff "evil"]
	command = ${tool('diff-command')}
	textconv = ${tool('textconv')}
[include]
	path = ${included}
[maintenance]
	auto = true
[gc]
	auto = 1
	autoDetach = false
[credential]
	helper = ${tool('credential')}
[alias]
	st = !${tool('alias')}
`
  return { settings, ran }
}
