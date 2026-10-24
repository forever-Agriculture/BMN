#!/usr/bin/env node
// MODULE: bmn-cpu.mjs - Story 91.1: BMN's own CPU per process type over a window, from /proc and BMN's database, read-only
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = `Usage: node scripts/measure/bmn-cpu.mjs --out FILE [--minutes N] [--interval SECONDS] [--exe PATH | --main-pid PID]
                                    [--bin-dir DIR] [--db FILE] [--proc DIR]
Samples BMN's main process and its Electron children every 5 seconds and writes one JSON report to FILE.
Cores are each process's change in user plus system time over the elapsed seconds. Everything under a session's
terminal is left out; BMN's own CLI and hooks run there are a line of their own, outside the target.
Without --exe, BMN is the one packaged build running (a binary named bmn); --main-pid picks one BMN when several run.`

/** The longest pause between two samples that still measures the window; a longer one makes it invalid. */
export const MAX_GAP_SECONDS = 10

/** One process as /proc shows it: its parent, its CPU ticks so far, when it started (ticks since boot), argv, binary. */
export function parseStat(text) {
  // The command name may hold spaces and parentheses: the fields that follow start after the last ')'.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u)
  return { ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), start: fields[19] }
}

/** Every process /proc lists that can still be read; one that ends while being read is left out. */
export function readProc(procRoot = '/proc') {
  const processes = new Map()
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(name)) continue
    try {
      const stat = parseStat(readFileSync(join(procRoot, name, 'stat'), 'utf8'))
      const parts = readFileSync(join(procRoot, name, 'cmdline'), 'utf8').split('\0').filter((part) => part !== '')
      // Chromium rewrites its children's arguments as one line joined by spaces.
      const argv = parts.length === 1 && parts[0].includes(' --') ? parts[0].split(' ').filter((part) => part !== '') : parts
      let exe = null
      try { exe = readlinkSync(join(procRoot, name, 'exe')) } catch { /* a process of another user, or a kernel thread */ }
      processes.set(Number(name), { pid: Number(name), ...stat, argv, exe })
    } catch { /* it ended while being read */ }
  }
  const uptime = Number(readFileSync(join(procRoot, 'uptime'), 'utf8').split(/\s+/u)[0])
  return { processes, uptime }
}

/** The Electron process type an argv names (`renderer`, `gpu-process`, `zygote`, `utility:<sub-type>`), or null. */
export function electronType(argv) {
  const type = argv.find((part) => part.startsWith('--type='))?.slice('--type='.length)
  if (type === undefined) return null
  if (type !== 'utility') return type
  const sub = argv.find((part) => part.startsWith('--utility-sub-type='))?.slice('--utility-sub-type='.length)
  return `utility:${sub ?? 'unknown'}`
}

/**
 * BMN's main process: the given PID, else the one process running `exe` (or a binary named bmn) that is no Electron
 * child, has Electron children and is not started by such a process (the CLI runs the same binary as Node).
 */
export function findMain(processes, { exe = null, mainPid = null } = {}) {
  if (mainPid !== null) {
    const found = processes.get(mainPid)
    if (found === undefined) throw new Error(`no process ${mainPid}`)
    return found
  }
  const runs = (entry) => (exe === null ? entry.exe?.endsWith('/bmn') === true : entry.exe === exe)
  const parents = new Set([...processes.values()].filter((entry) => electronType(entry.argv) !== null).map((entry) => entry.ppid))
  const mains = [...processes.values()].filter((entry) => runs(entry) && electronType(entry.argv) === null && parents.has(entry.pid)
    && !runs(processes.get(entry.ppid) ?? { exe: null }))
  if (mains.length === 0) throw new Error(`no BMN runs ${exe ?? 'a binary named bmn'}`)
  if (mains.length > 1) throw new Error(`${mains.length} BMN main processes run ${exe} (${mains.map((entry) => entry.pid).join(', ')}); name one with --main-pid`)
  return mains[0]
}

/**
 * Each process under BMN's main, with the line it counts on: `target` for the main process and its Electron children
 * (by type), `bmn-cli` for BMN's own CLI and hooks that run under a session's terminal, `helpers` for other programs
 * BMN starts itself, and `terminal` for everything else under a session's terminal (never counted). A session's
 * terminal starts at the shell whose start time BMN records for a running session (`sessionStarts`); without that
 * record every program a utility process starts is taken for one.
 */
