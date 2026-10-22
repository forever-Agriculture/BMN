// MODULE: doctor-adapters.mjs - Bounded process groups, read-only doctor sandbox and disposable version qualification
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseBmnDoctor, parseClaudeDoctor, parseCodexDoctor } from './doctor-results.mjs'
import { leftoversModule } from './doctor-leftovers.mjs'
import { selectedProfile } from './doctor-profile.mjs'

export const SANDBOX_POLICY = 'bwrap-selected-profile-qualification-masked-v3'
export const PARSER_VERSION = 'doctor-projection-v3-hook-contract'
export const LIMITS = Object.freeze({ timeoutMs: 60000, outputBytes: 1024 * 1024 })
const sha = (text) => createHash('sha256').update(text).digest('hex')
const unavailable = (state) => ({ state, problems: [] })
const appParser = (app) => app === 'claude' ? parseClaudeDoctor : parseCodexDoctor

/** Output is bounded while streaming. Error objects and raw output never leave the execution/parser boundary. */
export function boundedProcess(command, args, { environment, timeoutMs = LIMITS.timeoutMs, outputBytes = LIMITS.outputBytes, cwd = '/' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = []
    let bytes = 0
    let failure = null
    let closed = false
    const kill = (reason) => {
      failure ??= reason
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone; close still drains the pipes. */ }
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const collect = (chunk, keep) => {
      bytes += chunk.length
      if (bytes > outputBytes) { stdout = []; kill('overflow'); return }
      if (failure === null && keep) stdout.push(chunk)
    }
    child.stdout.on('data', (chunk) => collect(chunk, true))
    child.stderr.on('data', (chunk) => collect(chunk, false))
    const finish = (code) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      resolve({ code, failure, stdout: failure === null ? Buffer.concat(stdout).toString('utf8') : '' })
      stdout = []
    }
    child.on('error', () => { failure = 'unavailable'; finish(null) })
    child.on('close', (code) => finish(code))
  })
}

export function doctorEnvironment(environment, home = environment.HOME ?? homedir()) {
  return {
    ...Object.fromEntries(Object.entries(selectedProfile({ ...environment, HOME: home }).paths)
      .filter(([name]) => name === 'HOME' || environment[name] !== undefined)),
    PATH: environment.PATH || '/usr/local/bin:/usr/bin:/bin', TERM: 'dumb', LANG: 'C.UTF-8', NO_COLOR: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', ELECTRON_RUN_AS_NODE: '1'
  }
}

