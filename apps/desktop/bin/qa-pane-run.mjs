// MODULE: qa-pane-run.mjs - execute a prepared QA command without reading the approved team
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { call, readCredentials } from './bmn-commands.mjs'
import { codexMcpServers, sameProgram } from './agents-team-forms.mjs'
import { browserLaunchHelper, processIdentity } from './browser-process.mjs'
import { writeWhole } from './agents-team-supervisor.mjs'

const QA_SCOPE_ENV = ['BMN_TOKEN', 'BMN_CONTROL_SOCKET', 'BMN_SESSION_ID', 'BMN_INCARNATION_ID', 'BMN_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
// A shebang child can still be /usr/bin/env when spawn returns. Wait for the
// pinned command on that same child; qa.agent remains the registration authority.
export async function waitForQaChild(child, launch, folder, timeoutMs = 3000) {
  const identity = processIdentity(child.pid), began = performance.now()
  if (!child.pid || !identity.ticks) throw new Error('QA_AGENT_NOT_READY')
  const expected = launch.built.command, cwd = realpathSync(folder)
  let polls = 0
  while (performance.now() - began < timeoutMs) {
    if (child.pid !== identity.pid || child.exitCode !== null || child.signalCode !== null || processIdentity(identity.pid).ticks !== identity.ticks) throw new Error('QA_AGENT_NOT_READY')
    polls++
    try {
      const fields = readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')
      const argv = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      const form = JSON.stringify(argv) === JSON.stringify(expected) ? 'exact'
        : argv.length === expected.length + 1 && realpathSync(argv[1]) === launch.identity.launcher.real && JSON.stringify(argv.slice(2)) === JSON.stringify(expected.slice(1)) ? 'node' : null
      if (form && fields[19] === identity.ticks && Number(fields[1]) === process.pid && realpathSync(`/proc/${identity.pid}/cwd`) === cwd && processIdentity(identity.pid).ticks === identity.ticks) {
        return { ...identity, parent: Number(fields[1]), form, polls, elapsedMs: Math.ceil(performance.now() - began) }
      }
    } catch { /* The interpreter can be between execs; only a complete matching sample is ready. */ }
    await new Promise(done => setTimeout(done, Math.min(10, Math.max(1, timeoutMs - (performance.now() - began)))))
  }
  throw new Error('QA_AGENT_NOT_READY')
}
export async function runQaPane(id, folder, environment = process.env) {
  const trace = { phase: 'prepared-command', runnerPid: process.pid }
  try { return await executeQaPane(id, folder, environment, trace) }
  catch (error) {
    const diagnostic = { version: 1, ...trace,
      code: /^QA_[A-Z0-9_]+/.exec(String(error.message))?.[0] ?? 'QA_STARTUP_FAILED',
      protocolCode: typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : null }
    // Only closed phase/code/process metadata: never raw CLI diagnostics, environment or credentials.
    try {
      const path = join(folder, 'startup-failure.json'), body = JSON.stringify(diagnostic)
      writeWhole(path, body + '\n')
      if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== body) throw new Error('QA_DIAGNOSTIC_CHANGED', { cause: error })
    } catch { /* Retain the original failure if the diagnostic itself could not be written. */ }
    throw error
  }
}
async function executeQaPane(id, folder, environment, trace) {
  const launch = JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8'))
  if (launch.qaId !== id || launch.form !== 'codex-qa' || !sameProgram(launch.identity, launch.program)) throw new Error('QA_LAUNCH_CHANGED')
  trace.phase = 'credentials'
  const credentials = readCredentials({})
  trace.phase = 'bound-policy'
  let policy
  for (let attempt = 0; attempt < 30; attempt++) {
    policy = await call(credentials.socketPath, credentials.token, 'qa.policy', {})
    if (policy?.qaId === id) break
    await new Promise(done => setTimeout(done, 100))
  }
  if (policy?.qaId !== id) throw new Error('QA_SESSION_UNBOUND')
  const built = launch.built
  const config = built.command.flatMap((arg, index) => arg === '-c' ? [built.command[index + 1]] : [])
  trace.phase = 'native-mcp-config'
  codexMcpServers(launch.program, folder, built.environment, { config, enabled: ['playwright'], browserServer: launch.server })
  const scope = Object.fromEntries(QA_SCOPE_ENV.filter(name => environment[name] !== undefined).map(name => [name, environment[name]]))
  trace.phase = 'native-spawn'
  const child = spawn(built.command[0], built.command.slice(1), { cwd: folder, env: { ...built.environment, ...scope }, stdio: ['pipe', 'inherit', 'inherit'] })
  const identity = processIdentity(child.pid)
  const exit = new Promise((done, fail) => { child.once('error', fail); child.once('exit', code => done(code ?? 1)) })
  try {
    if (!child.pid) throw new Error('QA_AGENT_MISSING')
    trace.phase = 'native-readiness'
    trace.agent = await waitForQaChild(child, launch, folder)
    trace.phase = 'agent-registration'
    await call(credentials.socketPath, credentials.token, 'qa.agent', { pid: trace.agent.pid, ticks: trace.agent.ticks })
    writeWhole(join(folder, 'agent-readiness.json'), JSON.stringify(trace.agent) + '\n')
    trace.phase = 'prompt'
    child.stdin.end(readFileSync(join(folder, 'inputs/prompt.md')))
  } catch (error) {
    if (identity.pid && identity.ticks) spawnSync('/usr/bin/python3', [browserLaunchHelper(), '--terminate'], {
      input: JSON.stringify({ owner: processIdentity(), child: identity }), stdio: ['pipe', 'ignore', 'ignore'] })
    await exit.catch(() => undefined); throw error
  }
  trace.phase = 'native-exit'
  return exit
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--run') {
  runQaPane(process.argv[3], process.argv[4]).then(code => { process.exitCode = code }).catch(() => { process.stderr.write('QA pane failed; inspect its retained record.\n'); process.exitCode = 1 })
}
