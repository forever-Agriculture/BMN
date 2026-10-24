#!/usr/bin/env node
// MODULE: agent-replay.mjs - Story 91.1 AC3: one session's agent-like output for the CPU calibration, run as the session's program
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

const USAGE = `Usage: node scripts/measure/agent-replay.mjs [--agent claude|codex|shell] [--scale N] [--seed N] [--idle [--tick MS] | --steady] [--history N]
  [--size-file FILE]
Writes what an agent's terminal shows while it works and while it waits: a status line redrawn in synchronized updates,
streamed styled text in bursts, tool blocks, a Sixel image once, scrolling, a full redraw on resize, and idle stretches.
For claude and codex it reports hook events through BMN's \`bmn hook <agent>\`, as the real apps do, so BMN opens the
session's screen mirror. --scale multiplies how often things happen (1 by default). Started as \`claude\` or \`codex\`
(a link with that name), the agent is taken from the name. --idle starts the app and waits at its prompt, as a session
nobody is using does; --steady starts the next turn a second after one ends, as an agent left to work does. --tick redraws an idle session's
status every MS milliseconds, as an app's clock does. --history prints N lines first, as a session open for hours has
in its scrollback. --size-file keeps the terminal's size there as COLSxROWS. Runs until stopped.`

const ESC = '\u001b'
const CSI = `${ESC}[`
const SYNC_ON = `${CSI}?2026h`
const SYNC_OFF = `${CSI}?2026l`
const SPINNER = { claude: ['·', '✢', '✳', '✶', '✻', '✽'], codex: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
const WORDS = 'the session reads its files then writes a change and runs the tests again until they pass with every case named'.split(' ')

/** A small seeded generator, so two runs of one seed write the same screens. */
export function random(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** One line of streamed text: words in plain, 256-colour and true-colour styles, bold, italic and underline among them. */
export function styledLine(next, columns) {
  const parts = []
  let width = 0
  while (width < columns - 12) {
    const word = WORDS[Math.floor(next() * WORDS.length)]
    const roll = next()
    const styled = roll < 0.6 ? word
      : roll < 0.7 ? `${CSI}1m${word}${CSI}22m`
        : roll < 0.78 ? `${CSI}3m${word}${CSI}23m`
          : roll < 0.84 ? `${CSI}4m${word}${CSI}24m`
            : roll < 0.92 ? `${CSI}38;5;${16 + Math.floor(next() * 216)}m${word}${CSI}39m`
              : `${CSI}38;2;${Math.floor(next() * 256)};${Math.floor(next() * 256)};${Math.floor(next() * 256)}m${word}${CSI}39m`
    parts.push(styled)
    width += word.length + 1
  }
  return parts.join(' ')
}

/** A Sixel image of coloured bands, `size` pixels square (a multiple of 6). */
export function sixel(size = 48) {
  const colours = ['#0;2;80;20;20', '#1;2;20;80;20', '#2;2;20;20;80']
  const rows = []
  for (let band = 0; band < size / 6; band += 1) rows.push(`#${band % 3}${'~'.repeat(size)}`)
  return `${ESC}Pq${colours.join('')}${rows.join('-')}${ESC}\\`
}

/** A word with a moving highlight, one true colour per character, as both apps animate their working word. */
export function shimmer(word, frame) {
  return [...word].map((character, index) => {
    const light = Math.max(0, 1 - Math.abs(((frame % (word.length + 6)) - 3) - index) / 3)
    const level = Math.round(150 + 105 * light)
    return `${CSI}38;2;${level};${Math.round(level * 0.55)};${Math.round(level * 0.3)}m${character}`
  }).join('') + `${CSI}39m`
}

/** The status line and the prompt box an agent redraws while it works, at the bottom of its screen. */
export function statusFrame(agent, frame, seconds, tokens) {
  const glyph = SPINNER[agent === 'codex' ? 'codex' : 'claude'][frame % (agent === 'codex' ? 10 : 6)]
  const text = agent === 'codex'
    ? `${glyph} ${shimmer('Working', frame)} (${seconds}s • esc to interrupt)`
    : `${CSI}38;5;208m${glyph}${CSI}39m ${shimmer('Thinking…', frame)} (${seconds}s · ↓ ${tokens} tokens · esc to interrupt)`
  // Up two rows, clear them, draw the status and the prompt under it, inside one synchronized update.
  return `${SYNC_ON}\r${CSI}2A${CSI}2K${text}\r\n${CSI}2K${CSI}2m> ${CSI}22m\r\n${SYNC_OFF}`
}

function hook(agent, event, extra = {}) {
  if (agent === 'shell' || !process.env.BMN_CONTROL_SOCKET) return
  const payload = { session_id: CONVERSATION, cwd: process.cwd(), hook_event_name: event, ...extra }
  try {
    execFileSync('bmn', ['hook', agent], { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 })
  } catch {
    // A refused or slow hook changes nothing on the screen; the real apps go on too.
  }
}

// The app's own conversation id, made up once per run, as a real app keeps one per conversation.
const CONVERSATION = randomUUID()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run({ agent, scale, seed, idle, tick, steady, history, sizeFile }) {
  const next = random(seed)
  const write = (text) => process.stdout.write(text)
  const columns = () => process.stdout.columns || 80
  const keepSize = () => { if (sizeFile) writeFileSync(sizeFile, `${columns()}x${process.stdout.rows || 24}`) }
  let resized = false
  process.stdout.on('resize', () => { resized = true; keepSize() })
  keepSize()
  write(`${CSI}2J${CSI}H`)
  for (let line = 0; line < history; line += 1) write(`${styledLine(next, columns())}\r\n`)
  hook(agent, 'SessionStart', { source: 'startup' })
  if (idle) {
    write(`${CSI}2m> ${CSI}22m`)
    let shown = 0
    if (tick > 0) setInterval(() => { shown += 1; write(`\r${CSI}2K${CSI}2m> ${CSI}22m${CSI}2m(${shown})${CSI}22m`) }, tick)
    // A timer keeps the process alive: an await that never settles alone would end it (exit code 13).
    await new Promise(() => setInterval(() => undefined, 60_000))
  }
  let sentImage = false
  for (let turn = 0; ; turn += 1) {
    hook(agent, 'UserPromptSubmit', { prompt: 'made-up prompt' })
    write('\r\n\r\n')
    const workMs = (20_000 + next() * 40_000) / Math.max(scale, 0.1)
    const started = Date.now()
    let frame = 0
    let tokens = 0
    let nextBurst = started + 400
    let nextTool = started + 3_000 + next() * 6_000
    while (Date.now() - started < workMs) {
      // The status line: about every 100 ms in Claude Code and 80 ms in Codex at scale 1, more often at a larger scale.
      write(statusFrame(agent, frame, Math.floor((Date.now() - started) / 1000), tokens))
      frame += 1
      if (resized) {
        // A resize redraws the whole visible screen.
        resized = false
        write(`${SYNC_ON}${CSI}H${CSI}2J${Array.from({ length: (process.stdout.rows || 24) - 3 }, () => styledLine(next, columns())).join('\r\n')}\r\n\r\n${SYNC_OFF}`)
      }
      if (Date.now() >= nextBurst) {
        // A burst of streamed text above the status, which scrolls the screen.
        const lines = 1 + Math.floor(next() * 5 * scale)
        write(`\r${CSI}2A${CSI}2K${Array.from({ length: lines }, () => styledLine(next, columns())).join('\r\n')}\r\n\r\n\r\n`)
        tokens += lines * 18
        nextBurst = Date.now() + (300 + next() * 1_500) / Math.max(scale, 0.1)
      }
      if (Date.now() >= nextTool) {
        const command = `npm test -- --run case-${Math.floor(next() * 100)}`
        hook(agent, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } })
        const output = Array.from({ length: 5 + Math.floor(next() * 25) }, (_, index) => `${CSI}2m  ${index + 1}  ${styledLine(next, columns() - 6)}${CSI}22m`)
        write(`\r${CSI}2A${CSI}2K${CSI}38;5;114m⏺${CSI}39m Bash(${command})\r\n  ⎿ ${output.join('\r\n')}\r\n\r\n\r\n`)
        hook(agent, 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } })
        if (!sentImage && agent !== 'shell') {
          sentImage = true
          write(`\r${CSI}2A${CSI}2K${sixel()}\r\n\r\n\r\n`)
        }
        nextTool = Date.now() + (4_000 + next() * 10_000) / Math.max(scale, 0.1)
      }
      await sleep((agent === 'codex' ? 80 : 100) / Math.max(scale, 0.1))
    }
    // The turn ends: the status line gives way to a quiet prompt, and the app waits.
    write(`\r${CSI}2A${CSI}2K${CSI}32m✓ Done${CSI}39m\r\n${CSI}2K> \r\n`)
    hook(agent, 'Stop', {})
    await sleep(steady ? 1_000 : (30_000 + next() * 90_000) / Math.max(scale, 0.1))
  }
}

function option(argv, name, fallback) {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}

const isMain = process.argv[1] && ['agent-replay.mjs', 'claude', 'codex', 'shell'].includes(basename(process.argv[1]))
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) console.log(USAGE)
  else {
    const named = basename(process.argv[1])
    const agent = option(argv, '--agent', named === 'agent-replay.mjs' ? 'claude' : named)
    await run({ agent, scale: Number(option(argv, '--scale', '1')), seed: Number(option(argv, '--seed', '1')), idle: argv.includes('--idle'), tick: Number(option(argv, '--tick', '0')), steady: argv.includes('--steady'), history: Number(option(argv, '--history', '0')), sizeFile: option(argv, '--size-file', null) })
  }
}
