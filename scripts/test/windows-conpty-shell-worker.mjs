// MODULE: windows-conpty-shell-worker.mjs - observation only: what the bundled ConPTY gives ordinary Windows shells
// Runs on BMN's Electron as Node, which node-pty is built for, and plays the terminal's part: each
// forwarded primary device attributes request gets xterm.js's reply. Records what PowerShell, cmd
// and a raw-mode program sent and received, as escaped text around synthetic markers.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, version } from 'node:os'
import { join } from 'node:path'

const [packageJson, checksFile, fullScreenFile, resultPath] = process.argv.slice(2)
const pty = createRequire(packageJson)('node-pty')
const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const powerShell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const XTERM_DA1_REPLY = '\x1b[?62;4;9;22c'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// eslint-disable-next-line no-control-regex
const visible = text => text.replace(/\x1b/gu, '\\e').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
const around = (output, marker, before = 48) => {
  const at = output.lastIndexOf(marker)
  return at < 0 ? null : visible(output.slice(Math.max(0, at - before), at + marker.length + 12))
}
const quoted = text => `'${text.replaceAll("'", "''")}'`
const environment = { ...process.env, TERM: 'xterm-sixel-256color', COLORTERM: 'truecolor' }
delete environment.ELECTRON_RUN_AS_NODE

function open(executable, argv, env) {
  const state = { output: '', exit: undefined, requests: 0 }
  const terminal = pty.spawn(executable, argv, { name: 'xterm-256color', cols: 120, rows: 30, cwd: tmpdir(), env,
    useConpty: true, useConptyDll: true })
  terminal.onData(data => {
    state.output += data
    const requests = state.output.split('\x1b[c').length - 1
    while (state.requests < requests) { state.requests++; terminal.write(XTERM_DA1_REPLY) }
  })
  terminal.onExit(value => { state.exit = value })
  const until = async (predicate, limit) => {
    const end = Date.now() + limit
    while (!predicate() && Date.now() < end && state.exit === undefined) await sleep(25)
    return predicate()
  }
  const close = async () => {
    if (state.exit === undefined) { terminal.kill(); await until(() => state.exit !== undefined, 5000) }
  }
  return { state, until, close, type: text => terminal.write(text) }
}

const line = (output, pattern) => visible(pattern.exec(output)?.[0] ?? '') || null
const modes = (output, from) => Object.fromEntries(['?1049', '?1000', '?1006', '?2004'].map(mode =>
  [mode, { set: output.indexOf(`\x1b[${mode}h`, from) >= 0, reset: output.indexOf(`\x1b[${mode}l`, from) >= 0 }]))

async function rawProgram(root) {
  const file = join(root, 'raw.cjs')
  writeFileSync(file, [
    "process.stdin.setRawMode(true); process.stdin.resume(); let input = ''",
    "process.stdin.on('data', (data) => { input += data.toString('latin1') })",
    "process.stdout.write('\\x1b]0;BMN-RAW-TITLE\\x07\\x1b[38;5;202mBMN-RAW-256\\x1b[0m\\r\\n\\x1b[c')",
    "setTimeout(() => { process.stdout.write('BMN-STDIN:' + Buffer.from(input, 'latin1').toString('hex') + '\\r\\n'); process.exit(0) }, 3000)",
    ''
  ].join('\n'))
  const session = open(process.execPath, [file], { ...environment, ELECTRON_RUN_AS_NODE: '1' })
  try {
    await session.until(() => session.state.output.includes('BMN-STDIN:'), 20000)
    const stdin = /BMN-STDIN:([0-9a-f]*)/u.exec(session.state.output)?.[1]
    return { requestsAnswered: session.state.requests, childStdin: stdin === undefined ? null : visible(Buffer.from(stdin, 'hex').toString('latin1')),
      title: around(session.state.output, 'BMN-RAW-TITLE'), color256: around(session.state.output, 'BMN-RAW-256'), exit: session.state.exit ?? null }
  } finally { await session.close() }
}

async function powerShellShell(label, argv) {
  const started = Date.now()
  const session = open(powerShell, argv, environment)
  const out = () => session.state.output
  try {
    session.type(`iex ([IO.File]::ReadAllText(${quoted(checksFile)}))\r`)
    const checks = await session.until(() => out().includes('REGRESSION-256'), 90000)
    const checksMs = Date.now() - started
    session.type("$Host.UI.RawUI.WindowTitle = 'REGRESSION-' + 'TITLE'\r")
    await session.until(() => out().includes('REGRESSION-TITLE'), 10000)
    session.type("Write-Output ('PROMPT-' + 'READY')\r")
    await session.until(() => out().includes('PROMPT-READY'), 10000)
    const pasteAtPrompt = out().includes('\x1b[?2004h')
    const before = out().length
    session.type(`iex ([IO.File]::ReadAllText(${quoted(fullScreenFile)}))\r`)
    const ready = await session.until(() => out().includes('FULL-SCREEN-READY'), 20000)
    await sleep(300)
    session.type('q')
    const done = await session.until(() => out().includes('FULL-SCREEN-DONE'), 10000)
    return { label, checks, checksMs, requestsAnswered: session.state.requests,
      // eslint-disable-next-line no-control-regex
      terms: line(out(), /REGRESSION term=[^\r\n\x1b]*/u), da1: line(out(), /REGRESSION2 da1=[^\r\n]*/u),
      hostColor: around(out(), 'REGRESSION-HOSTCOLOR'), color256: around(out(), 'REGRESSION-256'),
      title: around(out(), 'REGRESSION-TITLE'), typedCommand: around(out(), "Output ('PROMPT-'", 64), pasteAtPrompt,
      fullScreen: { ready, done, modes: modes(out(), before) } }
  } finally { await session.close() }
}

async function commandShell() {
  const session = open(join(system, 'cmd.exe'), ['/d'], environment)
  const out = () => session.state.output
  try {
    session.type('prompt $E[01;32mREGRESSION-PROMPT$G$E[0m\r')
    const prompt = await session.until(() => out().includes('REGRESSION-PROMPT>'), 30000)
    session.type('title REGRESSION-TITLE\r')
    // eslint-disable-next-line no-control-regex
    await session.until(() => /\x1b\][02];REGRESSION-TITLE/u.test(out()), 10000)
    // eslint-disable-next-line no-control-regex
    return { label: 'cmd', prompt, promptColor: around(out(), 'REGRESSION-PROMPT>'), title: line(out(), /\x1b\][02];REGRESSION-TITLE[^\x07\x1b]*/u),
      requestsAnswered: session.state.requests }
  } finally { await session.close() }
}

;(async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-conpty-shells-'))
  const runs = []
  for (const [name, run] of [['raw', () => rawProgram(root)], ['powershell', () => powerShellShell('powershell-clean', ['-NoLogo', '-NoProfile'])],
    ['cmd', commandShell]]) {
    const started = Date.now()
    try { runs.push({ name, ...(await run()), elapsedMs: Date.now() - started }) } catch (error) {
      runs.push({ name, error: String(error?.message ?? error).slice(0, 500), elapsedMs: Date.now() - started })
    }
  }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* The runner image is discarded. */ }
  writeFileSync(resultPath, JSON.stringify({ os: version(), xtermReply: visible(XTERM_DA1_REPLY), runs }, null, 2))
  process.exit(0)
})().catch(error => { console.error(error); process.exit(1) })
