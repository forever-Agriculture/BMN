// MODULE: doctor-profile.mjs - One selected profile description and private result fingerprint
import { createHmac } from 'node:crypto'
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function selectedProfile(environment = process.env) {
  const home = environment.HOME ?? homedir()
  const config = environment.XDG_CONFIG_HOME ?? join(home, '.config')
  const paths = {
    HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: environment.XDG_DATA_HOME ?? join(home, '.local/share'),
    XDG_CACHE_HOME: environment.XDG_CACHE_HOME ?? join(home, '.cache'), XDG_STATE_HOME: environment.XDG_STATE_HOME ?? join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), CODEX_HOME: environment.CODEX_HOME ?? join(home, '.codex'),
    OPENCODE_CONFIG_DIR: environment.OPENCODE_CONFIG_DIR ?? join(config, 'opencode')
  }
  if (environment.OPENCODE_CONFIG !== undefined) paths.OPENCODE_CONFIG = environment.OPENCODE_CONFIG
  const invalid = Object.values(paths).some((path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || ['/', '/tmp', '/var/tmp'].includes(path))
  const unavailable = !invalid && Object.entries(paths).some(([name, path]) => {
    if (environment[name] === undefined) return false
    try {
      const file = name === 'OPENCODE_CONFIG'
      const stat = statSync(path)
      if (file ? !stat.isFile() : !stat.isDirectory()) return true
      accessSync(path, constants.R_OK | (file ? 0 : constants.X_OK))
      return false
    } catch { return true }
  })
  const inline = Boolean(environment.OPENCODE_CONFIG_CONTENT)
  const opencodeManagedFiles = ['/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc']
  return { paths, invalid, unavailable, inline, home, claude: paths.CLAUDE_CONFIG_DIR, codex: paths.CODEX_HOME,
    opencode: paths.OPENCODE_CONFIG_DIR, claudeJson: join(environment.CLAUDE_CONFIG_DIR ?? home, '.claude.json'),
    bmn: join(home, '.config/bmn/agents'), opencodeManagedFiles, opencodeFiles: [...new Set([
      ...opencodeManagedFiles,
      join(config, 'opencode/opencode.json'), join(config, 'opencode/opencode.jsonc'),
      join(paths.OPENCODE_CONFIG_DIR, 'opencode.json'), join(paths.OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
      ...(paths.OPENCODE_CONFIG ? [paths.OPENCODE_CONFIG] : [])
    ])] }
}

/** The key and selector material stay in the local worker/state boundary, never in its view. */
export function profileFingerprint(profile, key) {
  const sources = Object.entries(profile.paths).map(([name, path]) => {
    try { const stat = lstatSync(path); return [name, path, realpathSync(path), stat.dev, stat.ino] }
    catch (error) { return [name, path, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable'] }
  })
  return createHmac('sha256', key).update(JSON.stringify([profile.invalid, profile.inline, profile.claudeJson, profile.opencodeFiles, sources])).digest('hex')
}
