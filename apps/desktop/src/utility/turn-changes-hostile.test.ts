// MODULE: turn-changes-hostile.test.ts - a repository whose settings name a program for everything Git can run, captured twice under a system-call trace: nothing ran, nothing was written there, nothing connected (R69-NFR2, Story 69.2)
//
// A marker file that is missing does not show that nothing ran, so every process of the two captures is
// traced. Two controls keep the test honest: ordinary Git commands in a copy do run the programs, and
// a process that writes, starts a program and connects is seen doing each by the same reading.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TurnRefusal } from './turn-changes-capture'
import { compareCaptures, fileDifference, type TurnComparison, type TurnDifference } from './turn-changes-compare'
import { TURN_GIT_COMMANDS, TURN_GIT_OPTIONS, type TurnGitCall } from './turn-changes-git'
import { TurnStore, type TurnCaptureRecord } from './turn-changes-store'
import { GIT, hostileSettings, rows, scratch, snapshot, unequal, write, type Place } from './test-fixtures/turn-changes/fixtures'
import { STRACE, canTrace, readTrace, traced, type Trace, type TracedWrite } from './test-fixtures/turn-changes/trace'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures/turn-changes')

interface TracedResult {
  first: string
  second: string | null
  one: TurnCaptureRecord | null
  two: TurnCaptureRecord | null
  compared: TurnComparison | TurnRefusal | null
  differences: Record<string, TurnDifference | TurnRefusal> | null
  calls: TurnGitCall[]
}

interface Run {
  place: Place
  /** Markers the first control left: ordinary Git commands in a copy of the repository. */
  fired: string[]
  /** The second control: what the same reading sees of a process that does what a capture must not. */
  control: { trace: Trace; writes: TracedWrite[] }
  code: number | null
  errors: string
  result: TracedResult | null
  markers: string[]
  trace: Trace
  resultFile: string
  before: Record<string, string>
  atPause: Record<string, string> | null
  afterSwap: Record<string, string> | null
  afterRun: Record<string, string>
}

/** What ordinary Git must be seen to run in the control, or the fixture is not hostile. */
const CLASSES: Record<string, RegExp> = {
  fsmonitor: /^a-(included-)?fsmonitor$/,
  'process filter': /^a-process$/,
  'clean filter': /^a-clean$/,
  'external diff': /^a-(external-diff|diff-command)$/,
  textconv: /^a-textconv$/,
  hook: /^a-hook-(pre-commit|post-commit|reference-transaction)$/,
  'automatic maintenance': /^a-hook-pre-auto-gc$/,
  'fetch of a missing object': /^a-upload-pack$/,
  alias: /^a-alias$/
}

