// MODULE: conpty-scroll.test.ts - the self-test's SCROLLED sequence typed straight through node-pty, recording where output stops
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { spawn, type IPty } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { codexSixelFrame, NODE_ANIMATION_SOURCE, POSIX_ANIMATION_SCRIPT } from '../main/self-test/animation'
import { powerShellQuote, useStandInLauncher, writeNodeProgram } from '../main/self-test/programs'
import { prepareWindowsPtyLaunch } from './windows-launch'

// The packaged self-test's Windows pane stops printing right after `scroll-79`: no SCROLLED, no prompt, no echo
// of a later line, while BMN's own view and node-pty's output stream sit drained. This replays the same typed
// sequence (Codex-rate then maximum-rate Sixel animation, the scroll line typed at once) on node-pty with a
// headless terminal answering queries as the view does, plus two files the shell writes around SCROLLED.
// Variants change one thing each. Results are associations, not causal proof: a pass means this reduced harness
// did not reproduce, and a failure here is not by itself the packaged defect. At 80x24 with a one-line prompt every
// variant printed SCROLLED natively (run 37341134916: as typed, after the prompt, without images, without the
// launcher, without replies). The packaged pane (46x27, a 90-character prompt that wraps) printed nothing after
// scroll-79 for ~18 s and resumed after a typed probe line; so these variants move toward the pane's size, prompt
// and console host. Unlike the packaged line, this one also writes two marker files around SCROLLED, which can
// change timing; a reproduction here still needs a marker-free replay before it stands for the packaged failure.

const windows = process.platform === 'win32'

interface Variant {
  readonly name: string
  /** The animation runs through a copy of BMN's bmn.exe launcher, as in the self-test (Windows only). */
  readonly launcher: boolean
  /** Sixel frames, or short text in their place. */
  readonly images: boolean
  /** Waits for the prompt after the animation before typing the scroll line. */
  readonly afterPrompt: boolean
  /** The terminal answers the shell's and ConPTY's queries. */
  readonly replies: boolean
  readonly cols: number
  readonly rows: number
  /** Where the shell starts, which sets the prompt's width: the fixture folder (~70 characters on the runner), a
   * deeper folder whose prompt is exactly as wide as the packaged pane's (90 characters), or the drive root (short).
   * A different folder is a possible confound of its own. */
  readonly prompt: 'fixture' | 'matched' | 'short'
  /** BMN's bundled ConPTY, or the console host built into Windows. */
  readonly bundledConpty: boolean
}

const PRODUCTION: Variant = { name: 'as-self-test', launcher: true, images: true, afterPrompt: false, replies: true,
  cols: 80, rows: 24, prompt: 'fixture', bundledConpty: true }
/** The packaged pane: 46x27 with the self-test's 90-character prompt (`PS <cwd>> `). */
const PANE: Variant = { ...PRODUCTION, name: 'pane', cols: 46, rows: 27, prompt: 'matched' }
const PACKAGED_PROMPT_WIDTH = 90
// Most informative first: a variant that would start after the time budget is recorded as skipped.
const WINDOWS_VARIANTS: readonly Variant[] = [
  PRODUCTION,
  PANE,
  { ...PANE, name: 'pane-inbox-conpty', bundledConpty: false },
  { ...PANE, name: 'pane-short-prompt', prompt: 'short' },
  { ...PRODUCTION, name: 'matched-prompt-80-columns', prompt: 'matched' },
  { ...PANE, name: 'pane-after-prompt', afterPrompt: true },
  { ...PANE, name: 'pane-no-images', images: false }
]

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const escaped = (text: string): string =>
  text.replace(/[^\x20-\x7e]/gu, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)

async function until(check: () => boolean, milliseconds: number): Promise<number | null> {
  const started = Date.now()
  while (Date.now() - started < milliseconds) {
    if (check()) return Date.now() - started
    await sleep(25)
  }
  return check() ? Date.now() - started : null
}

/**
 * Runs the sequence once; every wait is bounded and the record carries whatever was observed before a failure.
 * `save` is called as the record grows (before the run, after the observation and after cleanup), so a deadline
 * keeps what was seen.
 */
