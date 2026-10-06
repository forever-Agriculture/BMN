// MODULE: disposable-provider-env.mjs - fail-closed environment for real provider acceptance trials
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'

function privateDirectory(path) {
  const link = lstatSync(path)
  const stat = statSync(path)
  if (link.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Cross-harness profile directory must be owner-owned, private and not a symlink: ${path}`)
  }
}

/**
 * Credentials must be provisioned separately into a disposable system-temp profile root. The trial
 * never copies them from the owner's home, and never inherits provider credentials or profiles.
 */
export function disposableProviderEnvironment(runtimeRoot, profileRootInput, inherited = process.env) {
  if (!profileRootInput) {
    throw new Error('UNVERIFIED: set BMN_CROSS_HARNESS_PROFILE_ROOT to an explicitly provisioned disposable profile root')
  }
  if (!existsSync(profileRootInput)) {
    throw new Error('UNVERIFIED: the disposable cross-harness profile root does not exist')
  }
  if (lstatSync(profileRootInput).isSymbolicLink()) {
    throw new Error('UNVERIFIED: cross-harness profile root cannot be a symlink')
  }
  const temp = realpathSync(tmpdir())
  const profiles = realpathSync(profileRootInput)
  if (dirname(profiles) !== temp || !basename(profiles).startsWith('bmn-cross-harness-profiles-')) {
    throw new Error('UNVERIFIED: cross-harness profiles must be a direct disposable system-temp directory')
  }
  for (const path of [profiles, join(profiles, 'claude'), join(profiles, 'codex')]) {
    if (!existsSync(path)) throw new Error(`UNVERIFIED: missing disposable cross-harness profile directory: ${path}`)
    privateDirectory(path)
  }
  // Inspect existing profiles; the helper refuses unsafe roots without repairing
  // their permissions or adopting another account's credential directory.
  if (process.platform === 'win32') ensurePrivateDirectories([profiles, join(profiles, 'claude'), join(profiles, 'codex')])
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    ...(process.platform === 'win32' ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] : [])]
  const env = Object.fromEntries(allowed.flatMap(name => {
    const value = process.platform === 'win32' ? windowsEnvironmentValue(inherited, name) : inherited[name]
    return value === undefined ? [] : [[name, value]]
  }))
  return {
    ...env,
    HOME: join(runtimeRoot, 'home'),
    ...(process.platform === 'win32' ? { USERPROFILE: join(runtimeRoot, 'home'), APPDATA: join(runtimeRoot, 'config'), LOCALAPPDATA: join(runtimeRoot, 'data') } : {}),
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_DATA_HOME: join(runtimeRoot, 'data'),
    XDG_STATE_HOME: join(runtimeRoot, 'state'),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    XDG_RUNTIME_DIR: join(runtimeRoot, 'runtime'),
    CLAUDE_CONFIG_DIR: join(profiles, 'claude'),
    CODEX_HOME: join(profiles, 'codex'),
    TERM: 'xterm-256color',
    NO_COLOR: '1'
  }
}
