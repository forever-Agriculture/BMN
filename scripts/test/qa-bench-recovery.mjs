// MODULE: qa-bench-recovery.mjs - real CLI lifecycle regressions on synthetic cgroup-contained workloads
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { atomicJson, isLiveProcess, processIdentity } from '../qa/bench-lib.mjs'
import { allTraces, configFor, groupState, launchLeaseHeld, killGroup, outstanding, ownState, readCurrent, traceCompleted, transition, withLifecycleLock } from '../qa/bench-state.mjs'

const out = resolve(process.argv[2])
const { values } = parseArgs({ args: process.argv.slice(3), options: { case: { type: 'string' }, timeout: { type: 'boolean' }, electron: { type: 'string' } } })
const selected = values.timeout ? 'timeout' : values.case ?? 'all'
mkdirSync(out, { recursive: true })
const parent = mkdtempSync(join(tmpdir(), 'bmn-qa-regression-'))
const fakeOwner = join(out, 'synthetic-caller'), pythonPath = join(out, 'synthetic-pythonpath'), hook = join(out, 'caller-hook-executed')
for (const path of [fakeOwner, pythonPath, join(parent, 'a'), join(parent, 'b')]) mkdirSync(path, { recursive: true })
const version = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', 'import sys;print("%s.%s"%sys.version_info[:2])'], { env: {}, encoding: 'utf8' }).stdout.trim()
const site = join(fakeOwner, `.local/lib/python${version}/site-packages`)
mkdirSync(site, { recursive: true })
const hostile = `from pathlib import Path\nPath(${JSON.stringify(hook)}).write_text('caller customization executed')\n`
writeFileSync(join(site, 'usercustomize.py'), hostile)
writeFileSync(join(pythonPath, 'sitecustomize.py'), hostile)
const caller = { PATH: process.env.PATH, HOME: fakeOwner, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: join(parent, 'a'), PYTHONPATH: pythonPath, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(fakeOwner, 'bus')}` }
const otherCaller = { ...caller, TMPDIR: join(parent, 'b') }
const fakeElectron = join(out, 'held-electron.sh')
writeFileSync(fakeElectron, '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o700 })
const contexts = new Map(), starters = [], foreign = [], heldActors = [], results = []
const pause = ms => new Promise(done => setTimeout(done, ms))
const cli = ['scripts/qa/bench.mjs']
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function launch(args, name, env = caller, extra = []) {
  const child = spawn(process.execPath, [...extra, ...cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const identity = processIdentity(child.pid)
  let output = ''
  child.stdout.on('data', part => { output += part }); child.stderr.on('data', part => { output += part })
  const exit = new Promise(done => child.once('exit', code => { writeFileSync(join(out, `${name}.log`), output); done(code) }))
  const started = { child, identity, exit, output: () => output }
  starters.push(started)
  return started
}
function remember(state) {
  if (!state?.runId) return null
  let context = contexts.get(state.runId)
  if (!context) { context = { config: configFor(state.runId) }; contexts.set(state.runId, context) }
  context.state = state
  atomicJson(join(out, 'owned-runs.json'), [...contexts.values()].map(({ config, state }) => ({ runId: config.runId, root: config.root, group: config.group, tracers: allTraces(state) })))
  return context
}
async function until(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(25) }
  throw new Error('Synthetic lifecycle condition timed out')
}
async function admitted(started, fake) {
  const context = await until(() => {
    const state = readCurrent()
    if (state?.starter?.pid !== started.identity.pid || state.starter.start_ticks !== started.identity.start_ticks) return false
    const context = remember(state)
    if (state.status === 'stopped' || state.cleanupError) throw new Error(state.error ?? state.cleanupError ?? started.output())
    if (fake && state.status === 'starting' && state.pid && groupState(context.config).processes.some(p => { try { return readFileSync(`/proc/${p.pid}/comm`, 'utf8').trim() === 'sleep' } catch { return false } })) return context
    return !fake && state.status === 'running' ? context : false
  }, 60000)
  context.starter = started
  if (!fake) assert.equal(await started.exit, 0, started.output())
  return context
}
async function start(fake = true) {
  const args = ['--no-build', ...(fake ? ['--electron', fakeElectron] : values.electron ? ['--electron', values.electron] : [])]
  return admitted(launch(args, `start-${starters.length}`), fake)
}
function signal(recorded, name) {
  if (!isLiveProcess(recorded)) return
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,signal,sys
try:
 fd=os.pidfd_open(int(sys.argv[1]))
 try:
  if open('/proc/%s/stat'%sys.argv[1]).read().rsplit(') ',1)[1].split()[19]==sys.argv[2]: signal.pidfd_send_signal(fd,getattr(signal,sys.argv[3]))
 finally: os.close(fd)
except (ProcessLookupError,FileNotFoundError): pass
`, String(recorded.pid), recorded.start_ticks, name], { env: caller, cwd: out, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
function stop(context, name = 'stop', complete = false) {
  const result = spawnSync(process.execPath, [...cli, '--stop'], { env: otherCaller, encoding: 'utf8', timeout: 50000 })
  writeFileSync(join(out, `${name}-${context.config.runId}.log`), result.stdout + result.stderr)
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.traceComplete, complete, 'Trace completion must reflect parent waitpid certificates and descendant evidence')
  remember(ownState(context.config.runId) ?? context.state)
}
function audit(context, complete = false) {
  const config = context.config, state = JSON.parse(readFileSync(join(config.run, 'receipt.json'), 'utf8'))
  assert.equal(state.status, 'stopped'); assert.equal(outstanding(state).length, 0)
  assert(!existsSync(config.root)); assert(!existsSync(config.group.path)); assert(!existsSync(hook))
  const protectedRoots = ['.config/', '.local/share/', '.local/state/', '.cache/', '.claude/', '.codex/'].map(name => join(homedir(), name)).concat(`/run/user/${process.getuid()}/`, fakeOwner, pythonPath)
  const traces = allTraces(state).map(trace => {
    if (!existsSync(join(config.run, trace.file))) { assert(!complete); return { file: trace.file, complete: false, launched: false } }
    const bytes = readFileSync(join(config.run, trace.file)), text = bytes.toString()
    if (complete) assert(traceCompleted(config.runId, trace), trace.file)
    assert(!protectedRoots.some(path => text.includes(path)), trace.file + ' protected caller path')
    const execs = text.split('\n').filter(line => line.includes('execve(') && line.includes('DBUS_SESSION_BUS_ADDRESS='))
    assert(execs.every(line => state.dbus && line.includes(`DBUS_SESSION_BUS_ADDRESS=${state.dbus}`)), 'foreign session bus')
    return { file: trace.file, sha256: createHash('sha256').update(bytes).digest('hex'), complete: traceCompleted(config.runId, trace) }
  })
  atomicJson(join(out, `audit-${config.runId}.json`), { PASS: true, rootDeleted: true, groupRemoved: true, traces })
}
async function shell(context, command) {
  const browser = await chromium.connectOverCDP(context.state.cdp)
  try {
    const page = browser.contexts()[0].pages().find(page => page.url().includes('/renderer/'))
    assert(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.session-terminal:not(.session-terminal-hidden) .terminal-surface').first().click()
    await page.keyboard.type(command); await page.keyboard.press('Enter')
  } finally { await browser.close() }
}
// Pause only while the actor owns no lifecycle lock and has no lock helper in flight.
async function pauseRecovery(context) {
  const actor = context.state.watchdog.identity
  heldActors.push(actor)
  await until(() => withLifecycleLock(() => {
    signal(actor, 'SIGSTOP')
    const recovery = allTraces(readCurrent()).find(trace => trace.key === context.state.watchdog.key)
    if (groupState({ ...context.config, group: recovery.group }).processes.some(child => child.ppid === actor.pid)) {
      signal(actor, 'SIGCONT'); return false
    }
    return true
  }))
}

// Test-only imports pause actual intent/fork/GO seams; production children get no ambient hook.
async function heldLaunch(mode) {
  const mark = join(out, `${mode}-spawn.json`), resume = join(out, `${mode}-resume`), preload = join(out, `${mode}-preload.mjs`)
  writeFileSync(preload, `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { existsSync, writeFileSync } from 'node:fs'
    const original = cp.spawn; let injected = false
    cp.spawn = function(command, args, options) {
      if (injected || command !== '/usr/bin/python3' || !args.some(arg => arg.endsWith('/bench-recorder.py'))) return original.call(this, command, args, options)
      injected = true
      if (${JSON.stringify(mode)} === 'intent') {
        writeFileSync(${JSON.stringify(mark)}, '{}')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
      }
      const child = original.call(this, command, args, options)
      if (['late', 'gate-timeout'].includes(${JSON.stringify(mode)})) {
        const end = child.stdio[3].end.bind(child.stdio[3])
        child.stdio[3].end = function(data) {
          writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ pid: child.pid }))
          const timer = setInterval(() => { if (existsSync(${JSON.stringify(resume)})) { clearInterval(timer); end(data) } }, 10)
          child.stdio[3].once('close', () => clearInterval(timer)); timer.unref()
          return this
        }
      } else {
        writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ pid: child.pid }))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
      }
      return child
    }
    syncBuiltinESMExports()
  `)
  const started = launch(['--no-build', '--electron', fakeElectron], mode, caller, ['--import', preload])
  const context = await until(() => {
    const state = readCurrent()
    if (state?.starter?.pid !== started.identity.pid) return false
    const context = remember(state)
    return existsSync(mark) ? context : false
  })
  context.starter = started
  assert.equal(groupState(context.config).populated, false)
  return { context, resume, mark }
}

async function recorderGap(mode) {
  const mark = join(out, `${mode}-recorder.json`), prebirth = join(out, `${mode}-prebirth.json`)
  const preload = join(out, `${mode}-preload.mjs`)
  const shim = `import os,sys,json,pathlib,signal,subprocess
source=sys.argv[1];sys.argv=sys.argv[1:];original=subprocess.Popen
marker=${JSON.stringify(mark)}
def launch(command,*args,**kwargs):
 if ${mode === 'prebirth' ? 'True' : 'False'}:
  i=command.index('-o')+2
  wait="import os,sys,pathlib,json,signal;f=pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split();pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'start_ticks':f[19]}));os.kill(os.getpid(),signal.SIGSTOP);os.execv(sys.argv[2],sys.argv[2:])"
  command=command[:i]+['/usr/bin/python3','-I','-S','-c',wait,${JSON.stringify(prebirth)}]+command[i:]
 child=original(command,*args,**kwargs)
 fields=pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()
 child_fields=pathlib.Path('/proc/%s/stat'%child.pid).read_text().rsplit(') ',1)[1].split()
 pathlib.Path(marker).write_text(json.dumps({'pid':os.getpid(),'start_ticks':fields[19],'tracerIdentity':{'pid':child.pid,'start_ticks':child_fields[19]}}))
 os.kill(os.getpid(),signal.SIGSTOP)
 return child
subprocess.Popen=launch
exec(compile(pathlib.Path(source).read_text(),source,'exec'),{'__file__':source,'__name__':'__main__'})
`
  writeFileSync(preload, `
    import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'
    const original = cp.spawn; let injected = false
    cp.spawn = function(command, args, options) {
      if (!injected && command === '/usr/bin/python3' && args.some(arg => arg.endsWith('/bench-recorder.py'))) {
        injected = true; const index = args.findIndex(arg => arg.endsWith('/bench-recorder.py'))
        args = ['-I','-S','-c',${JSON.stringify(shim)}, ...args.slice(index)]
      }
      return original.call(this, command, args, options)
    }; syncBuiltinESMExports()
  `)
  const started = launch(['--no-build', '--electron', fakeElectron], mode, caller, ['--import', preload])
  const context = await until(() => {
    const state = readCurrent()
    if (state?.starter?.pid !== started.identity.pid) return false
    const context = remember(state)
    return existsSync(mark) && (mode !== 'prebirth' || existsSync(prebirth)) ? context : false
  })
  context.starter = started
  const recorder = JSON.parse(readFileSync(mark, 'utf8')); heldActors.push(recorder)
  return { context, recorder, prebirth }
}

const cases = {
  async intentBeforeFork() {
    const { context } = await heldLaunch('intent')
    const entry = readCurrent().tracers.find(trace => trace.role === 'workload')
    assert.equal(entry.recorderIdentity, null)
    assert.equal(spawnSync('/usr/bin/flock', ['-n', entry.lease.path, '/bin/true'], { env: {} }).status, 1)
    assert(!existsSync(join(context.config.run, entry.recorderFile)))
    signal(context.starter.identity, 'SIGKILL'); await context.starter.exit
    stop(context, 'intent-before-fork'); audit(context)
  },
  async crashGate() {
    const { context } = await heldLaunch('crash')
    const entry = readCurrent().tracers.find(trace => trace.role === 'workload')
    assert.equal(entry.recorderIdentity, null)
    signal(context.starter.identity, 'SIGKILL'); await context.starter.exit
    stop(context, 'starter-crash'); audit(context)
  },
  async preAdmission() {
    const { context, mark } = await heldLaunch('pre-admission')
    const entry = readCurrent().tracers.find(trace => trace.role === 'workload')
    const recorder = await until(() => { const p = join(context.config.run, entry.recorderFile); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : false })
    assert.equal(recorder.admitted, false)
    const identity = processIdentity(JSON.parse(readFileSync(mark, 'utf8')).pid); heldActors.push(identity)
    signal(identity, 'SIGSTOP'); signal(context.starter.identity, 'SIGKILL'); await context.starter.exit
    const stopped = spawnSync(process.execPath, [...cli, '--stop'], { env: otherCaller, encoding: 'utf8', timeout: 50000 })
    writeFileSync(join(out, 'pre-admission-stop-error.log'), stopped.stdout + stopped.stderr)
    assert.equal(stopped.status, 1); assert(existsSync(context.config.root)); assert.equal(readCurrent().status, 'stopping'); assert(launchLeaseHeld(context.config.runId, entry))
    const refused = launch(['--no-build', '--electron', fakeElectron], 'pre-admission-new-start')
    assert.equal(await refused.exit, 1); assert.match(refused.output(), /active/u)
    signal(identity, 'SIGCONT'); await until(() => !isLiveProcess(identity))
    stop(context, 'pre-admission-retry'); audit(context)
  },
  async prebirthTrace() {
    const { context, recorder, prebirth } = await recorderGap('prebirth')
    const trace = allTraces(readCurrent()).find(trace => trace.role === 'workload')
    assert.equal(trace.identity, null); assert(groupState({ ...context.config, group: trace.group }).populated)
    assert(!existsSync(join(context.config.run, 'launcher.json')))
    const actor = JSON.parse(readFileSync(prebirth, 'utf8')); heldActors.push(actor)
    signal(context.starter.identity, 'SIGKILL'); await context.starter.exit
    stop(context, 'prebirth-tracer-drain')
    assert(!isLiveProcess(recorder)); assert(!isLiveProcess(actor)); assert(!isLiveProcess(recorder.tracerIdentity)); audit(context)
  },
  async recorderDeath() {
    const { context, recorder } = await recorderGap('recorder-fork')
    signal(recorder, 'SIGKILL')
    stop(context, 'lost-recorder-certificate'); await context.starter.exit; audit(context)
    const trace = allTraces(ownState(context.config.runId)).find(trace => trace.role === 'workload')
    assert(!existsSync(join(context.config.run, trace.certificateFile))); assert.equal(traceCompleted(context.config.runId, trace), false)
  },
  async gateTimeout() {
    const { context } = await heldLaunch('gate-timeout')
    assert.equal(await context.starter.exit, 1)
    stop(context, 'expired-launch-gate'); audit(context)
  },
  async lateAdmission() {
    const { context, resume } = await heldLaunch('late')
    transition(context.config.runId, ['starting'], state => ({ ...state, status: 'stopping' }))
    writeFileSync(resume, 'release queued GO after stopping fence')
    assert.equal(await context.starter.exit, 1)
    stop(context, 'late-admission'); audit(context)
    const trace = join(context.config.run, 'isolation.strace')
    assert(!existsSync(trace) || !readFileSync(trace, 'utf8').includes('execve("/usr/bin/dbus-run-session"'), 'Fenced launcher must not execute the workload')
  },
  async truncatedTrace() {
    const context = await start(), state = readCurrent(), workload = allTraces(state).find(trace => trace.role === 'workload')
    const actor = JSON.parse(readFileSync(join(context.config.run, workload.actorFile), 'utf8'))
    await pauseRecovery(context)
    signal({ pid: state.pid, start_ticks: state.start_ticks }, 'SIGKILL')
    await until(() => new RegExp(`^${actor.pid}\\s+\\+\\+\\+ (?:exited with \\d+|killed by .+) \\+\\+\\+$`, 'mu').test(readFileSync(join(context.config.run, workload.file), 'utf8')))
    assert(groupState(context.config).populated, 'Orphan remains after the actor marker')
    assert(!existsSync(join(context.config.run, workload.certificateFile)), 'Parent must still await its live tracer')
    signal(workload.identity, 'SIGKILL'); signal(state.watchdog.identity, 'SIGCONT')
    stop(context, 'N2-killed-after-actor'); await context.starter.exit; audit(context)
    const certificate = JSON.parse(readFileSync(join(context.config.run, workload.certificateFile), 'utf8'))
    assert.equal(certificate.signal, 9); assert.equal(traceCompleted(context.config.runId, workload), false)
  },
  async recoveryRecorderDeath() {
    const context = await start(), recovery = allTraces(readCurrent()).find(trace => trace.role === 'recovery')
    signal(recovery.recorderIdentity, 'SIGKILL')
    stop(context, 'recovery-recorder-death'); await context.starter.exit; audit(context)
    assert.equal(traceCompleted(context.config.runId, recovery), false)
  },
  async normalOrphan() {
    const marker = join(out, 'normal-orphan.json'), release = join(out, 'normal-orphan-release')
    const preload = join(out, 'normal-orphan-preload.mjs')
    const actor = `import os,json,pathlib,time
os.read(3,64);os.close(3)
actor_pid=os.getpid()
child=os.fork()
if child==0:
 fields=pathlib.Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()
 pathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({'pid':os.getpid(),'start_ticks':fields[19],'parent':actor_pid}))
 while not pathlib.Path(${JSON.stringify(release)}).exists():time.sleep(.02)
os._exit(0)
`
    const shim = `import sys,pathlib,subprocess
source=sys.argv[1];sys.argv=sys.argv[1:];original=subprocess.Popen
def launch(command,*args,**kwargs):
 i=command.index('-o')+2
 return original(command[:i]+['/usr/bin/python3','-I','-S','-c',${JSON.stringify(actor)}],*args,**kwargs)
subprocess.Popen=launch
exec(compile(pathlib.Path(source).read_text(),source,'exec'),{'__file__':source,'__name__':'__main__'})
`
    writeFileSync(preload, `
      import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'
      const original=cp.spawn; let injected=false
      cp.spawn=function(command,args,options) {
        if (!injected && command==='/usr/bin/python3' && args.some(arg=>arg.endsWith('/bench-recorder.py'))) {
          injected=true; const index=args.findIndex(arg=>arg.endsWith('/bench-recorder.py'))
          args=['-I','-S','-c',${JSON.stringify(shim)},...args.slice(index)]
        }
        return original.call(this,command,args,options)
      };syncBuiltinESMExports()
    `)
    const started = launch(['--no-build', '--electron', fakeElectron], 'normal-orphan-start', caller, ['--import', preload])
    const context = await until(() => {
      const state = readCurrent()
      return state?.starter?.pid === started.identity.pid && existsSync(marker) ? remember(state) : false
    })
    context.starter = started
    await pauseRecovery(context)
    const workload = allTraces(readCurrent()).find(trace => trace.role === 'workload')
    const orphan = JSON.parse(readFileSync(marker, 'utf8'))
    await until(() => new RegExp(`^${orphan.parent}\\s+\\+\\+\\+ exited with 0 \\+\\+\\+$`, 'mu').test(readFileSync(join(context.config.run, workload.file), 'utf8')))
    assert(isLiveProcess(orphan)); assert(!existsSync(join(context.config.run, workload.certificateFile)))
    assert(launchLeaseHeld(context.config.runId, workload)); assert.equal(traceCompleted(context.config.runId, workload), false)
    // Only the recorder keeps the inherited lease; neither tracer nor its orphan can hold it.
    const holders = groupState({ ...context.config, group: workload.group }).processes.filter(identity =>
      readdirSync(`/proc/${identity.pid}/fd`).some(fd => {
        try { return readlinkSync(`/proc/${identity.pid}/fd/${fd}`) === workload.lease.path } catch { return false }
      }))
    assert.deepEqual(holders.map(identity => identity.pid), [workload.recorderIdentity.pid])
    const leaseProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readdirSync,readlinkSync } from 'node:fs'
      if(readdirSync('/proc/self/fd').some(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===process.argv[1]}catch{return false}}))process.exit(9)
    `, workload.lease.path], { env: caller, encoding: 'utf8' })
    assert.equal(leaseProbe.status, 0, leaseProbe.stderr)
    writeFileSync(release, 'Let the last traced descendant exit normally')
    await until(() => traceCompleted(context.config.runId, workload))
    assert(!isLiveProcess(orphan)); assert(!launchLeaseHeld(context.config.runId, workload))
    signal(context.state.watchdog.identity, 'SIGCONT')
    assert.equal(await started.exit, 1)
    stop(context, 'normal-orphan-complete', true); audit(context, true)
    atomicJson(join(out, 'normal-orphan-proof.json'), { PASS: true, orphan, actorExitPrecededCertificate: true, leaseHolders: holders, unrelatedHelperLease: false, normalZeroCertificate: true })
  },
  async certificateTamper() {
    const context = await start()
    stop(context, 'certificate-fixture'); await context.starter.exit; audit(context)
    const trace = allTraces(readCurrent()).find(trace => trace.role === 'recovery' && traceCompleted(context.config.runId, trace))
    assert(trace, 'A real normal-zero recovery certificate is required')
    const certificatePath = join(context.config.run, trace.certificateFile), tracePath = join(context.config.run, trace.file)
    const certificate = JSON.parse(readFileSync(certificatePath, 'utf8')), bytes = readFileSync(tracePath), rejected = []
    const variants = {
      generation: { runId: '0-0000000000000000' }, launch: { launchKey: '0000000000000000' }, role: { role: 'workload' },
      recorder: { recorderIdentity: { ...certificate.recorderIdentity, start_ticks: '0' } }, tracer: { tracerIdentity: { ...certificate.tracerIdentity, start_ticks: '0' } },
      group: { launchGroupIdentity: { ...certificate.launchGroupIdentity, inode: -1 } }, waitStatus: { rawWaitStatus: 9 },
      tracingError: { traceErrors: ['strace: Process 1 detached'] }, hash: { traceSha256: '0'.repeat(64) }
    }
    for (const [name, change] of Object.entries(variants)) {
      atomicJson(certificatePath, { ...certificate, ...change })
      assert.equal(traceCompleted(context.config.runId, trace), false, name); rejected.push(name)
    }
    writeFileSync(certificatePath, '{"version":'); assert.equal(traceCompleted(context.config.runId, trace), false); rejected.push('truncatedCertificate')
    atomicJson(certificatePath, certificate)
    writeFileSync(tracePath, bytes.subarray(0, Math.floor(bytes.length / 2)))
    assert.equal(traceCompleted(context.config.runId, trace), false); rejected.push('truncatedTrace')
    writeFileSync(tracePath, bytes)
    renameSync(tracePath, tracePath + '.original')
    try {
      writeFileSync(tracePath, bytes)
      assert.equal(traceCompleted(context.config.runId, trace), false); rejected.push('substitutedTrace')
    } finally { rmSync(tracePath); renameSync(tracePath + '.original', tracePath) }
    assert.equal(traceCompleted(context.config.runId, trace), true, 'Restoring authentic bytes/identity restores completion')
    atomicJson(join(out, 'certificate-tamper-proof.json'), { PASS: true, rejected, restored: true })
  },
  async preservedFailure() {
    const context = await start()
    transition(context.config.runId, ['starting'], state => ({ ...state, status: 'stopping', root: fakeOwner }))
    await until(() => !isLiveProcess(ownState(context.config.runId)?.watchdog?.identity))
    assert(existsSync(context.config.root)); assert(groupState(context.config).populated)
    assert.equal(ownState(context.config.runId).status, 'stopping')
    transition(context.config.runId, ['stopping'], state => ({ ...state, root: context.config.root }))
    stop(context, 'retry-preserved-root'); await context.starter.exit; audit(context)
  },
  async traceDeath() {
    const context = await start()
    signal(context.state.watchdog.tracer, 'SIGKILL')
    await until(() => !isLiveProcess(context.state.watchdog.identity))
    stop(context, 'trace-death', false); await context.starter.exit; audit(context, false)
    const proof = JSON.parse(readFileSync(join(context.config.run, 'completion-proof.json'), 'utf8'))
    assert(proof.traces.some(trace => !trace.complete), 'Killed tracer must remain incomplete evidence')
  },
  async startup() {
    const context = await start()
    assert.throws(() => killGroup({ ...context.config, group: { ...context.config.group, inode: -1 } }), /substituted/u)
    assert.throws(() => killGroup({ ...context.config, group: { ...context.config.group, kill: { ...context.config.group.kill, inode: -1 } } }), /substituted/u)
    assert.equal(groupState(context.config).populated, true, 'Forged group or control identity must have no effect')
    atomicJson(join(context.config.run, 'startup-processes.json'), [{ pid: process.pid, start_ticks: processIdentity(process.pid).start_ticks }])
    stop(context, 'alternate-tmpdir')
    assert.equal(await context.starter.exit, 1)
    audit(context)
  },
  async timeout() {
    const context = await start()
    signal({ pid: context.state.pid, start_ticks: context.state.start_ticks }, 'SIGSTOP')
    assert.equal(await context.starter.exit, 1)
    await until(() => { const state = ownState(context.config.runId); return state?.status === 'stopped' && outstanding(state).length === 0 }, 45000)
    stop(context, 'timeout-completion'); audit(context)
  },
  async generation() {
    const a = await start(); signal(a.starter.identity, 'SIGSTOP'); stop(a, 'stop-paused-A')
    const b = await start(); signal(a.starter.identity, 'SIGCONT'); assert.equal(await a.starter.exit, 1)
    const current = ownState(b.config.runId); assert.equal(current?.status, 'starting'); assert(isLiveProcess({ pid: current.pid, start_ticks: current.start_ticks }))
    stop(b, 'stop-B'); assert.equal(await b.starter.exit, 1); audit(a); audit(b)
  },
  async controller() {
    const context = await start(false), before = new Set(context.state.processes.map(p => `${p.pid}:${p.start_ticks}`))
    const sentinel = spawn('/bin/sleep', ['600'], { env: caller, stdio: 'ignore' }); const sentinelIdentity = processIdentity(sentinel.pid); foreign.push(sentinelIdentity)
    atomicJson(join(context.config.run, 'startup-processes.json'), [sentinelIdentity])
    await shell(context, '/usr/bin/nohup /bin/sleep 600 >/dev/null 2>&1 & disown; exit')
    const orphan = await until(() => groupState(context.config).processes.find(p => { try { return !before.has(`${p.pid}:${p.start_ticks}`) && readFileSync(`/proc/${p.pid}/comm`, 'utf8').trim() === 'sleep' } catch { return false } }))
    atomicJson(join(out, 'orphan.json'), { ...orphan, absentFromInitialJournal: true })
    signal({ pid: context.state.pid, start_ticks: context.state.start_ticks }, 'SIGKILL')
    stop(context, 'dead-controller'); assert(isLiveProcess(sentinelIdentity), 'Diagnostic PID must not authorize a signal'); assert(!isLiveProcess(orphan)); audit(context)
    signal(sentinelIdentity, 'SIGTERM')
  },
  async claimant() {
    const context = await start(); signal({ pid: context.state.pid, start_ticks: context.state.start_ticks }, 'SIGSTOP')
    const stopper = launch(['--stop'], 'claimant-stop', otherCaller)
    const claim = await until(() => ownState(context.config.runId)?.stopClaim)
    signal(claim.identity, 'SIGKILL'); assert.equal(await stopper.exit, 0, stopper.output())
    assert.equal(await context.starter.exit, 1); const state = ownState(context.config.runId); assert(state.tracers.filter(t => t.role === 'recovery').length >= 2); audit(context)
    // Replay the exact durable crash state after deletion but before stopped publication.
    transition(context.config.runId, ['stopped'], state => ({ ...state, status: 'stopping', stoppedAt: undefined }))
    stop(context, 'post-deletion-replay'); audit(context)
  },
  async concurrent() {
    const args = ['--no-build', '--electron', fakeElectron]
    const a = launch(args, 'concurrent-A'), b = launch(args, 'concurrent-B')
    const winner = await until(() => { const state = readCurrent(); return [a.identity.pid, b.identity.pid].includes(state?.starter?.pid) ? state.starter.pid : false })
    const context = await admitted(winner === a.identity.pid ? a : b, true), loser = winner === a.identity.pid ? b : a
    assert.equal(await loser.exit, 1); assert.match(loser.output(), /active/u)
    const first = launch(['--stop'], 'concurrent-stop-1', otherCaller), second = launch(['--stop'], 'concurrent-stop-2', otherCaller)
    assert.equal(await first.exit, 0, first.output()); assert.equal(await second.exit, 0, second.output())
    assert.equal(await context.starter.exit, 1); const proofs = JSON.parse(readFileSync(join(context.config.run, 'receipt.json'), 'utf8')).tracers.filter(t => t.role === 'recovery'); assert.equal(proofs.length, 1); audit(context)
  },
  async natural() {
    const context = await start(false)
    const app = context.state.processes.find(p => { try { return p.ppid === context.state.pid && readlinkSync(`/proc/${p.pid}/exe`).includes('/electron') } catch { return false } })
    assert(app, 'Actual Electron main process'); signal(app, 'SIGTERM')
    const browser = await chromium.connectOverCDP(context.state.cdp)
    try {
      const page = browser.contexts()[0].pages().find(page => page.url().includes('/renderer/'))
      // A live-session quit intentionally waits for BMN's confirmation; a signal alone is not an exit.
      await page.getByRole('dialog', { name: 'Quit BMN?', exact: true }).getByRole('button', { name: 'Quit BMN', exact: true }).click()
    } finally { await browser.close().catch(() => {}) }
    await until(() => { const state = ownState(context.config.runId); return state?.status === 'stopped' && outstanding(state).length === 0 }, 20000)
    assert(!existsSync(context.config.root), 'Natural app termination cleans roots without a CLI stop')
    stop(context, 'natural-completion-proof', true); audit(context, true)
  },
  async shutdownFork() {
    const context = await start(false), marker = join(context.config.root, 'fork-during-shutdown'), armed = join(context.config.root, 'armed-shell.pid')
    const trigger = join(context.config.root, 'release-shutdown-fork'), childFile = join(context.config.root, 'shutdown-child.pid')
    await shell(context, `(while [ ! -f ${quote(trigger)} ]; do /bin/sleep 0.02; done; /bin/sleep 600 & printf '%s' "$!" > ${quote(childFile)}; printf forked > ${quote(marker)}) & printf '%s' "$!" > ${quote(armed)}`)
    await until(() => existsSync(armed))
    signal({ pid: context.state.pid, start_ticks: context.state.start_ticks }, 'SIGSTOP')
    const stopper = launch(['--stop'], 'shutdown-fork-stop', otherCaller)
    await until(() => ownState(context.config.runId)?.stopClaim)
    writeFileSync(trigger, 'Fork only after the actual stopping claim')
    await until(() => existsSync(marker), 1200)
    const child = processIdentity(Number(readFileSync(childFile, 'utf8')))
    assert(child && groupState(context.config).processes.some(p => p.pid === child.pid && p.start_ticks === child.start_ticks), 'New fork belongs to the kernel-owned workload')
    assert.equal(ownState(context.config.runId)?.status, 'stopping')
    atomicJson(join(out, 'shutdown-fork.json'), { child, observedWhileStopping: ownState(context.config.runId)?.status === 'stopping' })
    assert.equal(await stopper.exit, 0, stopper.output()); assert(!isLiveProcess(child)); audit(context)
  }
}

try {
  const previous = readCurrent(); assert(!previous || (previous.status === 'stopped' && outstanding(previous).length === 0), 'Stop an existing bench before this test')
  const names = selected === 'all' ? Object.keys(cases) : selected === 'recorder' ? ['intentBeforeFork', 'crashGate', 'preAdmission', 'prebirthTrace', 'recorderDeath', 'gateTimeout', 'lateAdmission', 'truncatedTrace', 'recoveryRecorderDeath', 'normalOrphan', 'certificateTamper'] : selected === 'delta' ? ['normalOrphan', 'certificateTamper', 'preservedFailure', 'traceDeath', 'startup', 'generation', 'controller', 'claimant', 'concurrent', 'natural', 'shutdownFork'] : [selected]
  for (const name of names) {
    assert(cases[name], 'Unknown lifecycle case')
    await cases[name](); results.push({ case: name, PASS: true }); atomicJson(join(out, 'results.json'), results); console.log(`PASS: ${name}`)
  }
} finally {
  for (const actor of heldActors) signal(actor, 'SIGCONT')
  for (const p of foreign) signal(p, 'SIGTERM')
  for (const started of starters) if (isLiveProcess(started.identity)) signal(started.identity, 'SIGCONT')
  const current = readCurrent()
  if (current && contexts.has(current.runId) && current.status !== 'stopped') {
    const result = spawnSync(process.execPath, [...cli, '--stop'], { env: otherCaller, encoding: 'utf8', timeout: 50000 }); writeFileSync(join(out, 'finalizer-stop.log'), result.stdout + result.stderr)
  }
  // Tests may fail, but only kernel-owned workloads and their recorded test actors are teardown targets.
  for (const { config, state } of contexts.values()) {
    if (existsSync(config.group.path) && groupState(config).populated) killGroup(config)
    const receipt = existsSync(join(config.run, 'receipt.json')) ? JSON.parse(readFileSync(join(config.run, 'receipt.json'), 'utf8')) : state
    for (const trace of allTraces(receipt)) {
      if (groupState({ ...config, group: trace.group }).populated) killGroup({ ...config, group: trace.group })
      if (trace.recorderIdentity) signal(trace.recorderIdentity, 'SIGKILL')
      const birth = join(config.run, trace.actorFile)
      if (existsSync(birth)) signal(JSON.parse(readFileSync(birth, 'utf8')), 'SIGKILL')
      if (trace.identity) signal(trace.identity, 'SIGKILL')
    }
  }
  for (const started of starters) if (isLiveProcess(started.identity)) signal(started.identity, 'SIGKILL')
  if ([...contexts.values()].every(({ config }) => !existsSync(config.root))) rmSync(parent, { recursive: true, force: true })
}
