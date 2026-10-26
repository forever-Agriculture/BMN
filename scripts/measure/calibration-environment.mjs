#!/usr/bin/env node
// MODULE: calibration-environment.mjs - Story 96.4 (paused 94.1 AC2): the environment a calibration's BMN starts with, the child's home disposable with every other mutable root, its launch, and the traced sentinel probe that proves it touches nothing outside
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRoster, sha256 } from '../../apps/desktop/bin/agents-roster.mjs'
import { buildGeneration } from '../../apps/desktop/bin/agents-state.mjs'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const app = join(repo, 'apps/desktop')

/**
 * The calibration child's environment, built from the caller's without changing it: BMN's and AITERM_ variables,
 * PROMPT_COMMAND and the terminfo folders a BMN session names (its own data folder, which BMN looks up) dropped; every XDG and BMN root and each agent's config folder inside the disposable `roots`; and the
 * child's HOME a folder inside `root` too, so what BMN or an app finds through the home (BMN's agents folder through
 * agentsDirectory(), its tries file, ~/.claude, ~/.codex, a shell's rc files) is the fixture's, never the owner's.
 * agentsDirectory() itself is unchanged: it resolves from this home as it always does.
 */
export function calibrationEnvironment(caller, { root, roots }) {
  const runtime = caller.XDG_RUNTIME_DIR
  const wayland = runtime && caller.WAYLAND_DISPLAY && !isAbsolute(caller.WAYLAND_DISPLAY) ? join(runtime, caller.WAYLAND_DISPLAY) : caller.WAYLAND_DISPLAY
  const dropped = new Set(['PROMPT_COMMAND', 'TERMINFO', 'TERMINFO_DIRS'])
  const kept = Object.fromEntries(Object.entries(caller).filter(([name]) => !dropped.has(name) && !name.startsWith('BMN_') && !name.startsWith('AITERM_')))
  return {
    ...kept, SHELL: '/bin/bash', HOME: join(root, 'home'),
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache, XDG_RUNTIME_DIR: roots.runtime,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
    CLAUDE_CONFIG_DIR: join(roots.config, 'claude'), CODEX_HOME: join(roots.config, 'codex'), OPENCODE_CONFIG_DIR: join(roots.config, 'opencode'),
    BMN_LAUNCH_CWD: root,
    ...(wayland ? { WAYLAND_DISPLAY: wayland } : {})
  }
}

/** Refuses an environment whose home or roots could be the caller's: the boundary every launch checks first. */
export function assertDisposable(environment, caller, root) {
  const inside = (path) => typeof path === 'string' && resolve(path).startsWith(`${resolve(root)}/`)
  const named = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'BMN_CONFIG_HOME', 'BMN_DATA_HOME', 'BMN_STATE_HOME', 'BMN_RUNTIME_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR']
  const outside = named.filter((name) => !inside(environment[name]))
  if (outside.length > 0 || (caller.HOME && resolve(environment.HOME) === resolve(caller.HOME))) {
    throw new Error(`the calibration environment leaves ${outside.join(', ') || 'HOME'} outside its disposable folder; nothing was started`)
  }
}

/** Creates the child's disposable home. Nothing of the caller's home is copied or linked into it. */
export function prepareCalibrationHome(environment) {
  mkdirSync(environment.HOME, { mode: 0o700 })
}

/**
 * What every calibration's BMN is started with beside its own flags: Chromium keeps its cookie key in a file of the
 * disposable profile instead of the desktop keyring, whose item the owner's own BMN shares (a file trace would not see it).
 */
export const CALIBRATION_FLAGS = ['--password-store=basic']

/**
 * Starts this checkout's built BMN with the environment, as the calibration does. `trace` (the probe only) runs it under
 * `strace -f -e trace=%file`, writing every file access of the whole launched tree to that path. The child leads its own
 * process group, so the caller can stop exactly what it started.
 */
