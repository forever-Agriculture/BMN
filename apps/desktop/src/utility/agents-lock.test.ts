// MODULE: agents-lock.test.ts - Epic 64: the lock that never removes a name another process may hold, and the supervisor that ends a run when BMN's own process ends
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { takeLock } from '../../bin/agents-research.mjs'
import { NOTHING_STARTED, processLives, processStart, startSupervised, supervisorScript, type ProcessIdentity } from '../../bin/agents-supervised.mjs'

const BIN = fileURLToPath(new URL('../../bin/', import.meta.url))
/** A holder's record whose process is long gone. */
const GONE = { version: 1, kind: 'writer', id: 'gone', pid: 2 ** 22 + 7, start: '1' }

let folder: string
let path: string

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-lock-')))
  path = join(folder, 'lock')
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const numbers = (): number[] => readdirSync(folder).filter((name) => /^lock\.[1-9]\d*$/.test(name)).map((name) => Number(name.slice(5))).sort((one, other) => one - other)
const held = (number: number): Record<string, unknown> => JSON.parse(readFileSync(`${path}.${number}`, 'utf8'))
const alive = (pid: number): boolean => existsSync(`/proc/${pid}`) && !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const until = async (done: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await wait(10)
}

describe('the lock (64.1 AC6, AC8)', () => {
  it('is one holder\'s for as long as it lives, and is freed for good by its release', () => {
    const first = takeLock(path, { kind: 'writer', id: 'first' })
    expect(first.held).toBeUndefined()
    expect(numbers()).toEqual([1])
    expect(takeLock(path, { kind: 'writer', id: 'second' }).held).toMatchObject({ kind: 'writer', id: 'first', pid: process.pid })
    expect(numbers()).toEqual([1])
    first.note!({ seen: 'yes' })
    expect(held(1)).toMatchObject({ id: 'first', seen: 'yes' })
    first.release!()
    // The file stays and says released: nobody ever removes the highest number.
    expect(numbers()).toEqual([1])
    expect(held(1)).toMatchObject({ id: 'first', released: true })
    // Nothing brings a released lock back.
    expect(() => first.note!({ again: true })).toThrow(/no longer this process's own/)
    expect(() => first.app!({ pid: process.pid, start: processStart(process.pid)! })).toThrow(/no longer this process's own/)
    expect(held(1)).toMatchObject({ released: true })
    const third = takeLock(path, { kind: 'writer', id: 'third' })
    expect(third.held).toBeUndefined()
    expect(numbers()).toEqual([2])
    first.release!()
    expect(takeLock(path, { kind: 'writer', id: 'fourth' }).held).toMatchObject({ id: 'third' })
  })

  it('takes over from a holder that has ended, from text that is no record, and clears away only what lies below its own number', () => {
    writeFileSync(`${path}.1`, 'not a record')
    writeFileSync(`${path}.2`, JSON.stringify(GONE))
    const steps: string[] = []
    const lock = takeLock(path, { kind: 'writer', id: 'next' }, { seam: (step) => { steps.push(`${step}:${numbers().join(',')}`) } })
    expect(lock.held).toBeUndefined()
    // Its own file is made above the others before anything is cleared, and clearing comes last.
    expect(steps).toEqual(['read:1,2', 'made:1,2,3', 'taken:1,2,3', 'cleared:3'])
    expect(held(3)).toMatchObject({ id: 'next', pid: process.pid })
  })

  it('is held while a supervisor its holder named lives, also when the holder is gone', () => {
    writeFileSync(`${path}.4`, JSON.stringify({ ...GONE, apps: [{ pid: 2 ** 22 + 9, start: '1' }, { pid: process.pid, start: processStart(process.pid) }] }))
    expect(takeLock(path, { kind: 'writer' }).held).toMatchObject({ id: 'gone' })
    writeFileSync(`${path}.4`, JSON.stringify({ ...GONE, apps: [{ pid: 2 ** 22 + 9, start: '1' }] }))
    expect(takeLock(path, { kind: 'writer' }).held).toBeUndefined()
    expect(numbers()).toEqual([5])
  })

  it('holds from the moment its file is made: a taker that comes then finds it held', () => {
    let late: ReturnType<typeof takeLock> | null = null
    const lock = takeLock(path, { kind: 'writer', id: 'early' }, { seam: (step) => { if (step === 'made') late = takeLock(path, { kind: 'writer', id: 'late' }) } })
    expect(lock.held).toBeUndefined()
    expect(late!.held).toMatchObject({ id: 'early' })
    expect(numbers()).toEqual([1])
  })

  it('gives nothing to a taker that read the lock long ago: the number it finds free below the highest holds nothing', () => {
    writeFileSync(`${path}.5`, JSON.stringify(GONE))
    const highest: number[] = []
    let others: ReturnType<typeof takeLock>[] = []
    const stale = takeLock(path, { kind: 'writer', id: 'stale' }, {
      seam: (step) => {
        highest.push(numbers().at(-1) ?? 0)
        if (step !== 'read' || others.length > 0) return
        // It stands still between reading the dead lock and making its own file. Meanwhile one holder comes and goes, and another comes and stays.
        const came = takeLock(path, { kind: 'writer', id: 'came-and-went' })
        came.release!()
        const stays = takeLock(path, { kind: 'writer', id: 'stays' })
        others = [came, stays]
        // Number 6 is gone again: the stale taker's own file will fit there.
        expect(numbers()).toEqual([7])
      }
    })
    expect(stale.held).toMatchObject({ id: 'stays' })
    // Its file at 6 was made and given up; the holder at 7 never lost the lock.
    expect(numbers()).toEqual([7])
    expect(held(7)).toMatchObject({ id: 'stays' })
    expect(highest).toEqual([...highest].sort((one, other) => one - other))
    others[1]!.note!({ still: 'mine' })
    expect(held(7)).toMatchObject({ id: 'stays', still: 'mine' })
    others[1]!.release!()
    expect(takeLock(path, { kind: 'writer', id: 'after' }).held).toBeUndefined()
    expect(numbers()).toEqual([8])
  })

  it('takes nothing where the lock cannot be read: that is not the same as free', () => {
    mkdirSync(`${path}.3`)
    expect(takeLock(path, { kind: 'writer' }).held).toEqual({ version: 1, kind: 'research' })
    expect(numbers()).toEqual([3])
    if (process.getuid?.() === 0) return
    writeFileSync(`${path}.4`, JSON.stringify(GONE))
    chmodSync(`${path}.4`, 0)
    expect(takeLock(path, { kind: 'writer' }).held).toEqual({ version: 1, kind: 'research' })
    expect(numbers()).toEqual([3, 4])
    // Numbers are whole decimal numbers written one way; anything else beside them is not the lock.
    chmodSync(`${path}.4`, 0o600)
    for (const name of ['lock.05', 'lock.5x', 'lock.-6', 'lock.new-1-abc']) writeFileSync(join(folder, name), JSON.stringify({ version: 1, kind: 'writer', id: 'other', pid: process.pid, start: processStart(process.pid) }))
    expect(takeLock(path, { kind: 'writer', id: 'real' }).held).toBeUndefined()
    // The folder below the lock cannot be cleared away as a file is: it stays there and means nothing.
    expect(numbers()).toEqual([3, 5])
    expect(takeLock(path, { kind: 'writer', id: 'next' }).held).toMatchObject({ id: 'real' })
  })

  it('lets one process at a time inside, across processes that take it thousands of times and some that are killed holding it', async () => {
    const counter = join(folder, 'counter')
    writeFileSync(counter, '0')
    const worker = `
      import { takeLock } from ${JSON.stringify(`${BIN}agents-research.mjs`)}
      import { readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
      const [path, counter, rounds] = process.argv.slice(1)
      const inside = counter + '.inside'
      const lives = (pid) => existsSync('/proc/' + pid)
      for (let round = 0; round < Number(rounds);) {
        const lock = takeLock(path, { kind: 'writer' })
        if (lock.held !== undefined) { await new Promise((resolve) => setTimeout(resolve, 1)); continue }
        // Whoever is inside says so; a second one inside beside a living first is the failure this test looks for.
        if (existsSync(inside) && lives(Number(readFileSync(inside, 'utf8')))) process.exit(3)
        writeFileSync(inside, String(process.pid))
        const value = Number(readFileSync(counter, 'utf8'))
        for (let spin = 0; spin < 20000; spin += 1);
        writeFileSync(counter + '.next-' + process.pid, String(value + 1))
        renameSync(counter + '.next-' + process.pid, counter)
        unlinkSync(inside)
        lock.release()
        process.stdout.write('.')
        round += 1
      }
    `
    const start = (rounds: number): { child: ChildProcess; done: () => number; exit: Promise<number | null> } => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, path, counter, String(rounds)], { stdio: ['ignore', 'pipe', 'inherit'] })
      let dots = 0
      child.stdout!.on('data', (chunk: Buffer) => { dots += chunk.length })
      return { child, done: () => dots, exit: new Promise((resolve) => { child.once('close', (code) => resolve(code)) }) }
    }
    const steady = Array.from({ length: 4 }, () => start(150))
    const doomed = Array.from({ length: 2 }, () => start(100_000))
    let top = 0
    const watch = setInterval(() => {
      const now = numbers().at(-1) ?? 0
      expect(now).toBeGreaterThanOrEqual(top)
      top = now
    }, 5)
    try {
      await until(() => doomed.every((entry) => entry.done() > 20), 20_000)
      for (const entry of doomed) entry.child.kill('SIGKILL')
      const codes = await Promise.all([...steady, ...doomed].map((entry) => entry.exit))
      expect(codes.slice(0, 4)).toEqual([0, 0, 0, 0])
      expect(codes).not.toContain(3)
    } finally {
      clearInterval(watch)
      for (const entry of [...steady, ...doomed]) entry.child.kill('SIGKILL')
    }
    // No update was lost: every round that was reported is in the count, and at most the two killed mid-round are not reported.
    const reported = [...steady, ...doomed].reduce((sum, entry) => sum + entry.done(), 0)
    const count = Number(readFileSync(counter, 'utf8'))
    expect(count).toBeGreaterThanOrEqual(reported)
    expect(count).toBeLessThanOrEqual(reported + 2)
    expect(top).toBeGreaterThan(600)
  }, 120_000)
})

