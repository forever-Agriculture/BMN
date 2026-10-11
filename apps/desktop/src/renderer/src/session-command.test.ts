// MODULE: session-command.test.ts - Story 60.13: a command is typed into a new session only while its shell reads a line with its line editor, and every later prompt there is told
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

/** One run with what it typed, how often it told that the shell reads again, and whether its session is known to be gone. */
function start(command = '/opt/codex update'): {
  run: ReturnType<typeof sessionCommandRun>; typed: string[]; type: (sent: Uint8Array) => void; heard: () => number; gone: () => boolean; time: ReturnType<typeof clock>
} {
  const time = clock()
  let heard = 0
  let gone = false
  const run = sessionCommandRun(command, { readyWithinMs: 10_000 }, () => { heard += 1 }, time)
  void run.gone.then(() => { gone = true })
  const typed: string[] = []
  return { run, typed, type: (sent) => { typed.push(new TextDecoder().decode(sent)) }, heard: () => heard, gone: () => gone, time }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const DAY_MS = 24 * 60 * 60_000

describe('reading a shell\'s output for the lines it reads (60.13)', () => {
  it('finds each time the shell starts to read a line and each time it took one, across chunks', () => {
    const follow = lineReading()
    expect(follow(bytes(`${READS}$ `))).toEqual([true])
    expect(follow(bytes(`echo done\r\n${TOOK}\rdone\r\n${READS}$ `))).toEqual([false, true])
    // Cut anywhere, even inside the sign.
    const cut = lineReading()
    expect([...bytes(`a${READS}b${TOOK}`)].flatMap((byte) => cut(Uint8Array.of(byte)))).toEqual([true, false])
  })

  it('takes nothing else for the sign: other modes, a broken start, a question a start-up file asks plainly', () => {
    const follow = lineReading()
    expect(follow(bytes('startup asks: \x1b[?1004h\x1b[?200\x1b[?25h\x1b[?2004;1004h\x1b[2004h 2004h'))).toEqual([])
    // An escape that breaks one sign starts the next.
    expect(follow(bytes(`\x1b[?20${READS}`))).toEqual([true])
  })
})

describe('typing a command into a new session (60.13)', () => {
  it('types it with its Enter at once where the shell already reads, also when that was written before the session was named', async () => {
    const { run, typed, type } = start()
    run.output('other', bytes('noise'))
    run.output('a1', bytes(`${READS}$ `))
    const went = run.typeInto('a1', type)
    expect(typed).toEqual(['/opt/codex update\r'])
    expect(await went).toBe(true)
  })

  it('waits for the shell to read, and types nothing into a shell that only asked a question plainly', async () => {
    const { run, typed, type, time } = start()
    const went = run.typeInto('a1', type)
    run.output('a1', bytes('Welcome\r\n'))
    run.output('a2', bytes(`${READS}$ `))
    time.pass(9_000)
    expect(typed).toEqual([])
    run.output('a1', bytes(`${READS}$ `))
    expect(typed).toEqual(['/opt/codex update\r'])
    expect(await went).toBe(true)

    const asked = start()
    const stuck = asked.run.typeInto('a1', asked.type)
    asked.run.output('a1', bytes('startup asks: '))
    asked.time.pass(10_000)
    expect(await stuck).toBe(false)
    // Ready too late: the owner was already told nothing was typed, so nothing is, and nothing is told later.
    asked.run.output('a1', bytes(`${READS}$ `))
    asked.time.pass(DAY_MS)
    await settle()
    expect([asked.typed, asked.heard(), asked.gone()]).toEqual([[], 0, false])
  })

  it('cannot tell a question asked with the line editor from the prompt: it gets the command, which is the limit the sheet names', async () => {
    // What bash writes for a start-up file's `read -e -p "startup asks: "`: the same sign as before its prompt.
    const { run, typed, type, heard } = start()
    run.output('a1', bytes(`${READS}startup asks: `))
    expect(await run.typeInto('a1', type)).toBe(true)
    expect(typed).toEqual(['/opt/codex update\r'])
    // The question takes the line, the start-up file goes on, and the shell's own prompt is told like any later prompt:
    // Health then reads the machine and says what the program reports, which is unchanged.
    run.output('a1', bytes(`/opt/codex update\r\n${TOOK}\r`))
    expect(heard()).toBe(0)
    run.output('a1', bytes(`${READS}$ `))
    expect(heard()).toBe(1)
  })

  it('types nothing where the shell took a line of its own or the session ended first', async () => {
    const taken = start()
    taken.run.output('a1', bytes(`${READS}$ x\r\n${TOOK}`))
    const busy = taken.run.typeInto('a1', taken.type)
    expect(taken.typed).toEqual([])
    taken.time.pass(10_000)
    expect(await busy).toBe(false)

    const before = start()
    before.run.exit('a1')
    expect(await before.run.typeInto('a1', before.type)).toBe(false)
    const during = start()
    const waiting = during.run.typeInto('a1', during.type)
    during.run.exit('a2')
    during.run.exit('a1')
    expect(await waiting).toBe(false)
    await settle()
    expect([before.typed, during.typed, during.heard(), during.gone()]).toEqual([[], [], 0, false])
  })

  it('types nothing once the owner went away, whether before the session was named or while its shell was awaited, and changes nothing once it was typed', async () => {
    const early = start()
    early.run.leave()
    early.run.output('a1', bytes(READS))
    expect(await early.run.typeInto('a1', early.type)).toBe(false)

    const waiting = start()
    const went = waiting.run.typeInto('a1', waiting.type)
    waiting.run.leave()
    expect(await went).toBe(false)
    // The shell gets ready a moment later, as it would once the owner answers its question himself.
    waiting.run.output('a1', bytes(`${READS}$ `))
    waiting.time.pass(DAY_MS)
    await settle()
    expect([early.typed, waiting.typed, waiting.heard()]).toEqual([[], [], 0])

    const typed = start()
    typed.run.output('a1', bytes(READS))
    await typed.run.typeInto('a1', typed.type)
    // Preferences steps aside once the command is typed, which closes the sheet: the next prompt is still told.
    typed.run.leave()
    typed.run.output('a1', bytes(`${TOOK}done\r\n${READS}`))
    expect([typed.typed, typed.heard()]).toEqual([['/opt/codex update\r'], 1])
  })

  it('answers that nothing was typed where the session cannot be typed into, and does not fail the output it was called from', async () => {
    const { run, heard, time } = start()
    const went = run.typeInto('a1', () => { throw new Error('The terminal byte channel is unavailable') })
    expect(() => run.output('a1', bytes(READS))).not.toThrow()
    expect(await went).toBe(false)
    run.output('a1', bytes(`${TOOK}${READS}`))
    time.pass(DAY_MS)
    expect(heard()).toBe(0)
  })

  it('tells each time the shell reads again after the command: not when it took the line, not for another session', async () => {
    const { run, typed, type, heard } = start()
    run.output('a1', bytes(`${READS}$ `))
    await run.typeInto('a1', type)
    run.output('a1', bytes(`/opt/codex update\r\n${TOOK}\rUpdating…\r\n`))
    run.output('a2', bytes(`${READS}$ `))
    run.exit('a2')
    expect(heard()).toBe(0)
    run.output('a1', bytes(`done\r\n${READS}$ `))
    expect(heard()).toBe(1)
    expect(typed).toEqual(['/opt/codex update\r'])
  })

  it('tells the shell\'s own prompt after an updater that drew an input line of its own, however long the update takes', async () => {
    const { run, type, heard, gone, time } = start()
    run.output('a1', bytes(`${READS}$ `))
    await run.typeInto('a1', type)
    // The updater turns bracketed paste on for a question of its own: the same sign, while it still runs.
    run.output('a1', bytes(`${TOOK}\rReplace the installed version? ${READS}`))
    expect(heard()).toBe(1)
    // Hours pass; nothing is told for the time alone, and the watch does not end.
    time.pass(DAY_MS)
    await settle()
    expect([heard(), gone()]).toEqual([1, false])
    run.output('a1', bytes(`y${TOOK}\r\nupdated\r\n${READS}$ `))
    expect(heard()).toBe(2)
    // And any later prompt of that session: BMN cannot know which one ended the update.
    run.output('a1', bytes(`ls\r\n${TOOK}\r${READS}$ `))
    expect(heard()).toBe(3)
  })

  it('tells once more when the session ends, and then has nothing more to hear', async () => {
    const { run, type, heard, gone } = start()
    run.output('a1', bytes(READS))
    await run.typeInto('a1', type)
    run.exit('a1')
    await settle()
    expect([heard(), gone()]).toEqual([1, true])
    run.output('a1', bytes(READS))
    run.exit('a1')
    expect(heard()).toBe(1)
  })

  it('ends a run whose session is not listed any more, and keeps one whose session still is (63.4 AC5)', async () => {
    const kept = start()
    kept.run.output('a1', bytes(READS))
    await kept.run.typeInto('a1', kept.type)
    kept.run.listed(new Set(['a1', 'a2']))
    await settle()
    expect([kept.heard(), kept.gone()]).toEqual([0, false])
    // The host went away: no exit came, and the next list of sessions has none for this run.
    kept.run.listed(new Set(['a2']))
    await settle()
    expect([kept.heard(), kept.gone()]).toEqual([1, true])
    kept.run.listed(new Set())
    expect(kept.heard()).toBe(1)
    // A run that has not been given its session yet is not judged by a list made before it.
    const unnamed = start()
    unnamed.run.listed(new Set())
    unnamed.run.output('b1', bytes(READS))
    expect(await unnamed.run.typeInto('b1', unnamed.type)).toBe(true)
  })

  it('lets the button be pressed once, and again only where no session could be opened', () => {
    const presses: CommandPress[] = ['idle', 'opening', 'typed', 'not-reading', 'failed']
    expect(presses.filter(takesPress)).toEqual(['idle', 'failed'])
  })
})