export function launchCalibration({ electronPath, flags = [], cwd, env, trace = null, stdio = ['ignore', 'ignore', 'pipe'], appPath = app }) {
  const argv = [...CALIBRATION_FLAGS, ...flags, appPath]
  // -s 4096: whole paths, never the 32 characters strace prints by default.
  const command = trace === null ? [electronPath, argv] : ['strace', ['-f', '-qq', '-s', '4096', '-e', 'trace=%file', '-o', trace, '--', electronPath, ...argv]]
  return spawn(command[0], command[1], { cwd, env, stdio, detached: true })
}

/** Every file and folder under `folder`, with its kind, size, modification time and the SHA-256 of a file's bytes. */
export function fingerprint(folder) {
  const rows = []
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const stat = lstatSync(path)
      const row = { path: path.slice(folder.length + 1), size: stat.size, mtimeMs: stat.mtimeMs }
      if (stat.isDirectory()) { rows.push({ ...row, kind: 'folder' }); walk(path) }
      else if (stat.isSymbolicLink()) rows.push({ ...row, kind: 'link', target: readlinkSync(path) })
      else rows.push({ ...row, kind: 'file', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    }
  }
  walk(folder)
  return rows
}

/** The calls that only look a path up: resolving a folder BMN runs from passes its parents this way, reading nothing in them. */
const LOOKUPS = new Set(['readlink', 'readlinkat', 'stat', 'lstat', 'newfstatat', 'statx', 'access', 'faccessat', 'faccessat2'])

/**
 * The lines of an strace -f file trace that name a path inside one of `folders` and not inside one of `except` (its own
 * process ids kept). A folder in `ancestorsOf` may have each of its parents looked up, by exactly that path, and no more.
 */
export function tracedAccess(traceText, folders, { except = [], ancestorsOf = [] } = {}) {
  const within = (path, root) => path === root || path.startsWith(`${root}/`)
  const roots = folders.map((folder) => resolve(folder))
  const kept = except.map((folder) => resolve(folder))
  const parents = ancestorsOf.map((folder) => resolve(folder))
  return traceText.split('\n').filter((line) => {
    const call = /^\d+\s+([a-z0-9_]+)\(/u.exec(line)?.[1]
    const quoted = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1])
    return quoted.some((path) => roots.some((root) => within(path, root)) && !kept.some((root) => within(path, root)) &&
      !(LOOKUPS.has(call) && parents.some((folder) => folder.startsWith(`${path}/`))))
  })
}

