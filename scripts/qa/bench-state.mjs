// MODULE: bench-state.mjs - locked run generations and kernel-owned QA workload containment
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJson, isLiveProcess, processIdentity } from './bench-lib.mjs'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const evidence = join(repo, '.dev-auto/evidence/qa-bench')
export const currentFile = join(evidence, 'current.json')
export const lockFile = join(evidence, 'lifecycle.lock')
export const sleep = ms => new Promise(done => setTimeout(done, ms))
const identity = stat => ({ device: stat.dev, inode: stat.ino })
const matches = (stat, expected) => stat.dev === expected.device && stat.ino === expected.inode
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

let lifecycleDepth = 0
export function withLifecycleLock(callback, path = lockFile) {
  if (callback.constructor.name === 'AsyncFunction') throw new Error('QA lifecycle transitions must be synchronous')
  if (path === lockFile && lifecycleDepth) return callback()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, 'a', 0o600)
  try {
    const result = spawnSync('/usr/bin/flock', ['--wait', '5', '3'], {
      cwd: dirname(path), env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8'
    })
    if (result.status !== 0) throw new Error('QA lifecycle lock unavailable; retry after the active transition')
    if (path === lockFile) lifecycleDepth++
    let value
    try { value = callback() } finally { if (path === lockFile) lifecycleDepth-- }
    if (value && typeof value.then === 'function') throw new Error('QA lifecycle transitions must be synchronous')
    return value
  } finally { closeSync(fd) }
}

export function readCurrent() { return existsSync(currentFile) ? readJson(currentFile) : null }

export function runPath(runId) {
  if (!/^\d+-[a-f0-9]{16}$/u.test(runId)) throw new Error('Invalid QA run identity')
  return join(evidence, runId)
}

export function configFor(runId) {
  const run = runPath(runId)
  if (realpathSync(run) !== run) throw new Error('QA evidence directory was substituted')
  const config = readJson(join(run, 'config.json'))
  if (config.runId !== runId || config.run !== run || config.currentFile !== currentFile || config.recoveryRoot !== join(run, 'recovery-root')) {
    throw new Error('QA creation metadata does not match this checkout')
  }
  return config
}

export function publish(state) {
  atomicJson(currentFile, state)
  atomicJson(join(runPath(state.runId), 'receipt.json'), { ...state, token: undefined })
  return state
}

export function transition(runId, statuses, callback) {
  return withLifecycleLock(() => {
    const state = readCurrent()
    if (state?.runId !== runId || !statuses.includes(state.status)) return null
    const next = callback(state)
    if (!next) return state
    if (next.runId !== runId) throw new Error('A transition cannot change QA generation')
    return publish(next)
  })
}

export function ownState(runId) {
  return withLifecycleLock(() => {
    const state = readCurrent()
    return state?.runId === runId ? state : null
  })
}

export function createLaunch(config, role, key) {
  if (!['workload', 'recovery'].includes(role) || !/^[a-f0-9]{16}$/u.test(key)) throw new Error('Invalid QA launch')
  const group = createGroup(config.runId, key), path = join(config.run, `launch-${key}.lease`)
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
    writeFileSync(fd, `${config.runId}:${key}\n`); fsyncSync(fd)
    const lease = { path, ...identity(fstatSync(fd)) }
    const entry = { role, key, identity: null, recorderIdentity: null, group, lease, gateDeadlineAt: Date.now() + 10000,
      file: role === 'workload' ? 'isolation.strace' : `recovery-${key}.strace`,
      actorFile: role === 'workload' ? 'launcher.json' : `watchdog-${key}.json`, recorderFile: `recorder-${key}.json`, certificateFile: `certificate-${key}.json` }
    const acquired = spawnSync('/usr/bin/flock', ['-x', '-n', '3'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', fd] })
    if (acquired.status !== 0) throw new Error('QA launch lease unavailable')
    atomicJson(join(config.run, `launch-${key}.json`), entry)
    return { entry, fd }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(path)) unlinkSync(path)
    if (statSync(group.path).ino === group.inode) rmdirSync(group.path)
    throw error
  }
}