async function scrollSequence(variant: Variant, save: (record: Record<string, unknown>) => void = () => {}): Promise<Record<string, unknown>> {
  // The long form of the folder: PowerShell prints it in its prompt even where the temp variable holds an 8.3 name.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'bmn-conpty-scroll-')))
  const record: Record<string, unknown> = { ...variant, started: true }
  save(record)
  const terminal = new Terminal({ cols: variant.cols, rows: variant.rows, allowProposedApi: true })
  let pty: IPty | undefined
  let exited: Promise<void> = Promise.resolve()
  let stream = ''
  let bytes = 0
  // Records what the stream held and ends the shell; a failure here is recorded beside the observation, never instead.
  const finish = async (): Promise<void> => {
    const queries: Record<string, number> = {}
    // eslint-disable-next-line no-control-regex
    for (const match of stream.matchAll(/\x1b\[[?>=]?[\d;]*[cn]/gu)) queries[escaped(match[0])] = (queries[escaped(match[0])] ?? 0) + 1
    Object.assign(record, { totalBytes: bytes, queries, firstBytes: escaped(stream.slice(0, 160)), tail: escaped(stream.slice(-300)) })
    if (pty) {
      // Existence only: a live process is not proof that the shell responds.
      try { record.shellProcessExists = (process.kill(pty.pid, 0), true) } catch { record.shellProcessExists = false }
      pty.kill()
      await Promise.race([exited, sleep(5_000)])
    }
    terminal.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  try {
    const frames = variant.images ? [codexSixelFrame(0), codexSixelFrame(1)] : ['[frame 0]', '[frame 1]']
    frames.forEach((frame, index) => writeFileSync(join(root, `frame${index}.six`), frame))
    const before = join(root, 'before-scrolled'), after = join(root, 'after-scrolled')
    let program: string[]
    if (!windows) {
      program = [join(root, 'animate.sh')]
      writeFileSync(program[0]!, POSIX_ANIMATION_SCRIPT, { mode: 0o700 })
    } else if (variant.launcher) {
      program = [writeNodeProgram(root, 'animate', NODE_ANIMATION_SOURCE)]
    } else {
      writeFileSync(join(root, 'animate.cjs'), NODE_ANIMATION_SOURCE)
      program = [process.execPath, join(root, 'animate.cjs')]
    }
    const run = (...args: string[]) => windows
      ? ['&', ...program.map(powerShellQuote), ...args].join(' ')
      : [...program.map((part) => `'${part}'`), ...args].join(' ')
    const animationLine = windows
      ? `Clear-Host; ${run('64', '0.12', 'CODEX-RATE')}; ${run('120', '0.016', 'MAX-RATE')}\r`
      : `clear; ${run('64', '0.12', 'CODEX-RATE')}; ${run('120', '0.016', 'MAX-RATE')}\r`
    const scrollLine = windows
      ? `0..79 | ForEach-Object { "scroll-$_" }; [IO.File]::WriteAllText(${powerShellQuote(before)}, 'x'); ` +
        `Write-Output ('SCROLL' + 'ED'); [IO.File]::WriteAllText(${powerShellQuote(after)}, 'x')\r`
      : `i=0; while [ $i -lt 80 ]; do echo scroll-$i; i=$((i + 1)); done; : > '${before}'; printf '%s%s\\n' SCROLL ED; : > '${after}'\r`

    const environment = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    delete environment.PROMPT_COMMAND
    const size = { cols: variant.cols, rows: variant.rows }
    // `PS <cwd>> ` is the PowerShell prompt; a matched prompt gets a fixture subfolder whose name makes it 90 wide.
    const matchedLength = Math.max(1, PACKAGED_PROMPT_WIDTH - 5 - root.length - 1)
    const matchedName = 'bmn-pane-prompt-'.padEnd(matchedLength, 'x').slice(0, matchedLength)
    const cwd = variant.prompt === 'short' ? (windows ? `${process.env.SystemDrive ?? 'C:'}\\` : '/')
      : variant.prompt === 'matched' ? join(root, matchedName) : root
    // Only a new fixture subfolder is ever created; the drive root is used as it is.
    if (variant.prompt === 'matched') mkdirSync(cwd)
    const prompt = `PS ${cwd}>`
    record.promptWidth = prompt.length + 1
    if (windows) {
      const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const native = prepareWindowsPtyLaunch(shell, ['-NoLogo', '-NoProfile'], cwd, environment)
      // The session manager's own options (pty-host.ts): bundled ConPTY, raw output.
      pty = spawn(native.executable, native.arguments, { name: 'xterm-256color', ...size, cwd, env: environment,
        encoding: null, useConpty: true, useConptyDll: variant.bundledConpty } as Parameters<typeof spawn>[2])
    } else {
      pty = spawn('/bin/bash', ['--noprofile', '--norc'], { name: 'xterm-256color', ...size, cwd,
        env: environment, encoding: null } as Parameters<typeof spawn>[2])
    }
    const live = pty
    exited = new Promise((resolve) => live.onExit(() => resolve()))
    live.onData((data: string | Uint8Array) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      stream += text
      terminal.write(text)
    })
    if (variant.replies) terminal.onData((answer) => live.write(answer))
    let promptSeen = ''
    const promptShown = () => {
      const buffer = terminal.buffer.active
      const row = buffer.baseY + buffer.cursorY
      // Trailing blanks are trimmed: the animation blanked cells far to the right on the rows a prompt may land on.
      const current = (buffer.getLine(row)?.translateToString(true) ?? '').trimEnd()
      if (!windows) return /\$$/u.test(current)
      // A one-row prompt on the cursor's row, as before; a prompt wider than the pane fills whole rows before the
      // cursor's, and joined without separators they hold it, whether the console host wrapped them or broke them.
      if (/^PS .*>$/u.test(current)) return true
      let text = current
      for (let above = 1; above <= Math.ceil(prompt.length / variant.cols) && row - above >= 0; above++) {
        text = (buffer.getLine(row - above)?.translateToString(false) ?? '') + text
      }
      promptSeen = text.trimEnd().slice(-prompt.length - 20)
      return promptSeen.toLowerCase().endsWith(prompt.toLowerCase())
    }

    record.promptMs = await until(promptShown, 30_000)
    if (record.promptMs === null) {
      record.promptSeen = escaped(promptSeen)
      throw new Error('the shell never showed its first prompt')
    }
    record.firstPromptCursor = { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY }
    live.write(animationLine)
    record.codexDoneMs = await until(() => stream.includes('CODEX-RATE-DONE'), 30_000)
    record.maxDoneMs = await until(() => stream.includes('MAX-RATE-DONE'), 30_000)
    if (record.maxDoneMs === null) throw new Error('the animation never finished')
    if (variant.afterPrompt) {
      const done = stream.lastIndexOf('MAX-RATE-DONE')
      record.promptAfterAnimationMs = await until(() => stream.length > done + 15 && promptShown(), 10_000)
      // Without its prompt this variant would only repeat the typed-ahead case.
      if (record.promptAfterAnimationMs === null) throw new Error('the prompt never returned after the animation')
    }
    const typedAt = Date.now()
    const scrollFrom = stream.length
    live.write(scrollLine)
    record.scrolledMs = await until(() => stream.includes('SCROLLED'), 10_000)
    // A fresh prompt: one drawn after SCROLLED, not a match left on the screen.
    const scrolledEnd = () => stream.indexOf('SCROLLED', scrollFrom) + 'SCROLLED'.length
    record.promptAfterScrolledMs = record.scrolledMs === null ? null
      : await until(() => stream.length > scrolledEnd() + 2 && promptShown(), 5_000)
    record.shellWrote = { beforeScrolled: existsSync(before), afterScrolled: existsSync(after) }
    record.bytesAtOutcome = bytes
    record.observedForMs = Date.now() - typedAt
    // What followed the last scroll line: SCROLLED and the prompt, or nothing.
    const lastScroll = stream.lastIndexOf('scroll-79')
    record.afterLastScroll = lastScroll < scrollFrom ? null : escaped(stream.slice(lastScroll, lastScroll + 1_500))
    // The first stage after which SCROLLED was seen: the wait, the reader credit, the resize or the typed probe.
    const stage = (name: string): void => {
      if (record.scrolledBy === undefined && stream.slice(scrollFrom).includes('SCROLLED')) record.scrolledBy = name
    }
    stage('wait')
    save(record)

    // The same two interventions the self-test makes once output stops; here they also run when it did not, to show
    // what a working pane answers. A read credit for node-pty's Windows ConPTY reader; then a one-column resize of the
    // PTY and of the terminal, as a view would. Bytes after either show progress; none is inconclusive.
    const reader = (live as unknown as { _agent?: { _worker?: { _worker?: { postMessage?(message: unknown): void } } } })
      ._agent?._worker?._worker
    const beforeNudge = bytes
    record.nudge = typeof reader?.postMessage === 'function' ? (reader.postMessage('read'), 'sent') : 'no reader'
    await sleep(2_000)
    record.bytesAfterNudge = bytes - beforeNudge
    stage('nudge')
    const beforeResize = bytes
    terminal.resize(variant.cols + 1, variant.rows)
    live.resize(variant.cols + 1, variant.rows)
    await sleep(3_000)
    record.bytesAfterResize = bytes - beforeResize
    stage('resize')
    if (record.scrolledMs === null) {
      // Last, typed input, after which the packaged pane printed again: whether SCROLLED shows up then, and where
      // relative to the probe's own output. A later appearance shows delayed observation, not where bytes waited.
      const probeFrom = stream.length
      live.write(windows ? "Write-Output ('PRO' + 'BE')\r" : "printf '%s%s\\n' PRO BE\r")
      record.probeMs = await until(() => stream.slice(probeFrom).includes('PROBE'), 5_000)
      stage('probe')
      const afterTyped = stream.slice(probeFrom)
      record.afterProbe = { scrolledAt: afterTyped.indexOf('SCROLLED'), probeAt: afterTyped.indexOf('PROBE'),
        bytes: Buffer.byteLength(afterTyped), head: escaped(afterTyped.slice(0, 1_500)) }
    }
    record.scrolledBy ??= null
    record.shellWroteAtEnd = { beforeScrolled: existsSync(before), afterScrolled: existsSync(after) }
    save(record)
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      await finish()
    } catch (error) {
      record.cleanupError = error instanceof Error ? error.message : String(error)
    }
    save(record)
  }
  return record
}