/** What a list of traced lines touched, for a receipt: each call and path once, with how often, the most first. */
export function tracedSummary(lines, limit = 40) {
  const counts = new Map()
  for (const line of lines) {
    const key = `${/^\d+\s+([a-z0-9_]+)\(/u.exec(line)?.[1] ?? '?'} ${/"((?:[^"\\]|\\.)*)"/u.exec(line)?.[1] ?? ''}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => `${count} ${key}`)
}

/**
 * The homes the probe watches beside its synthetic one (96 review): the caller's `$HOME` and the account's own home from
 * the password file, which a library may read past `$HOME`. Inside them BMN may read only this checkout, whose code and
 * dependencies it runs from, and the probe's own disposable folders.
 */
export function watchedHomes(caller = process.env, account = userInfo().homedir) {
  return [...new Set([caller.HOME, account].filter((home) => typeof home === 'string' && home !== '').map((home) => resolve(home)))]
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A synthetic team in `folder` (an agents folder), approved as BMN's approval writes one: generation 1, then the
 * `current` pointer naming it (src/main/agents-approval.ts publish). BMN plans its own tests only for an approved team.
 */
export function approvedTeam(folder, text) {
  const data = parseRoster(text).data
  if (data === null) throw new Error('the synthetic team does not parse')
  const generation = buildGeneration({ number: 1, parent: null, data, rosterFileHash: sha256(text) })
  mkdirSync(join(folder, 'state/generations'), { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, 'roster.md'), text)
  writeFileSync(join(folder, 'state/generations/000001.json'), `${JSON.stringify(generation, null, 2)}\n`)
  writeFileSync(join(folder, 'state/current'), `${JSON.stringify({ generation: 1, hash: generation.hash })}\n`)
}

/** What a probe's receipt is for: this builder's own bytes and the built app's main bundle. */
export function isolationIdentity() {
  return {
    builder: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    build: existsSync(join(app, 'out/main/index.js')) ? createHash('sha256').update(readFileSync(join(app, 'out/main/index.js'))).digest('hex') : null
  }
}

/** Stops the process group a calibration or the probe started, then any process still holding its disposable root, and nothing else. */
export async function stopTree(child, root) {
  const alive = () => child.exitCode === null && child.signalCode === null
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  for (let waited = 0; alive() && waited < 15_000; waited += 250) await sleep(250)
  if (alive()) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
  // A session leader BMN started (a terminal's shell) left the group; it is found by its home inside this probe's root.
  const leftovers = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (environ.includes(`HOME=${join(root, 'home')}`) || environ.includes(`BMN_LAUNCH_CWD=${root}`)) leftovers.push(Number(entry))
    } catch { /* gone or not ours */ }
  }
  for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  return leftovers
}

/**
 * While a launched tree runs, Ctrl-C (or a SIGTERM or SIGHUP) first runs `stop` (the tree stopped, its folders removed)
 * and only then ends this process, with the signal's usual code: the detached child would outlive it otherwise (96 review).
 * Returns the function that removes the handlers again.
 */
export function stopOnInterrupt(stop) {
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
  let stopping = null
  const handler = (signal) => {
    stopping ??= Promise.resolve().then(stop).catch((error) => { console.error(`calibration: stopping after ${signal} failed: ${error.message}`) })
      .finally(() => process.exit(codes[signal]))
  }
  for (const signal of Object.keys(codes)) process.on(signal, handler)
  return () => { for (const signal of Object.keys(codes)) process.off(signal, handler) }
}

/**
 * The probe (96.4 AC3): one synthetic outside home stands for the owner's, holding a sentinel agents folder with an
 * approved team and a tries file; the disposable home holds a separate approved synthetic team. BMN is started from `build` and this launch
 * path under strace, with a stand-in `codex` on its path so its own tests plan one and write their tries file. The
 * probe passes only when that tries write landed in the disposable home, the trace names nothing inside the outside
 * home and its fingerprints are unchanged. `build` is the environment builder under test.
 */
export async function proveIsolation({ build = calibrationEnvironment, waitMs = 150_000, base = tmpdir() } = {}) {
  const electronPath = createRequire(join(app, 'package.json'))('electron')
  if (!existsSync(join(app, 'out/main/index.js'))) return { result: 'UNABLE', reason: 'no build: run pnpm run build first' }
  const work = mkdtempSync(join(base, 'bmn-calibration-sentinel-'))
  try {
    const outside = join(work, 'outside-home')
    const sentinel = join(outside, '.config/bmn/agents')
    const example = readFileSync(join(app, 'src/utility/test-fixtures/agents/roster-example.md'), 'utf8')
    approvedTeam(sentinel, example.replace(/^/u, '<!-- SENTINEL: the synthetic outside team; the probe fails if anything opens it -->\n'))
    writeFileSync(join(sentinel, 'state/auto-tests.json'), `${JSON.stringify({ version: 1, tries: {} })}\n`)
    const fakeBin = join(work, 'bin')
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\n# MODULE: codex - the probe\'s stand-in: a version for BMN\'s own tests to plan one, nothing else\n[ "$1" = --version ] && { echo "codex-cli 0.161.0"; exit 0; }\nexit 1\n')
    chmodSync(join(fakeBin, 'codex'), 0o755)
    const before = fingerprint(outside)
    // Not the caller's PATH, as a real calibration has: only the system's programs and the stand-in, so no agent app of
    // the owner's (nor a paid run of one) starts. A program found only through his PATH is not exercised here.
    const caller = { ...process.env, HOME: outside, PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin` }
    return await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots, cleanup }) => {
      const env = build(caller, { root, roots })
      let refused = null
      try { assertDisposable(env, caller, root) } catch (error) { refused = error.message }
      if (env.HOME !== caller.HOME) prepareCalibrationHome(env)
      const team = join(env.HOME, '.config/bmn/agents')
      if (env.HOME !== caller.HOME) approvedTeam(team, example)
      const trace = join(work, 'trace.txt')
      const flags = ['--ozone-platform=headless', '--ozone-override-screen-size=1600,1000', '--force-device-scale-factor=1']
      const child = launchCalibration({ electronPath, flags, cwd: root, env, trace })
      const release = stopOnInterrupt(async () => { await stopTree(child, root); cleanup(); rmSync(work, { recursive: true, force: true }) })
      let log = ''
      child.stderr.on('data', (chunk) => { log = `${log}${chunk}`.slice(-8_000) })
      const tries = join(env.HOME, '.config/bmn/agents/state/auto-tests.json')
      const leaked = join(sentinel, 'state/auto-tests.json')
      const started = Date.now()
      const wrote = () => (env.HOME !== caller.HOME && existsSync(tries)) || statSync(leaked).mtimeMs !== before.find((row) => row.path === '.config/bmn/agents/state/auto-tests.json').mtimeMs
      while (Date.now() - started < waitMs && !wrote() && child.exitCode === null) await sleep(1_000)
      const triesWritten = env.HOME !== caller.HOME && existsSync(tries)
      await sleep(3_000)
      const leftovers = await stopTree(child, root)
      release()
      const after = fingerprint(outside)
      const traceText = existsSync(trace) ? readFileSync(trace, 'utf8') : null
      // The synthetic outside home, and the real ones (96 review) but for this checkout and the probe's own folders.
      const homes = watchedHomes()
      const touched = traceText === null ? null : new Set([...tracedAccess(traceText, [outside]), ...tracedAccess(traceText, homes, { except: [repo, work, root], ancestorsOf: [repo] })])
      const traced = touched === null ? null : traceText.split('\n').filter((line) => touched.has(line))
      // What BMN wrote in the disposable team folder: the exact paths the receipt records beside the outside ones.
      const disposableTeam = env.HOME !== caller.HOME && existsSync(team) ? fingerprint(team).map((row) => `${row.kind} ${row.path}`) : []
      const changed = after.length !== before.length || after.some((row, index) => JSON.stringify(row) !== JSON.stringify(before[index]))
      const result = traced === null ? 'UNABLE' : refused === null && triesWritten && traced.length === 0 && !changed ? 'PASS' : 'FAIL'
      return {
        result, refused, triesWritten, sentinelChanged: changed, tracedOutside: traced === null ? null : traced.length, watchedHomes: homes.length,
        tracedSample: (traced ?? []).slice(0, 12), tracedSummary: tracedSummary(traced ?? []), traceLines: traceText === null ? null : traceText.split('\n').length, disposableTeam,
        before, after, leftovers, waitedMs: Date.now() - started,
        ...isolationIdentity(),
        ...(result === 'PASS' ? {} : { log: log.slice(-2_000) })
      }
    }, base)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv[0] !== '--prove') {
    console.log('Usage: node scripts/measure/calibration-environment.mjs --prove [--out RECEIPT.json]\nRuns the traced sentinel probe (needs strace and pnpm run build) and prints PASS, FAIL or UNABLE.')
    process.exitCode = argv.includes('--help') ? 0 : 2
  } else {
    const receipt = { at: new Date().toISOString(), ...(await proveIsolation()) }
    const at = argv.indexOf('--out')
    if (at >= 0) writeFileSync(resolve(argv[at + 1]), `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(JSON.stringify({ result: receipt.result, triesWritten: receipt.triesWritten, tracedOutside: receipt.tracedOutside, sentinelChanged: receipt.sentinelChanged, leftovers: receipt.leftovers }))
    process.exitCode = receipt.result === 'PASS' ? 0 : 1
  }
}