export function classify(processes, main, { binDirs = [], sessionStarts = null } = {}) {
  const children = new Map()
  for (const entry of processes.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, [])
    children.get(entry.ppid).push(entry)
  }
  const isCli = (argv) => argv.some((part) => binDirs.some((dir) => part.startsWith(`${dir}/`)))
  const result = [{ ...main, kind: 'main', line: 'target' }]
  const walk = (parent, underTerminal) => {
    for (const entry of children.get(parent.pid) ?? []) {
      if (entry.pid === parent.pid) continue
      const type = electronType(entry.argv)
      // A session's shell is the root of its terminal, whatever runs inside it.
      const root = type === null && parent.kind?.startsWith('utility:') && (sessionStarts === null || sessionStarts.has(entry.start))
      const terminal = underTerminal || root
      // The session's shell starts with BMN's rcfile, and is the terminal itself, not BMN's CLI.
      const kind = type ?? (terminal ? (!root && isCli(entry.argv) ? 'bmn-cli' : 'terminal') : 'helper')
      const line = type !== null && !terminal ? 'target' : kind === 'bmn-cli' ? 'bmn-cli' : kind === 'helper' ? 'helpers' : 'terminal'
      const classified = { ...entry, kind, line, ...(root ? { session: `${entry.pid}:${entry.start}` } : underTerminal ? { session: parent.session } : {}) }
      result.push(classified)
      walk(classified, terminal)
    }
  }
  walk(result[0], false)
  return result
}

const AGENTS = ['claude', 'codex', 'opencode']

/** The agent a process runs, by its binary or, for a Node or shell wrapper, its script: claude, codex, opencode or null. */
export function agentOf(entry) {
  const base = (path) => path?.split('/').at(-1) ?? ''
  if (entry.exe?.includes('/claude/versions/')) return 'claude'
  for (const name of [base(entry.exe), base(entry.argv[0]), ['node', 'bun'].includes(base(entry.exe)) ? base(entry.argv[1]) : '']) {
    if (AGENTS.includes(name)) return name
  }
  return null
}

/** The sessions' terminals in one sample and the agent each runs, the outermost one found under its shell. */
export function sessionAgents(classified) {
  const roots = new Map()
  for (const entry of classified) {
    if (entry.session === undefined) continue
    if (!roots.has(entry.session)) roots.set(entry.session, null)
    const agent = agentOf(entry)
    if (agent !== null && roots.get(entry.session) === null) roots.set(entry.session, agent)
  }
  const agents = {}
  for (const agent of roots.values()) if (agent !== null) agents[agent] = (agents[agent] ?? 0) + 1
  return { terminals: roots.size, agents }
}

/**
 * Cores per kind and line over the samples, each a list of classified processes with the uptime it was read at.
 * A process is its PID with its start time, so a reused PID is a new process. Between two samples a process counts
 * its change in ticks; one born after the earlier sample counts all its ticks at its first. A gap over MAX_GAP_SECONDS,
 * or a main process that changed or went, makes the measurement invalid.
 */
export function summarize(samples, { ticksPerSecond = 100 } = {}) {
  const reasons = []
  if (samples.length < 2) reasons.push('fewer than two samples')
  const byKind = {}
  const byLine = { target: 0, 'bmn-cli': 0, helpers: 0 }
  const identity = (entry) => `${entry.pid}:${entry.start}`
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]
    const after = samples[index]
    const gap = after.uptime - before.uptime
    if (gap > MAX_GAP_SECONDS) reasons.push(`a gap of ${gap.toFixed(1)} s at sample ${index}`)
    const mainBefore = before.processes.find((entry) => entry.kind === 'main')
    const mainAfter = after.processes.find((entry) => entry.kind === 'main')
    if (mainBefore === undefined || mainAfter === undefined || identity(mainBefore) !== identity(mainAfter)) reasons.push(`BMN restarted or stopped at sample ${index}`)
    const earlier = new Map(before.processes.map((entry) => [identity(entry), entry]))
    for (const entry of after.processes) {
      if (entry.line === 'terminal') continue
      const previous = earlier.get(identity(entry))
      const born = Number(entry.start) / ticksPerSecond > before.uptime
      const delta = previous !== undefined ? entry.ticks - previous.ticks : born ? entry.ticks : 0
      if (delta <= 0) continue
      byLine[entry.line] += delta
      if (entry.line === 'target') byKind[entry.kind] = (byKind[entry.kind] ?? 0) + delta
    }
  }
  const seconds = samples.length < 2 ? 0 : samples.at(-1).uptime - samples[0].uptime
  const cores = (ticks) => (seconds > 0 ? Number((ticks / ticksPerSecond / seconds).toFixed(4)) : null)
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    seconds: Number(seconds.toFixed(1)),
    samples: samples.length,
    cores: {
      total: cores(byLine.target),
      byKind: Object.fromEntries(Object.entries(byKind).sort(([one], [other]) => one.localeCompare(other)).map(([kind, ticks]) => [kind, cores(ticks)])),
      outsideTarget: { 'bmn-cli': cores(byLine['bmn-cli']), helpers: cores(byLine.helpers) }
    }
  }
}