describe('a pane keeps printing after a Codex-style Sixel animation (self-test SCROLLED)', () => {
  it.runIf(windows)('prints SCROLLED in Windows PowerShell under bundled ConPTY, and records what each variant changes', async () => {
    useStandInLauncher(fileURLToPath(new URL('../../native-out/windows-cli/bmn.exe', import.meta.url)))
    const results = fileURLToPath(new URL('../../../../test-results/', import.meta.url))
    mkdirSync(results, { recursive: true })
    const records: Array<Record<string, unknown>> = []
    const started = Date.now()
    // Saved as each record grows, so a later timeout keeps what was observed.
    const save = (): void => writeFileSync(join(results, 'windows-conpty-scroll.json'), JSON.stringify(records, null, 2))
    for (const variant of WINDOWS_VARIANTS) {
      // A variant takes about 17 s when it passes, about 35 s when SCROLLED is missing and at most ~130 s when
      // nothing answers at all, plus setup and cleanup; none starts after 150 s, before the test's 300 s deadline.
      if (Date.now() - started > 150_000) {
        records.push({ ...variant, skipped: 'time budget' })
        save()
        continue
      }
      const index = records.length
      records.push({ ...variant })
      await scrollSequence(variant, (record) => {
        records[index] = { ...record }
        save()
      })
    }
    const production = records[0]!
    expect(production.error ?? null, JSON.stringify(records)).toBeNull()
    expect(production.scrolledMs, JSON.stringify(records)).not.toBeNull()
  }, 300_000)

  it.runIf(!windows)('prints SCROLLED in bash and the shell writes past it (the sequence itself)', async () => {
    const record = await scrollSequence(PRODUCTION)
    expect(record.error ?? null, JSON.stringify(record)).toBeNull()
    expect(record.scrolledMs, JSON.stringify(record)).not.toBeNull()
    expect(record.shellWrote).toEqual({ beforeScrolled: true, afterScrolled: true })
    expect(record.nudge).toBe('no reader')
  }, 60_000)
})
