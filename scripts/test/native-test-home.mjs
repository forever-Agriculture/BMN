// MODULE: native-test-home.mjs - Epic 125 D2: the one home and the two profiles a native test may use, and the refusal of every other
//
// A native test drives a real Claude Code or Codex. It may do so only in the tests' own folders, signed in once by the owner:
//   ~/.local/state/bmn/test-profiles/home     HOME, with every XDG and BMN root below it
//   ~/.local/state/bmn/test-profiles/claude   CLAUDE_CONFIG_DIR
//   ~/.local/state/bmn/test-profiles/codex    CODEX_HOME
// Every native driver calls `assertNativeTestEnvironment(process.env)` before anything else, and again on the environment it
// hands to what it launches. Start a driver through this file, which builds that environment and nothing more:
//   node scripts/test/native-test-home.mjs -- node plan/references/111/measure/cards.mjs ...
// Nothing here opens, links or copies a sign-in file: a sign-in is checked by its presence and type only.
import { spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The roots an app or BMN resolves its own files from; each must be named and must lie below the test home. */
export const NATIVE_TEST_HOME_ROOTS = Object.freeze(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'])
/** BMN's own roots: optional, but below the test home when named. */
export const NATIVE_TEST_BMN_ROOTS = Object.freeze(['BMN_CONFIG_HOME', 'BMN_DATA_HOME', 'BMN_STATE_HOME', 'BMN_RUNTIME_HOME'])
/** A caller's credential or its own BMN session, handed on by mistake, would act as him: refused by name, never read. */
export const NATIVE_TEST_FORBIDDEN_VARIABLES = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'BMN_TOKEN', 'BMN_SESSION_ID', 'BMN_CONTROL_SOCKET', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GNUPGHOME', 'GH_TOKEN', 'GITHUB_TOKEN'
])
const SIGN_INS = Object.freeze({ claude: '.credentials.json', codex: 'auth.json' })

export class NativeTestEnvironmentError extends Error {
  constructor(reason) {
    super(`REFUSED: native tests run only on the test home and profiles (Epic 125 D2): ${reason}`)
    this.name = 'NativeTestEnvironmentError'
    this.code = 'NATIVE_TEST_ENVIRONMENT'
    this.reason = reason
  }
}

/** The owner's real home, from the account record and never from `HOME`, which a test run replaces. */
export function nativeTestRoot(realHome = userInfo().homedir) {
  return join(realHome, '.local/state/bmn/test-profiles')
}

const inside = (path, folder) => path.startsWith(folder + sep)

/**
 * Throws unless `env` names the test home, every XDG root below it and the two test profiles, with no link at or below
 * the test-profiles folder and no path that resolves outside it. Returns the four folders. Reads no file's content.
 */