export function launchFor(runId, key) {
  if (!/^[a-f0-9]{16}$/u.test(key)) throw new Error('Invalid QA launch key')
  const config = configFor(runId), path = join(config.run, `launch-${key}.json`)
  if (lstatSync(path).isSymbolicLink()) throw new Error('QA launch metadata was substituted')
  const entry = readJson(path)
  const expected = entry.role === 'workload' ? 'isolation.strace' : `recovery-${key}.strace`
  if (!['workload', 'recovery'].includes(entry.role) || entry.key !== key || entry.file !== expected || entry.group.launchKey !== key ||
      entry.lease.path !== join(config.run, `launch-${key}.lease`) || entry.recorderFile !== `recorder-${key}.json` || entry.certificateFile !== `certificate-${key}.json`) {
    throw new Error('QA launch metadata does not match its creation')
  }
  return entry
}

export function recorderIdentity(runId, trace) {
  const path = join(runPath(runId), `recorder-${trace.key}.json`)
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink()) throw new Error('QA recorder receipt was substituted')
  const value = readJson(path)
  if (value.runId !== runId || value.launchKey !== trace.key || value.role !== trace.role) throw new Error('QA recorder receipt mismatch')
  return value
}

export function actorIdentity(runId, trace) {
  if (!/^(?:launcher|watchdog-[a-f0-9]{16})\.json$/u.test(trace.actorFile)) throw new Error('Invalid QA actor receipt')
  const path = join(runPath(runId), trace.actorFile)
  if (!existsSync(path)) return null
  if (lstatSync(path).isSymbolicLink()) throw new Error('QA actor receipt was substituted')
  return readJson(path)
}

export function traceIdentity(runId, trace) { return recorderIdentity(runId, trace)?.tracerIdentity ?? null }
export function allTraces(state) {
  return state.tracers.map(trace => {
    const entry = launchFor(state.runId, trace.key), recorder = recorderIdentity(state.runId, entry)
    return { ...entry, recorderIdentity: trace.recorderIdentity ?? recorder?.recorderIdentity ?? null, identity: recorder?.tracerIdentity ?? null }
  })
}

function openLease(config, entry) {
  const fd = openSync(entry.lease.path, constants.O_RDWR | constants.O_NOFOLLOW)
  if (!matches(fstatSync(fd), entry.lease)) { closeSync(fd); throw new Error('QA launch lease was substituted') }
  const result = spawnSync('/usr/bin/flock', ['-x', '-n', '3'], {
    cwd: config.recoveryRoot, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe', fd]
  })
  if (result.status === 1) { closeSync(fd); return null }
  if (result.status !== 0) { closeSync(fd); throw new Error('QA launch lease could not be checked') }
  return fd
}

export function launchLeaseHeld(runId, trace) {
  return withLifecycleLock(() => {
    const fd = openLease(configFor(runId), launchFor(runId, trace.key))
    if (fd === null) return true
    closeSync(fd); return false
  })
}

export function launchQuiescent(runId, trace) {
  return withLifecycleLock(() => {
    const config = configFor(runId), entry = launchFor(runId, trace.key), fd = openLease(config, entry)
    if (fd === null) return false
    try { return !groupState({ ...config, group: entry.group }).populated }
    finally { closeSync(fd) }
  })
}

export function outstanding(state) {
  if (!state?.runId) return []
  return allTraces(state).filter(trace => !launchQuiescent(state.runId, trace)).map(trace => ({ launch: trace.key }))
}
export function traceOutstanding(runId, trace) { return !launchQuiescent(runId, trace) }

