// MODULE: session-command.test.ts - Story 60.13: a command is typed into a new session only while its shell reads a command line, and its end is told once
import { describe, expect, it } from 'vitest'
import { lineReading, sessionCommandRun, takesPress, type CommandPress } from './session-command'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const READS = '\x1b[?2004h'
const TOOK = '\x1b[?2004l'

/** A clock the test moves by hand. */
function clock(): { set(run: () => void, ms: number): unknown; clear(timer: unknown): void; pass(ms: number): void } {
  const timers = new Map<number, { at: number; run: () => void }>()
  let now = 0
  let next = 1
  return {
    set(run, ms) { timers.set(next, { at: now + ms, run }); return next++ },
    clear(timer) { timers.delete(timer as number) },
    pass(ms) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run()
    }
  }
}

/** One run with what it typed and whether its end was told. */
function start(command = '/opt/codex update'): { run: ReturnType<typeof sessionCommandRun>; typed: string[]; ended: () => boolean; time: ReturnType<typeof clock> } {
  const time = clock()
  const run = sessionCommandRun(command, { readyWithinMs: 10_000, watchForMs: 60_000 }, time)
  let over = false
  void run.ended.then(() => { over = true })
  return { run, typed: [], ended: () => over, time }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('reading a shell\'s output for its command lines (60.13)', () => {
  it('finds each time the shell starts to read a line and each time it took one, across chunks', () => {
    const follow = lineReading()
    expect(follow(bytes(`${READS}$ `))).toEqual([true])
    expect(follow(bytes(`echo done\r\n${TOOK}\rdone\r\n${READS}$ `))).toEqual([false, true])
    // Cut anywhere, even inside the sign.
    const cut = lineReading()
    expect([...bytes(`a${READS}b${TOOK}`)].flatMap((byte) => cut(Uint8Array.of(byte)))).toEqual([true, false])
  })

  it('takes nothing else for the sign: other modes, a broken start, a question a start-up file asks', () => {
    const follow = lineReading()
    expect(follow(bytes('startup asks: \x1b[?1004h\x1b[?200\x1b[?25h\x1b[?2004;1004h\x1b[2004h 2004h'))).toEqual([])
    // An escape that breaks one sign starts the next.
    expect(follow(bytes(`\x1b[?20${READS}`))).toEqual([true])
  })
})

describe('typing a command into a new session (60.13)', () => {
  it('types it with its Enter at once where the shell already reads, also when that was written before the session was named', async () => {
    const { run, typed } = start()
    run.output('other', bytes('noise'))
    run.output('a1', bytes(`${READS}$ `))
    const went = run.typeInto('a1', (sent) => typed.push(new TextDecoder().decode(sent)))
    expect(typed).toEqual(['/opt/codex update\r'])
    expect(await went).toBe(true)
  })

  it('waits for the shell to read, and types nothing into a shell that only asked a question', async () => {
    const { run, typed, time } = start()
    const went = run.typeInto('a1', (sent) => typed.push(new TextDecoder().decode(sent)))
    run.output('a1', bytes('Welcome\r\n'))
    run.output('a2', bytes(`${READS}$ `))
    time.pass(9_000)
    expect(typed).toEqual([])
    run.output('a1', bytes(`${READS}$ `))
    expect(typed).toEqual(['/opt/codex update\r'])
    expect(await went).toBe(true)

    const asked = start()
    const stuck = asked.run.typeInto('a1', (sent) => asked.typed.push(new TextDecoder().decode(sent)))
    asked.run.output('a1', bytes('startup asks: '))
    asked.time.pass(10_000)
    expect(await stuck).toBe(false)
    // Ready too late: the owner was already told nothing was typed, so nothing is.
    asked.run.output('a1', bytes(`${READS}$ `))
    asked.time.pass(120_000)
    await settle()
    expect(asked.typed).toEqual([])
    expect(asked.ended()).toBe(false)
  })

  it('types nothing where the shell took a line of its own or the session ended first', async () => {
    const taken = start()
    taken.run.output('a1', bytes(`${READS}$ x\r\n${TOOK}`))
    const busy = taken.run.typeInto('a1', (sent) => taken.typed.push(new TextDecoder().decode(sent)))
    expect(taken.typed).toEqual([])
    taken.time.pass(10_000)
    expect(await busy).toBe(false)

    const before = start()
    before.run.exit('a1')
    expect(await before.run.typeInto('a1', (sent) => before.typed.push(new TextDecoder().decode(sent)))).toBe(false)
    const during = start()
    const waiting = during.run.typeInto('a1', (sent) => during.typed.push(new TextDecoder().decode(sent)))
    during.run.exit('a2')
    during.run.exit('a1')
    expect(await waiting).toBe(false)
    expect([before.typed, during.typed]).toEqual([[], []])
  })

  it('types nothing once the owner went away, whether before the session was named or while its shell was awaited, and changes nothing once it was typed', async () => {
    const early = start()
    early.run.leave()
    early.run.output('a1', bytes(READS))
    expect(await early.run.typeInto('a1', (sent) => early.typed.push(new TextDecoder().decode(sent)))).toBe(false)

    const waiting = start()
    const went = waiting.run.typeInto('a1', (sent) => waiting.typed.push(new TextDecoder().decode(sent)))
    waiting.run.leave()
    expect(await went).toBe(false)
    // The shell gets ready a moment later, as it would once the owner answers its question himself.
    waiting.run.output('a1', bytes(`${READS}$ `))
    waiting.time.pass(120_000)
    await settle()
    expect([early.typed, waiting.typed, waiting.ended()]).toEqual([[], [], false])

    const typed = start()
    typed.run.output('a1', bytes(READS))
    await typed.run.typeInto('a1', (sent) => typed.typed.push(new TextDecoder().decode(sent)))
    // Preferences steps aside once the command runs, which closes the sheet: the end is still told.
    typed.run.leave()
    typed.run.output('a1', bytes(`${TOOK}done\r\n${READS}`))
    await settle()
    expect([typed.typed, typed.ended()]).toEqual([['/opt/codex update\r'], true])
  })

  it('answers that nothing was typed where the session cannot be typed into, and does not fail the output it was called from', async () => {
    const { run, ended, time } = start()
    const went = run.typeInto('a1', () => { throw new Error('The terminal byte channel is unavailable') })
    expect(() => run.output('a1', bytes(READS))).not.toThrow()
    expect(await went).toBe(false)
    time.pass(120_000)
    await settle()
    expect(ended()).toBe(false)
  })

  it('tells the end once: when the shell reads again, not when it took the line, and not for another session', async () => {
    const { run, typed, ended } = start()
    run.output('a1', bytes(`${READS}$ `))
    await run.typeInto('a1', (sent) => typed.push(new TextDecoder().decode(sent)))
    run.output('a1', bytes(`/opt/codex update\r\n${TOOK}\rUpdating…\r\n`))
    run.output('a2', bytes(`${READS}$ `))
    run.exit('a2')
    await settle()
    expect(ended()).toBe(false)
    run.output('a1', bytes(`done\r\n${READS}$ `))
    await settle()
    expect(ended()).toBe(true)
    expect(typed).toEqual(['/opt/codex update\r'])
  })

  it('tells the end when the session ends or the watch runs out', async () => {
    const closed = start()
    closed.run.output('a1', bytes(READS))
    await closed.run.typeInto('a1', () => {})
    closed.run.exit('a1')
    await settle()
    expect(closed.ended()).toBe(true)

    const long = start()
    long.run.output('a1', bytes(READS))
    await long.run.typeInto('a1', () => {})
    long.time.pass(59_000)
    await settle()
    expect(long.ended()).toBe(false)
    long.time.pass(1_000)
    await settle()
    expect(long.ended()).toBe(true)
  })

  it('lets the button be pressed once, and again only where no session could be opened', () => {
    const presses: CommandPress[] = ['idle', 'opening', 'typed', 'not-reading', 'failed']
    expect(presses.filter(takesPress)).toEqual(['idle', 'failed'])
  })
})