export function assertNativeTestEnvironment(env, { root = nativeTestRoot(), fs = nodeFs } = {}) {
  const refuse = reason => { throw new NativeTestEnvironmentError(reason) }
  if (!isAbsolute(root) || resolve(root) !== root) refuse('the test-profiles folder is not an absolute, plain path')
  let rootState
  try { rootState = fs.lstatSync(root) } catch { refuse(`the test-profiles folder does not exist (${root})`) }
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) refuse('the test-profiles folder is a link or not a folder')
  if (fs.realpathSync(root) !== root) refuse('a parent of the test-profiles folder is a link')
  const home = join(root, 'home'), claude = join(root, 'claude'), codex = join(root, 'codex')

  /** No link in any existing part of `path` below the root, and the deepest existing part resolves inside the root. */
  const plain = (name, path) => {
    const parts = path.slice(root.length + 1).split(sep)
    let current = root
    for (const part of parts) {
      current = join(current, part)
      let state
      try { state = fs.lstatSync(current) } catch (error) {
        if (error?.code === 'ENOENT') return
        refuse(`${name} cannot be read`)
      }
      if (state.isSymbolicLink()) refuse(`${name} has a link in its path`)
      const real = fs.realpathSync(current)
      if (real !== current) refuse(`${name} resolves outside the test-profiles folder`)
    }
  }
  const named = (name) => {
    const value = env[name]
    if (typeof value !== 'string' || value === '') refuse(`${name} is missing`)
    if (!isAbsolute(value) || resolve(value) !== value) refuse(`${name} is not an absolute, plain path`)
    return value
  }
  const exact = (name, expected) => {
    if (named(name) !== expected) refuse(`${name} is not the test folder`)
    plain(name, expected)
  }
  exact('HOME', home)
  exact('CLAUDE_CONFIG_DIR', claude)
  exact('CODEX_HOME', codex)
  for (const name of NATIVE_TEST_HOME_ROOTS) {
    const value = named(name)
    if (!inside(value, home)) refuse(`${name} is outside the test home`)
    plain(name, value)
  }
  for (const name of NATIVE_TEST_BMN_ROOTS) {
    if (env[name] === undefined) continue
    const value = named(name)
    if (!inside(value, home)) refuse(`${name} is outside the test home`)
    plain(name, value)
  }
  for (const name of NATIVE_TEST_FORBIDDEN_VARIABLES) {
    if (env[name] !== undefined) refuse(`${name} is set; a test run carries none of the caller's credentials or BMN session`)
  }
  for (const folder of [home, claude, codex]) {
    let state
    try { state = fs.lstatSync(folder) } catch { refuse(`${folder} does not exist`) }
    if (!state.isDirectory() || (state.mode & 0o077) !== 0) refuse(`${folder} is not a private folder`)
  }
  return { root, home, claude, codex }
}

/**
 * Whether each test profile holds its own sign-in: an ordinary file, never a link, never opened. The owner signs in once
 * (plan/references/125/sign-in.md); a test neither makes nor borrows one.
 */
export function nativeTestSignIns({ root = nativeTestRoot(), fs = nodeFs } = {}) {
  return Object.fromEntries(Object.entries(SIGN_INS).map(([app, name]) => {
    try {
      const state = fs.lstatSync(join(root, app, name))
      return [app, state.isFile() && !state.isSymbolicLink() && state.nlink === 1]
    } catch { return [app, false] }
  }))
}

/** Refuses an app whose test profile holds no sign-in of its own, in words that say whose step it is. */
export function assertNativeTestSignIn(app, options) {
  if (nativeTestSignIns(options)[app] !== true) throw new NativeTestEnvironmentError(`the ${app} test profile holds no sign-in file of its own; the owner signs in once (plan/references/125/sign-in.md)`)
}

/** The whole environment of a native driver: the test folders, a short list of harmless names from the caller, nothing else. */
export function nativeTestEnvironment({ root = nativeTestRoot(), caller = process.env } = {}) {
  const home = join(root, 'home')
  const env = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    if (typeof caller[name] === 'string') env[name] = caller[name]
  }
  return {
    ...env, SHELL: '/bin/bash', TERM: 'xterm-256color', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: join(home, '.run'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), DISABLE_AUTOUPDATER: '1'
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--')
  const command = at < 0 ? [] : process.argv.slice(at + 1)
  if (command.length === 0) {
    process.stderr.write('Usage: node scripts/test/native-test-home.mjs -- <command> [arguments]\n')
    process.exit(2)
  }
  const env = nativeTestEnvironment()
  try {
    // Checked before anything is made (a link would be followed), and again once the roots exist.
    assertNativeTestEnvironment(env)
    for (const name of NATIVE_TEST_HOME_ROOTS) nodeFs.mkdirSync(env[name], { recursive: true, mode: 0o700 })
    assertNativeTestEnvironment(env)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(10)
  }
  const result = spawnSync(command[0], command.slice(1), { env, stdio: 'inherit' })
  if (result.error) { process.stderr.write(`${result.error.message}\n`); process.exit(1) }
  process.exit(result.status ?? 1)
}