export function terminalTraceEvidence(text) {
  const tasks = new Set(), terminal = new Set(), errors = []
  for (const line of text.split('\n')) {
    if (/strace:|Process \d+ detached/u.test(line)) errors.push(line)
    const match = /^(\d+)\s+(.*)$/u.exec(line)
    if (!match) continue
    const [, pid, call] = match
    tasks.add(pid)
    if (/^\+\+\+ (?:exited with \d+|killed by .+) \+\+\+$/u.test(call)) terminal.add(pid)
    const child = /^(?:(?:clone3?|fork|vfork)\(|<\.\.\. (?:clone3?|fork|vfork) resumed>).*\)\s*=\s*(\d+)(?:\s+\/\* (\d+) in strace's PID NS \*\/)?(?:\s|$)/u.exec(call)
    if (child && Number(child[1]) > 0) tasks.add(child[2] ?? child[1])
  }
  return { complete: tasks.size > 0 && !errors.length && [...tasks].every(pid => terminal.has(pid)), tasks: [...tasks], errors }
}

export function traceCompleted(runId, trace) {
  const config = configFor(runId), entry = launchFor(runId, trace.key), recorder = recorderIdentity(runId, entry)
  const path = join(config.run, entry.certificateFile)
  if (!existsSync(path) || !recorder?.tracerIdentity || !launchQuiescent(runId, entry)) return false
  try {
    if (lstatSync(path).isSymbolicLink()) return false
    const cert = readJson(path)
    const sameProcess = (a, b) => a?.pid === b?.pid && a?.start_ticks === b?.start_ticks
    if (cert.version !== 1 || cert.runId !== runId || cert.launchKey !== entry.key || cert.role !== entry.role || cert.rawWaitStatus !== 0 || cert.exitCode !== 0 || cert.signal !== null ||
        !sameProcess(cert.recorderIdentity, recorder.recorderIdentity) || !sameProcess(cert.tracerIdentity, recorder.tracerIdentity) ||
        cert.launchGroupIdentity?.device !== entry.group.device || cert.launchGroupIdentity?.inode !== entry.group.inode || cert.traceErrors?.length !== 0) return false
    const fd = openSync(join(config.run, entry.file), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try { if (!matches(fstatSync(fd), cert.traceFileIdentity)) return false; bytes = readFileSync(fd) }
    finally { closeSync(fd) }
    return bytes.length === cert.traceBytes && createHash('sha256').update(bytes).digest('hex') === cert.traceSha256 && terminalTraceEvidence(bytes.toString()).complete
  } catch { return false }
}

export function createGroup(runId, launchKey) {
  const parent = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice`
  if (statSync(parent).uid !== process.getuid()) throw new Error('A delegated user cgroup is required for QA isolation')
  if (launchKey && !/^[a-f0-9]{16}$/u.test(launchKey)) throw new Error('Invalid QA launch key')
  const path = join(parent, `bmn-qa-${runId}${launchKey ? `-${launchKey}` : ''}.scope`)
  mkdirSync(path)
  try {
    return { path, parent, launchKey, parentIdentity: identity(statSync(parent)), ...identity(statSync(path)),
      kill: identity(statSync(join(path, 'cgroup.kill'))) }
  } catch (error) { rmdirSync(path); throw error }
}

function openGroup(config) {
  const group = config.group
  const expected = join(group.parent, `bmn-qa-${config.runId}${group.launchKey ? `-${group.launchKey}` : ''}.scope`)
  if (group.launchKey && !/^[a-f0-9]{16}$/u.test(group.launchKey)) throw new Error('Invalid QA launch cgroup')
  if (group.path !== expected || realpathSync(group.parent) !== group.parent || !matches(statSync(group.parent), group.parentIdentity)) {
    throw new Error('QA cgroup parent does not match its creation identity')
  }
  const fd = openSync(group.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  if (!matches(fstatSync(fd), group)) { closeSync(fd); throw new Error('QA cgroup was substituted') }
  return fd
}

const removalIntent = config => join(config.run, `group-removal-${config.group.launchKey ?? 'workload'}.json`)
export function groupState(config) {
  if (!existsSync(config.group.path)) {
    if (existsSync(removalIntent(config))) return { populated: false, processes: [] }
    throw new Error('QA cgroup disappeared without a removal receipt')
  }
  const fd = openGroup(config)
  try {
    const base = `/proc/self/fd/${fd}`
    const populated = /^populated 1$/mu.test(readFileSync(join(base, 'cgroup.events'), 'utf8'))
    const processes = readFileSync(join(base, 'cgroup.procs'), 'utf8').split(/\s+/u).filter(Boolean).map(processIdentity).filter(Boolean)
    return { populated, processes }
  } finally { closeSync(fd) }
}

export function killGroup(config) {
  const fd = openGroup(config)
  try {
    const kill = openSync(`/proc/self/fd/${fd}/cgroup.kill`, constants.O_WRONLY | constants.O_NOFOLLOW)
    try {
      if (!matches(fstatSync(kill), config.group.kill)) throw new Error('QA kill control was substituted')
      // The pinned kernel group is the authority. No PID inferred from a snapshot is signalled.
      writeSync(kill, '1')
    } finally { closeSync(kill) }
  } finally { closeSync(fd) }
}

export function validateRoot(config) {
  if (realpathSync(config.tempParent) !== config.tempParent || !matches(statSync(config.tempParent), config.tempParentIdentity)) {
    throw new Error('QA temporary parent was substituted')
  }
  if (dirname(config.root) !== config.tempParent) throw new Error('QA root is outside its recorded creation parent')
  if (!existsSync(config.root)) {
    const path = join(config.run, 'root-deletion-intent.json')
    if (existsSync(path) && readJson(path).runId === config.runId) return false
    throw new Error('QA root disappeared without a deletion receipt')
  }
  const stat = lstatSync(config.root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !matches(stat, config.rootIdentity) || readFileSync(join(config.root, '.bmn-qa-run'), 'utf8') !== config.runId) {
    throw new Error('QA root does not match its creation identity')
  }
  return true
}

export function validateStateRoot(state, config) {
  if (state.root !== config.root || state.run !== config.run || state.group?.path !== config.group.path) throw new Error('QA state creation fields were substituted')
  return validateRoot(config)
}

export function deleteRoot(config) {
  if (!validateRoot(config)) return
  atomicJson(join(config.run, 'root-deletion-intent.json'), { runId: config.runId, root: config.root, identity: config.rootIdentity })
  rmSync(config.root, { recursive: true, maxRetries: 3, retryDelay: 100 })
}

export function removeGroup(config) {
  if (!existsSync(config.group.path)) {
    if (existsSync(removalIntent(config))) return
    throw new Error('QA group disappeared before removal')
  }
  if (groupState(config).populated) throw new Error('QA cgroup is still populated; roots preserved')
  const fd = openGroup(config)
  try {
    atomicJson(removalIntent(config), { runId: config.runId, group: config.group })
    function removeEmptyChildren(base) {
      for (const item of readdirSync(base, { withFileTypes: true })) if (item.isDirectory()) {
        const child = join(base, item.name)
        removeEmptyChildren(child)
        rmdirSync(child)
      }
    }
    removeEmptyChildren(`/proc/self/fd/${fd}`)
    if (!matches(lstatSync(config.group.path), config.group)) throw new Error('QA group changed before removal')
    rmdirSync(config.group.path)
  } finally { closeSync(fd) }
}

export function requestStop(runId, error, retry = false) {
  const config = configFor(runId)
  return transition(runId, ['starting', 'running', 'stopping'], state => {
    validateStateRoot(state, config)
    return { ...state, status: 'stopping', stopRequestedAt: state.stopRequestedAt ?? new Date().toISOString(), error: error?.message ?? state.error,
      cleanupError: retry ? undefined : state.cleanupError }
  })
}

export function claimRecovery(runId, claimant, token) {
  const config = configFor(runId)
  return transition(runId, ['stopping'], state => {
    validateStateRoot(state, config)
    if (state.stopClaim && isLiveProcess(state.stopClaim.identity) && state.stopClaim.token !== token) return null
    return { ...state, stopClaim: { identity: claimant, token }, cleanupError: undefined }
  })
}