/**
 * The sessions running, the agents BMN started among them (bound conversations) and their shells' start times (`linux-proc-start:<ticks>`), from BMN's
 * database opened read-only; null counts where it cannot be read.
 */
export async function liveSessions(databasePath) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = db.prepare(`SELECT s.session_id AS id, b.agent_cli AS agent, p.process_start_identity AS identity FROM session s
        JOIN process_incarnation p ON p.session_id = s.session_id AND p.state IN ('starting', 'running')
        LEFT JOIN conversation_binding b ON b.session_id = s.session_id AND b.status = 'bound'
        WHERE s.archived_at IS NULL`).all()
      const agents = {}
      const ids = new Set(rows.map((row) => row.id))
      for (const id of ids) {
        const agent = rows.find((row) => row.id === id && row.agent)?.agent
        if (agent) agents[agent] = (agents[agent] ?? 0) + 1
      }
      const starts = rows.map((row) => /^linux-proc-start:(\d+)$/u.exec(row.identity ?? '')?.[1]).filter((start) => start !== undefined)
      return { running: ids.size, bound: agents, starts }
    } finally {
      db.close()
    }
  } catch (error) {
    return { running: null, bound: null, starts: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function withoutStarts({ starts, ...rest }) {
  return { ...rest, shells: starts?.length ?? null }
}

function option(argv, name, fallback = null) {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}

async function main(argv) {
  if (argv.includes('--help')) { console.log(USAGE); return 0 }
  const out = option(argv, '--out')
  if (out === null) { console.error(USAGE); return 2 }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const exe = option(argv, '--exe') === null ? null : realpathSync(option(argv, '--exe'))
  const mainPid = option(argv, '--main-pid') === null ? null : Number(option(argv, '--main-pid'))
  const procRoot = option(argv, '--proc', '/proc')
  const seconds = Number(option(argv, '--minutes', '30')) * 60
  const interval = Number(option(argv, '--interval', '5'))
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  const databasePath = option(argv, '--db', join(process.env.BMN_DATA_HOME ?? join(homedir(), '.local/share/ai-terminal'), 'state.sqlite3'))
  const sample = async () => {
    const { starts } = await liveSessions(databasePath)
    const { processes, uptime } = readProc(procRoot)
    const main = findMain(processes, { exe, mainPid })
    // BMN's CLI and hooks: the packaged build's resources/bin beside its binary, or this checkout's bin for a source build.
    const binDirs = [option(argv, '--bin-dir', join(dirname(main.exe ?? ''), 'resources/bin')), join(root, 'apps/desktop/bin')]
    return { uptime, processes: classify(processes, main, { binDirs, sessionStarts: starts === null ? null : new Set(starts) }) }
  }
  const startedAt = new Date().toISOString()
  const sessionsAtStart = await liveSessions(databasePath)
  const samples = [await sample()]
  const until = samples[0].uptime + seconds
  while (samples.at(-1).uptime < until) {
    await new Promise((done) => setTimeout(done, interval * 1000))
    try {
      samples.push(await sample())
    } catch (error) {
      // BMN went: the window ends here and is invalid.
      samples.push({ uptime: readProc(procRoot).uptime, processes: [], error: String(error) })
      break
    }
  }
  const report = {
    startedAt, endedAt: new Date().toISOString(), exe: samples[0].processes[0].exe, mainPid: samples[0].processes[0].pid, interval, ticksPerSecond,
    ...summarize(samples, { ticksPerSecond }),
    sessions: { atStart: withoutStarts(sessionsAtStart), atEnd: withoutStarts(await liveSessions(databasePath)) },
    // Which agent runs in each session, from /proc under its shell: BMN keeps no row for an agent typed into a shell.
    agents: { atStart: sessionAgents(samples[0].processes), atEnd: sessionAgents(samples.at(-1).processes) },
    // No counter of one session's output exists: /proc/<pid>/io counts a whole process, not one terminal.
    perSessionOutput: 'unknown'
  }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.valid ? 'valid' : `INVALID (${report.reasons.join('; ')})`}: ${report.cores.total} cores over ${report.seconds} s`)
  return report.valid ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