export function sandboxArguments(home, command, args, environment = {}) {
  const profile = selectedProfile({ ...environment, HOME: home })
  if (profile.invalid || profile.unavailable) throw new Error('selected profile unavailable')
  const mounts = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp']
  const restored = new Set()
  const restore = (path) => {
    if (restored.has(path) || !['/tmp/', '/var/tmp/'].some((prefix) => path.startsWith(prefix))) return
    try {
      const real = realpathSync(path)
      // Preserve embedded absolute paths and selected symlinks instead of remapping their contents.
      if (real !== path) {
        restore(dirname(path)); restore(real)
        if (lstatSync(path).isSymbolicLink()) mounts.push('--symlink', readlinkSync(path), path)
        else mounts.push('--ro-bind', path, path)
      } else mounts.push('--ro-bind', path, path)
      restored.add(path)
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  for (const path of Object.values(profile.paths)) restore(path)
  // OpenCode opens its log for writing even for --version; it gets a throwaway folder in place of the real one.
  const openCodeLog = join(profile.paths.XDG_DATA_HOME, 'opencode/log')
  try { if (lstatSync(openCodeLog).isDirectory()) mounts.push('--tmpfs', openCodeLog) } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  // The scratch directory must never be placed inside a selected read-only subtree.
  const scratch = '/tmp/bmn-doctor-work'
  if (Object.values(profile.paths).some((path) => scratch === path || scratch.startsWith(`${path}/`))) throw new Error('scratch overlaps selected profile')
  return [...mounts, '--dir', scratch, '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', scratch, '--', command, ...args]
}

export async function sandboxProcess(home, command, args, environment, limits = {}) {
  try {
    const { inspection = false, ...bounds } = limits
    const fixed = doctorEnvironment(environment, home)
    if (inspection && environment.OPENCODE_CONFIG_CONTENT) fixed.OPENCODE_CONFIG_CONTENT = 'set'
    return await boundedProcess('/usr/bin/bwrap', sandboxArguments(home, command, args, environment),
      { environment: fixed, ...bounds })
  } catch { return { code: null, failure: 'unavailable', stdout: '' } }
}

/** Qualification never exposes an owner's home/profile, even through absolute or passwd-derived paths. */
export async function qualificationProcess(home, command, args, environment, limits = {}) {
  try {
    const mounts = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp']
    const masked = new Set(['/home', '/root', ...Object.values(selectedProfile(environment).paths), homedir()])
    for (const path of [...masked].sort((a, b) => a.length - b.length)) {
      if (!isAbsolute(path) || path === '/' || path === '/tmp' || path === '/var/tmp') throw new Error('qualification isolation unavailable')
      if (!existsSync(path)) continue
      const info = (await import('node:fs')).statSync(path)
      mounts.push(...(info.isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]))
    }
    // Only the exact approved executable and Node runtime are restored beneath masked directories.
    for (const path of new Set([realpathSync(command), realpathSync(process.execPath), ...runtimeDependencies(command).directories])) mounts.push('--ro-bind', path, path)
    mounts.push('--dir', '/tmp/profile', '--ro-bind', home, '/tmp/profile', '--dir', '/tmp/work',
      '--unshare-pid', '--die-with-parent', '--new-session', '--chdir', '/tmp/work', '--', command, ...args)
    const disposable = doctorEnvironment({ PATH: `${dirname(command)}:${dirname(process.execPath)}:/usr/bin:/bin` }, '/tmp/profile')
    return await boundedProcess('/usr/bin/bwrap', mounts, { environment: disposable, ...limits })
  } catch { return { code: null, failure: 'unavailable', stdout: '' } }
}

function resolveExecutable(app, environment) {
  for (const folder of (environment.PATH || '').split(delimiter).filter(Boolean)) {
    try {
      if (!isAbsolute(folder)) continue
      const path = realpathSync(join(folder, app))
      accessSync(path, constants.X_OK)
      // Health also skips BMN's hook-forwarding wrapper; its environment is deliberately absent here.
      if (app === 'codex' && readFileSync(path).equals(readFileSync(new URL('./codex', import.meta.url)))) continue
      return path
    } catch { /* Try the next PATH entry. */ }
  }
  return null
}

function runtimeDependencies(command) {
  const path = realpathSync(command)
  if (!path.endsWith('/@openai/codex/bin/codex.js')) return { directories: [], binaries: [] }
  const root = dirname(dirname(path))
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== '@openai/codex') throw new Error('unrecognized runtime')
  const target = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  if (process.platform !== 'linux' || !target) throw new Error('unrecognized runtime')
  const require = createRequire(path)
  let platformRoot
  try { platformRoot = dirname(require.resolve(`@openai/codex-linux-${process.arch}/package.json`)) }
  catch { platformRoot = root }
  const binary = join(platformRoot, 'vendor', `${target}-unknown-linux-musl/bin/codex`)
  accessSync(binary, constants.X_OK)
  return { directories: [root, platformRoot], binaries: [binary] }
}

export function executableIdentity(path) {
  // Bind to executable bytes as well as its path; same-version replacement must qualify again.
  return sha(JSON.stringify([path, sha(readFileSync(path)), runtimeDependencies(path).binaries.map((binary) => sha(readFileSync(binary))), PARSER_VERSION, SANDBOX_POLICY]))
}

