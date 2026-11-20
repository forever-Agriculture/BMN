// MODULE: update-supervisor.test.mjs - Story 134.2: a queued update is built and tested while BMN is open; newer pushes supersede it (throwaway repository, local bare remote)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutSource } from '../install/update-desktop.mjs'
import { buildFolders, keepPassedBuild, packageAndSmoke, swapInReadyBuild } from '../lib/staged-build.mjs'
import { attemptLogs, startAttempt } from '../lib/update-attempts.mjs'
import { SourceMoved, stepFailure, superviseUpdate } from '../lib/update-supervisor.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A throwaway checkout of `main` with a local bare remote; `push(label)` commits and pushes, returning the commit. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-update-supervisor-'))
  roots.push(root)
  const remote = join(root, 'remote.git'), checkout = join(root, 'checkout')
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote)
  git(root, 'clone', '--quiet', remote, checkout)
  git(checkout, 'checkout', '--quiet', '-B', 'main')
  const push = (label) => {
    writeFileSync(join(checkout, 'version.txt'), `${label}\n`)
    git(checkout, 'add', 'version.txt')
    git(checkout, 'commit', '--quiet', '-m', label)
    git(checkout, 'push', '--quiet', 'origin', 'main')
    return git(checkout, 'rev-parse', 'HEAD')
  }
  const folders = buildFolders(join(root, 'release', 'linux-unpacked'))
  const state = join(root, 'state')
  mkdirSync(folders.live, { recursive: true })
  writeFileSync(join(folders.live, 'bmn'), 'build of the installed commit\n')
  return { root, checkout, push, folders, state }
}