async function hostileRun(): Promise<Run> {
  const place = scratch('hostile', { commit: false })
  const { repo, git, base, home } = place
  // Committed before any filter is named, so building the fixture runs none of them.
  write(repo, '.gitattributes', '* filter=evil diff=evil merge=evil\n')
  write(repo, 'README.md', 'made-up v1\n')
  write(repo, 'src/app.js', 'let a = 1\nlet b = 2\n')
  write(repo, 'data.bin', Buffer.from([0, 1, 2, 3]))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'one')
  write(repo, 'README.md', 'made-up v2\n')
  git(repo, 'commit', '-qam', 'two')
  for (let n = 0; n < 12; n += 1) {
    write(repo, 'churn.txt', `${n}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', `churn ${n}`)
  }
  // Two loose objects whose names begin with 17, the folder Git counts to decide on automatic maintenance (`gc.auto = 1`).
  for (let n = 0, found = 0; found < 2; n += 1) {
    const body = `padding ${n}\n`
    if (!createHash('sha1').update(`blob ${body.length}\0${body}`).digest('hex').startsWith('17')) continue
    execFileSync(GIT, ['hash-object', '-w', '--stdin'], { cwd: repo, input: body, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
    found += 1
  }
  // A missing object: the first README, now only in history, is deleted from the object folder.
  const old = git(repo, 'rev-parse', 'HEAD~13:README.md').trim()
  unlinkSync(join(repo, '.git/objects', old.slice(0, 2), old.slice(2)))
  const A = hostileSettings(place, 'a-')
  writeFileSync(join(repo, '.git/config'), A.settings)

  // The first control: the same repository, copied, under ordinary Git commands.
  const copy = join(base, 'control')
  execFileSync('/bin/cp', ['-a', repo, copy])
  const plain = (...args: string[]): void => {
    try {
      execFileSync(GIT, args, {
        cwd: copy, stdio: ['ignore', 'ignore', 'ignore'], timeout: 20_000,
        env: {
          PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'Made Up', GIT_AUTHOR_EMAIL: 'made@example.test', GIT_COMMITTER_NAME: 'Made Up', GIT_COMMITTER_EMAIL: 'made@example.test'
        }
      })
    } catch {
      // A hostile setting may make the command fail; the markers are what counts.
    }
  }
  writeFileSync(join(copy, 'src/app.js'), 'let a = 1\nlet b = 3\n')
  // The process filter answers nothing a real one would, so Git stops at it; after the first two commands the copy's
  // settings lose that one line, so the clean filter and everything behind it is reached.
  plain('status')
  plain('add', '-A')
  plain('config', '--unset', 'filter.evil.process')
  plain('diff')
  plain('log', '-p', '-1', '--textconv', 'HEAD')
  plain('add', '-A')
  plain('commit', '-qm', 'control')
  plain('cat-file', '-p', old)
  plain('st')
  const fired = existsSync(A.ran) ? readdirSync(A.ran).sort() : []
  rmSync(A.ran, { recursive: true, force: true })
  mkdirSync(A.ran)
  rmSync(copy, { recursive: true, force: true })

  // The second control: a process that does write, start a program and connect, under the same trace.
  const env = { PATH: '/usr/bin:/bin', HOME: home }
  const controlTrace = join(base, 'control-trace.txt')
  const controlFolder = join(base, 'control-folder')
  mkdirSync(controlFolder)
  await traced(process.execPath, [join(fixtures, 'traced-control.mjs'), controlFolder], { traceFile: controlTrace, cwd: base, env, stdio: ['ignore', 'ignore', 'ignore'] }).done
  const controlSeen = readTrace(controlTrace, base)
  const control = { trace: controlSeen, writes: controlSeen.writes.filter((row) => row.paths.some((path) => path.startsWith(`${controlFolder}/`))) }
  rmSync(controlFolder, { recursive: true, force: true })

  // The two captures, traced, with the settings replaced and one file edited in between.
  const resultFile = join(base, 'result.json')
  writeFileSync(join(base, 'spec.json'), JSON.stringify({ repo, home, dataRoot: place.dataRoot, result: resultFile }))
  const before = snapshot(repo)
  const traceFile = join(base, 'trace.txt')
  const run = traced(process.execPath, ['--import', pathToFileURL(join(fixtures, 'ts-resolve.mjs')).href, join(fixtures, 'traced-capture.ts'), join(base, 'spec.json')],
    { traceFile, cwd: base, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  run.child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8')
  })
  let atPause: Record<string, string> | null = null
  let afterSwap: Record<string, string> | null = null
  if (!run.child.stdout) throw new Error('the traced capture has no output to read')
  for await (const line of createInterface({ input: run.child.stdout })) {
    if (line !== 'PAUSE') continue
    atPause = snapshot(repo)
    const B = hostileSettings(place, 'b-', '\tuntrackedCache = true\n\tsplitIndex = true\n')
    writeFileSync(join(repo, '.git/config.new'), B.settings.replace(/fsmonitor = .*\n/, 'fsmonitor = true\n'))
    renameSync(join(repo, '.git/config.new'), join(repo, '.git/config'))
    writeFileSync(join(repo, 'src/app.js'), 'let a = 1\nlet b = 3\nlet c = 4\n')
    afterSwap = snapshot(repo)
    run.child.stdin?.write('GO\n')
  }
  const code = await run.done
  return {
    place, fired, control, code, errors, resultFile, before, atPause, afterSwap,
    result: existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, 'utf8')) as TracedResult) : null,
    markers: readdirSync(A.ran),
    trace: readTrace(traceFile, base),
    afterRun: snapshot(repo)
  }
}

describe.skipIf(process.platform !== 'linux')('a hostile repository, captured twice under a trace', () => {
  let run: Run
  beforeAll(async () => {
    // Without the trace nothing below is shown, so a computer that cannot trace fails here; it is never passed over.
    if (!canTrace()) throw new Error(`this test needs ${STRACE} and the right to trace its own children`)
    run = await hostileRun()
  }, 240_000)
  afterAll(() => run?.place.done())

  const inRepo = (path: string): boolean => path === run.place.repo || path.startsWith(`${run.place.repo}/`)
  const gits = (): Trace['programs'] => run.trace.programs.filter((row) => row.path === GIT)

  it('the fixture is hostile: ordinary Git commands in a copy run its programs', () => {
    const silent = Object.entries(CLASSES).filter(([, pattern]) => !run.fired.some((name) => pattern.test(name))).map(([name]) => name)
    expect(silent, `markers: ${run.fired.join(', ')}`).toEqual([])
  })

  it('the trace is read rightly: a write, a rename, another program and a connection are each seen', () => {
    expect(run.control.writes.some((row) => row.call.startsWith('open'))).toBe(true)
    expect(run.control.writes.some((row) => row.call.startsWith('rename'))).toBe(true)
    expect(run.control.trace.programs.map((row) => row.path)).toContain('/usr/bin/true')
    expect(run.control.trace.connections.length).toBeGreaterThanOrEqual(1)
    expect(run.control.trace.sockets.length).toBeGreaterThanOrEqual(1)
    expect(run.control.trace.unparsed).toEqual([])
  })

  it('both captures are whole and their difference is the known edit', () => {
    expect({ code: run.code, first: run.result?.first, second: run.result?.second }, run.errors).toEqual({ code: 0, first: 'whole', second: 'whole' })
    const compared = run.result?.compared
    if (!compared || compared.state !== 'compared') throw new Error(`not compared: ${JSON.stringify(compared)}`)
    expect(rows(compared)).toMatchObject({ 'src/app.js': { state: 'changed', added: 2, removed: 1 } })
    expect(Object.keys(rows(compared))).toEqual(['src/app.js'])
  })

  it('no program named by the repository ran: no marker, and the only programs started are node and Git', () => {
    expect(run.markers).toEqual([])
    expect(run.trace.unparsed).toEqual([])
    expect(run.trace.programs.filter((row) => row.path === process.execPath)).toHaveLength(1)
    expect(run.trace.programs.filter((row) => row.path !== process.execPath && row.path !== GIT).map((row) => row.path)).toEqual([])
    expect(gits().length).toBeGreaterThan(0)
    expect(gits().filter((row) => row.failed)).toEqual([])
  })

  it('every Git process is one the capture started, on the command list, with exactly its options and environment', () => {
    const listed = (run.result?.calls ?? []).map((call) => JSON.stringify([call.argv, Object.entries(call.env).map(([name, value]) => `${name}=${value}`).sort()]))
    const seen = gits().map((row) => JSON.stringify([row.argv.slice(1), [...row.env].sort()]))
    expect([...seen].sort()).toEqual([...listed].sort())
    const allowed = new Set(Object.values(TURN_GIT_COMMANDS).map((command) => command.join(' ')))
    for (const row of gits()) {
      expect(row.argv.slice(1, 1 + TURN_GIT_OPTIONS.length)).toEqual([...TURN_GIT_OPTIONS])
      expect(row.argv[1 + TURN_GIT_OPTIONS.length]).toBe('-C')
      expect(allowed.has(row.argv.slice(1 + TURN_GIT_OPTIONS.length + 2).join(' ')), row.argv.join(' ')).toBe(true)
    }
  })

  it('no connection is tried and no socket is made', () => {
    expect(run.trace.connections).toEqual([])
    expect(run.trace.sockets).toEqual([])
  })

  it('nothing is written under the repository at any moment; what is written lies under BMN\'s data root', () => {
    expect(run.trace.writes.filter((row) => row.paths.some(inRepo)).map((row) => row.line)).toEqual([])
    const elsewhere = (path: string): boolean =>
      !(path === run.place.dataRoot || path.startsWith(`${run.place.dataRoot}/`) || path === run.resultFile || path === '/dev/null' || path.startsWith('/dev/pts/') || path.startsWith('/proc/'))
    const written = run.trace.writes.filter((row) => !row.failed)
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((row) => row.paths.some(elsewhere)).map((row) => row.line)).toEqual([])
  })

  it('the repository is equal byte for byte before and after each capture: files, index, refs, settings, objects', () => {
    expect(Object.keys(run.before).length).toBeGreaterThan(40)
    expect(run.atPause).not.toBeNull()
    expect(run.afterSwap).not.toBeNull()
    expect(unequal(run.before, run.atPause ?? {})).toEqual([])
    expect(unequal(run.afterSwap ?? {}, run.afterRun)).toEqual([])
    // The reading itself tells a change: the swap between the captures is seen.
    expect(unequal(run.atPause ?? {}, run.afterSwap ?? {})).toEqual(expect.arrayContaining(['.git/config', 'src/app.js']))
  })

  it('the comparison and every difference read whole from the store after the repository is moved, then deleted', () => {
    const { one, two, compared, differences } = run.result ?? {}
    if (!one || !two || !compared || compared.state !== 'compared' || !differences) throw new Error('the traced run left no captures')
    const store = new TurnStore(run.place.dataRoot, 's-hostile', one.root)
    const read = (): unknown => {
      const again = compareCaptures(store, one.id, two.id)
      if (again.state !== 'compared') throw new Error(`${again.state}: ${again.reason}`)
      return [again.files, again.files.map((row) => fileDifference(store, one.id, two.id, row.path))]
    }
    const expected = [compared.files, compared.files.map((row) => differences[row.path])]
    renameSync(run.place.repo, `${run.place.repo}.moved`)
    expect(JSON.parse(JSON.stringify(read()))).toEqual(expected)
    rmSync(`${run.place.repo}.moved`, { recursive: true, force: true })
    expect(existsSync(run.place.repo)).toBe(false)
    expect(JSON.parse(JSON.stringify(read()))).toEqual(expected)
  })
})