export async function doctorVersions(environment) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-doctor-version-'))
  const versions = {}
  try {
    for (const app of ['claude', 'codex', 'opencode']) {
      const executable = resolveExecutable(app, environment)
      if (executable === null) { versions[app] = { executable: null, version: null, identity: sha(`${app}:missing`) }; continue }
      let identity
      try { identity = executableIdentity(executable) } catch { identity = sha(`${app}:unreadable`); versions[app] = { executable: null, version: null, identity }; continue }
      const run = await qualificationProcess(root, executable, ['--version'], environment, { timeoutMs: 10000, outputBytes: 16384 })
      const match = run.failure === null && run.code === 0 ? /^(?:(?:claude(?: code)?|codex(?:-cli)?|opencode)\s+)?(\d+\.\d+\.\d+)(?:\s|$)/i.exec(run.stdout.trim()) : null
      const version = match?.[1] ?? null
      versions[app] = { executable, version, identity: sha(`${identity}:${version}`) , executableIdentity: identity }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
  return { apps: versions, identity: sha(JSON.stringify([PARSER_VERSION, Object.fromEntries(Object.entries(versions).map(([app, entry]) => [app, entry.identity]))])) }
}

export function stillSameExecutable(entry) {
  try { return executableIdentity(entry.executable) === entry.executableIdentity } catch { return false }
}

function plantQualification(home, app) {
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  const secret = 'sk-SYNTHETIC-BMN-DOCTOR-QUALIFICATION-abcdef123456'
  if (app === 'codex') {
    writeFileSync(join(home, '.codex/config.toml'), '[mcp_servers.bmn_doctor_missing]\ncommand = "bmn-doctor-missing-program"\n[mcp_servers.bmn_doctor_remote]\nurl = "http://127.0.0.1:9/mcp"\n')
    writeFileSync(join(home, '.codex/auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), { mode: 0o600 })
  } else {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ installMethod: 'synthetic', mcpServers: { bmn_doctor_missing: { command: 'bmn-doctor-missing-program', env: { TOKEN: secret } } } }), { mode: 0o600 })
  }
}

export async function qualifyDoctor(app, entry, environment, limits) {
  if (!entry.executable || !entry.version || !stillSameExecutable(entry)) return 'unsupported'
  const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-qualify-'))
  try {
    plantQualification(home, app)
    const run = await qualificationProcess(home, entry.executable, app === 'codex' ? ['doctor', '--json'] : ['doctor'], environment, limits)
    if (run.failure !== null) return run.failure === 'timeout' ? 'timeout' : 'failed'
    const parsed = appParser(app)(run.stdout, run.code)
    const expected = app === 'codex' ? 'missing-program' : 'installation-check'
    return ['passed', 'problems'].includes(parsed.state) && parsed.problems.some((row) => row.code === expected) && stillSameExecutable(entry)
      ? 'qualified' : 'unsupported'
  } finally { rmSync(home, { recursive: true, force: true }) }
}

export async function runAppDoctor(app, entry, home, environment, limits) {
  if (!entry.executable || !entry.version || !stillSameExecutable(entry)) return unavailable('unqualified')
  const run = await sandboxProcess(home, entry.executable, app === 'codex' ? ['doctor', '--json'] : ['doctor'], environment, limits)
  if (run.failure !== null) return unavailable(run.failure === 'timeout' ? 'timeout' : 'failed')
  if (!stillSameExecutable(entry)) return unavailable('unqualified')
  return appParser(app)(run.stdout, run.code)
}

export async function runBmnDoctor(check, home, environment, limits) {
  const packaged = new URL('./bmn.mjs', import.meta.url)
  const cli = fileURLToPath(existsSync(packaged) ? packaged : new URL('./bmn', import.meta.url))
  const run = await sandboxProcess(home, process.execPath, [cli, check, 'check', '--json'], environment, { ...limits, inspection: true })
  if (run.failure !== null) return unavailable(run.failure === 'timeout' ? 'timeout' : 'failed')
  return parseBmnDoctor(check, run.stdout, run.code)
}

export async function runLeftoversDoctor(home, environment, versions, limits) {
  const program = 'import(process.argv[1]).then(m=>m.inspectLeftovers(JSON.parse(process.argv[2]))).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>{process.exitCode=1})'
  const run = await sandboxProcess(home, process.execPath, ['--input-type=module', '--eval', program,
    leftoversModule, JSON.stringify(versions)], environment, { ...limits, inspection: true })
  if (run.failure !== null) return unavailable(run.failure === 'timeout' ? 'timeout' : 'failed')
  if (run.code !== 0) return unavailable('failed')
  try { return JSON.parse(run.stdout) } catch { return unavailable('failed') }
}