describe('the supervisor of a run (R64-NFR3)', () => {
  /** A command that writes down its process and then stays; with `child` it starts one more process that does the same, and with `deaf` it ignores being asked to end. */
  const stays = (marker: string, { child = null, deaf = false }: { child?: string | null; deaf?: boolean } = {}): string[] => [process.execPath, '-e', `
    const fs = require('node:fs')
    ${deaf ? 'process.on("SIGTERM", () => {})' : ''}
    ${child === null ? '' : `require('node:child_process').spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(child)}], { stdio: 'ignore' })`}
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid))
    setInterval(() => {}, 1000)
  `]
  const supervise = (deadline: number, command: string[]): ChildProcess => spawn(process.execPath, [supervisorScript()!, '--supervise', String(deadline), ...command],
    { cwd: folder, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: true })
  const exit = (child: ChildProcess): Promise<number | null> => new Promise((resolve) => { child.once('close', (code) => resolve(code)) })
  const say = (child: ChildProcess, word: string): void => { (child.stdio[3] as NodeJS.WritableStream).write(`${word}\n`) }
  const hangUp = (child: ChildProcess): void => { (child.stdio[3] as unknown as { destroy(): void }).destroy() }
  const pidIn = (file: string): number => Number(readFileSync(file, 'utf8'))

  it('starts nothing until it is told to, and nothing at all when BMN\'s process ends first', async () => {
    const marker = join(folder, 'started')
    const supervisor = supervise(Date.now() + 60_000, stays(marker))
    const ended = exit(supervisor)
    await wait(300)
    expect(existsSync(marker)).toBe(false)
    expect(alive(supervisor.pid!)).toBe(true)
    // BMN's end of the pipe closes, as it does when its process ends, however it ends.
    hangUp(supervisor)
    expect(await ended).toBe(NOTHING_STARTED)
    expect(existsSync(marker)).toBe(false)
  })

  it('ends the command and everything it started the moment BMN\'s process is gone, and only then ends itself', async () => {
    const marker = join(folder, 'started')
    const second = join(folder, 'started-too')
    const supervisor = supervise(Date.now() + 60_000, stays(marker, { child: second }))
    const ended = exit(supervisor)
    say(supervisor, 'go')
    await until(() => existsSync(marker) && existsSync(second))
    const [command, grandchild] = [pidIn(marker), pidIn(second)]
    expect(alive(command) && alive(grandchild)).toBe(true)
    hangUp(supervisor)
    await ended
    // The supervisor is the last to go: when it has ended, nothing of the run lives.
    expect(alive(command)).toBe(false)
    await until(() => !alive(grandchild), 1000)
    expect(alive(grandchild)).toBe(false)
  })

  it('ends the command at the deadline by itself, with BMN still there and saying nothing', async () => {
    const marker = join(folder, 'started')
    const began = Date.now()
    const supervisor = supervise(began + 500, stays(marker))
    const ended = exit(supervisor)
    say(supervisor, 'go')
    expect(await ended).toBe(128 + 15)
    expect(Date.now() - began).toBeGreaterThanOrEqual(450)
    expect(Date.now() - began).toBeLessThan(3000)
    expect(alive(pidIn(marker))).toBe(false)
    // A run whose time has passed before it was told to go is never started.
    const late = supervise(Date.now() - 1, stays(join(folder, 'late')))
    const lateEnded = exit(late)
    say(late, 'go')
    expect(await lateEnded).toBe(NOTHING_STARTED)
    expect(existsSync(join(folder, 'late'))).toBe(false)
  })

  it('asks a command to end on Stop and makes it where it does not listen', async () => {
    const marker = join(folder, 'started')
    const supervisor = supervise(Date.now() + 60_000, stays(marker, { deaf: true }))
    const ended = exit(supervisor)
    say(supervisor, 'go')
    await until(() => existsSync(marker))
    const began = Date.now()
    say(supervisor, 'stop')
    expect(await ended).toBe(128 + 9)
    expect(Date.now() - began).toBeGreaterThanOrEqual(2500)
    expect(alive(pidIn(marker))).toBe(false)
  }, 15_000)

  it('is written down before the command starts, and starts nothing where that fails', async () => {
    const marker = join(folder, 'started')
    const seen: { identity: ProcessIdentity; lives: boolean; started: boolean }[] = []
    const run = startSupervised(stays(marker), { cwd: folder, stdio: ['ignore', 'ignore', 'ignore'], deadline: Date.now() + 60_000, register: (identity) => { seen.push({ identity, lives: processLives(identity), started: existsSync(marker) }) } })
    expect(run.failed).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ identity: { pid: run.child!.pid }, lives: true, started: false })
    await until(() => existsSync(marker))
    expect(existsSync(marker)).toBe(true)
    const ended = exit(run.child!)
    run.kill!()
    await ended
    expect(alive(pidIn(marker))).toBe(false)
    // The lock's record could not be written: the run is not started, and the caller is told why.
    const refused = startSupervised(stays(join(folder, 'never')), { cwd: folder, stdio: ['ignore', 'ignore', 'ignore'], deadline: Date.now() + 60_000, register: () => { throw new Error('disk full') } })
    expect(refused.failed).toBe('the run was not started, because BMN could not write down its process: disk full')
    expect(await exit(refused.child!)).toBe(NOTHING_STARTED)
    expect(existsSync(join(folder, 'never'))).toBe(false)
  })
})
