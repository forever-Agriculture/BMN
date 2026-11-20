// MODULE: doctor-profile.mjs - One selected profile description and private result fingerprint
import { createHmac } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { observeRoute } from './doctor-locations.mjs'

export function selectedProfile(environment = process.env) {
  const home = environment.HOME ?? homedir()
  const config = environment.XDG_CONFIG_HOME ?? join(home, '.config')
  const paths = {
    HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: environment.XDG_DATA_HOME ?? join(home, '.local/share'),
    XDG_CACHE_HOME: environment.XDG_CACHE_HOME ?? join(home, '.cache'), XDG_STATE_HOME: environment.XDG_STATE_HOME ?? join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), CODEX_HOME: environment.CODEX_HOME ?? join(home, '.codex')
  }
  const invalid = Object.values(paths).some((path) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || ['/', '/tmp', '/var/tmp'].includes(path))
  const unavailable = !invalid && Object.entries(paths).some(([name, path]) => {
    if (environment[name] === undefined) return false
    try {
      if (!statSync(path).isDirectory()) return true
      accessSync(path, constants.R_OK | constants.X_OK)
      return false
    } catch { return true }
  })
  return { paths, invalid, unavailable, home, claude: paths.CLAUDE_CONFIG_DIR, codex: paths.CODEX_HOME,
    claudeJson: join(environment.CLAUDE_CONFIG_DIR ?? home, '.claude.json'), bmn: join(home, '.config/bmn/agents') }
}

/** The key and selector material stay in the local worker/state boundary, never in its view. */
export function profileFingerprint(profile, key) {
  const sources = Object.entries(profile.paths).map(([name, path]) => {
    try {
      const route = observeRoute(path)
      // Access changes cannot create a new profile identity and refund the startup retry.
      // Each inspection still witnesses permissions separately for the predicates that use them.
      return [name, path, route.nodes.map((node) => [node.name.toString('base64'),
        Object.fromEntries((node.object.type === 'link' ? ['device', 'inode', 'type', 'changed', 'modified', 'size', 'links'] :
          ['device', 'inode', 'type']).map((key) => [key, node.object[key]])), node.link?.toString('base64') ?? null]),
      route.missing ?? null]
    }
    catch (error) { return [name, path, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable'] }
  })
  return createHmac('sha256', key).update(JSON.stringify([profile.invalid, profile.claudeJson, sources])).digest('hex')
}