/** A promise opened from outside: a build step waits on it, so the test decides when it ends. */
function gate() {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

const until = async (check, what) => {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * The supervisor wired as the worker wires it, with the real checkout reader, attempt logs and build folders; only
 * pnpm is replaced: `package` writes a build naming its commit and waits on that commit's gate; the smoke fails for
 * commits in `failing`. Like the worker's build, a build whose source moved meanwhile is SourceMoved.
 */
function harness(repo, { failing = new Set() } = {}) {
  const statuses = [], notices = [], gates = new Map(), built = []
  const app = { open: true }
  const gateFor = (commit) => { if (!gates.has(commit)) gates.set(commit, gate()); return gates.get(commit) }
  const io = {
    source: () => checkoutSource(repo.checkout),
    build: async (commit, { attempt, signal }) => {
      built.push(commit)
      const step = async (label, args) => {
        attempt.log(`START ${label}: pnpm ${args.join(' ')}`)
        if (label === 'package') {
          await Promise.race([gateFor(commit).promise, new Promise((_resolve, reject) => {
            if (signal.aborted) reject(new Error('package stopped: BMN exited'))
            signal.addEventListener('abort', () => reject(new Error('package stopped: BMN exited')), { once: true })
          })])
          mkdirSync(join(repo.folders.staging, 'linux-unpacked'), { recursive: true })
          writeFileSync(join(repo.folders.staging, 'linux-unpacked', 'bmn'), `build of ${commit}\n`)
        }
        if (label === 'packaged smoke test' && failing.has(commit)) throw stepFailure(label, new Error('packaged self-test exited 1'))
        attempt.log(`PASS ${label}`)
      }
      await packageAndSmoke({ folders: repo.folders, step, log: attempt.log })
      const now = checkoutSource(repo.checkout)
      if (now.head !== commit) throw new SourceMoved(`HEAD moved from ${commit} to ${now.head}`)
      if (now.problem !== null) throw new SourceMoved(now.problem)
      keepPassedBuild(repo.folders)
    },
    install: async (commit, attempt) => {
      const swap = swapInReadyBuild(repo.folders)
      if (swap.error) throw swap.error
      attempt.log(`SWAPPED ${commit}`)
      statuses.push({ phase: 'complete', commit, installed: commit })
    },
    appOpen: () => app.open,
    startAttempt: (commit) => startAttempt({ stateDirectory: repo.state, commit }),
    status: (value) => statuses.push(value),
    notify: (summary, body) => notices.push(`${summary}: ${body}`),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    quietMs: 20,
    pollMs: 5
  }
  const live = () => readFileSync(join(repo.folders.live, 'bmn'), 'utf8').trim()
  const phase = () => statuses.at(-1)
  const offered = () => statuses.filter((value) => value.phase === 'waiting-for-exit').map((value) => value.commit)
  return { io, app, statuses, notices, built, live, phase, offered, open: (commit) => gateFor(commit).open() }
}

const logOf = (repo, commit) => attemptLogs(repo.state).map((name) => readFileSync(join(repo.state, 'attempts', name), 'utf8'))
  .filter((text) => text.includes(`ATTEMPT commit ${commit}`))

describe('a queued update while BMN stays open (Story 134.2)', { timeout: 30_000 }, () => {
  it('offers the restart only after A passed; B and then C withdraw it until C passed; at exit C goes live (AC2)', async () => {
    const repo = repository()
    const a = repo.push('A')
    const run = harness(repo)
    const done = superviseUpdate(run.io)

    await until(() => run.phase()?.phase === 'preparing' && run.phase().commit === a, 'A to build')
    expect(run.offered()).toEqual([])
    expect(run.live()).toBe('build of the installed commit')
    run.open(a)
    await until(() => run.phase()?.phase === 'waiting-for-exit', 'A to be offered')
    expect(run.phase()).toMatchObject({ phase: 'waiting-for-exit', commit: a, staged: a })
    expect(run.notices).toContain(`BMN update ready: ${a.slice(0, 7)} passed its checks. Restart BMN to use it.`)
    expect(run.live()).toBe('build of the installed commit')

    const b = repo.push('B')
    await until(() => run.phase()?.phase === 'preparing' && run.phase().commit === b, 'B to withdraw the offer')
    expect(run.phase()).toMatchObject({ phase: 'preparing', commit: b, staged: a })
    const c = repo.push('C')
    run.open(b)
    await until(() => run.phase()?.phase === 'preparing' && run.phase().commit === c, 'C to supersede B')
    expect(logOf(repo, b)[0]).toMatch(/SUPERSEDED HEAD moved from .* to /u)
    expect(run.offered()).toEqual([a])
    run.open(c)
    await until(() => run.offered().at(-1) === c, 'C to be offered')
    expect(run.live()).toBe('build of the installed commit')

    run.app.open = false
    expect(await done).toEqual({ installed: c })
    expect(run.live()).toBe(`build of ${c}`)
    expect(readFileSync(join(repo.folders.prev, 'bmn'), 'utf8')).toBe('build of the installed commit\n')
    expect(run.offered()).toEqual([a, c])
    expect(run.built).toEqual([a, b, c])
  })

  it('when BMN exits while B builds, the passed A goes live; B builds again and waits for the next restart (D1)', async () => {
    const repo = repository()
    const a = repo.push('A')
    const run = harness(repo)
    run.open(a)
    const done = superviseUpdate(run.io)
    await until(() => run.offered().includes(a), 'A to be offered')
    const b = repo.push('B')
    await until(() => run.phase()?.commit === b, 'B to build')

    // He quits BMN (or restarts it) while B is still being packaged.
    run.app.open = false
    await until(() => run.statuses.some((value) => value.phase === 'complete' && value.commit === a), 'A to go live')
    expect(run.live()).toBe(`build of ${a}`)
    expect(logOf(repo, b)[0]).toContain(`STOPPED BMN exited, so ${a.slice(0, 7)} goes live first`)
    // He is back in BMN, now on A; B is built again and offered for the next restart.
    run.app.open = true
    await until(() => run.built.filter((commit) => commit === b).length === 2, 'B to build again')
    expect(run.phase()).toMatchObject({ phase: 'preparing', commit: b, staged: null, installed: a })
    run.open(b)
    await until(() => run.offered().at(-1) === b, 'B to be offered')
    expect(run.live()).toBe(`build of ${a}`)
    run.app.open = false
    expect(await done).toEqual({ installed: b })
    expect(run.live()).toBe(`build of ${b}`)
  })

  it('a failed B keeps its log and never goes live; A is offered again and goes live at exit', async () => {
    const repo = repository()
    const a = repo.push('A')
    const failing = new Set()
    const run = harness(repo, { failing })
    run.open(a)
    const done = superviseUpdate(run.io)
    await until(() => run.offered().includes(a), 'A to be offered')
    const pushed = repo.push('B')
    failing.add(pushed)
    run.open(pushed)
    await until(() => run.offered().length === 2, 'A to be offered again')
    expect(logOf(repo, pushed)[0]).toMatch(/FAILED at packaged smoke test: packaged self-test exited 1/u)
    expect(run.notices.at(-1)).toContain(`${pushed.slice(0, 7)} failed at packaged smoke test; ${a.slice(0, 7)} still waits for your restart`)
    expect(readFileSync(join(repo.folders.ready, 'bmn'), 'utf8')).toBe(`build of ${a}\n`)
    run.app.open = false
    expect(await done).toEqual({ installed: a })
    expect(run.live()).toBe(`build of ${a}`)
    expect(run.statuses.some((value) => value.phase === 'waiting-for-exit' && value.commit === pushed)).toBe(false)
  })

  it('a failed first build is reported with its step and log before any restart is offered; the live build is untouched (AC1)', async () => {
    const repo = repository()
    const a = repo.push('A')
    const run = harness(repo, { failing: new Set([a]) })
    run.open(a)
    const failure = await superviseUpdate(run.io).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.step).toBe('packaged smoke test')
    expect(failure.attempt.commit).toBe(a)
    expect(readFileSync(failure.attempt.path, 'utf8')).toContain('START packaged smoke test')
    expect(run.offered()).toEqual([])
    expect(run.live()).toBe('build of the installed commit')
    expect(readlinkSync(join(repo.state, 'latest.log'))).toBe(join('attempts', attemptLogs(repo.state).at(-1)))
  })

  it('never puts live a build whose checkout became dirty while it was built (102.9)', async () => {
    const repo = repository()
    const a = repo.push('A')
    const run = harness(repo)
    const done = superviseUpdate(run.io).catch((error) => error)
    await until(() => run.phase()?.commit === a, 'A to build')
    writeFileSync(join(repo.checkout, 'version.txt'), 'edited during the build\n')
    run.open(a)
    const failure = await done
    expect(failure.message).toBe('source changed during the build, so the old build stays live: working tree is not clean')
    expect(failure.step).toBe('source check')
    expect(logOf(repo, a)[0]).toContain('SUPERSEDED working tree is not clean')
    expect(run.offered()).toEqual([])
    expect(existsSync(repo.folders.ready)).toBe(false)
    expect(run.live()).toBe('build of the installed commit')
  })

  it('refuses at once when the checkout is not a clean pushed main, writing no offer', async () => {
    const repo = repository()
    repo.push('A')
    writeFileSync(join(repo.checkout, 'version.txt'), 'dirty\n')
    const run = harness(repo)
    const failure = await superviseUpdate(run.io).catch((error) => error)
    expect(failure.message).toBe('working tree is not clean')
    expect(failure.step).toBe('source check')
    expect(run.statuses).toEqual([])
    expect(run.built).toEqual([])
  })
})
