// MODULE: doctor-leftover-results.mjs - Fixed, show-only facts from the measured leftover inventory
import { locationText, unresolvedLocation, validateLocation } from './doctor-locations.mjs'
export const LEFTOVER_REASONS = Object.freeze({
  'missing-project': 'The memory belongs to a project that could not be found.',
  'ambiguous-project': 'The memory project could not be resolved safely.',
  'unused-memory': 'The app keeps memory rows for a missing or unknown project.',
  'broken-link': 'The skill link has no target.',
  duplicate: 'The same skill is also discovered elsewhere.',
  conflict: 'Skills share a name but have different contents; precedence is unverified.',
  unreadable: 'The item could not be read safely.',
  unverified: 'Discovery or program resolution is unverified for this version.',
  'app-managed': 'The app manages this cache or registry itself.',
  disabled: 'The plugin is disabled; it may be deliberately retained.',
  'plugin-missing': 'The plugin is listed but its installation could not be found.',
  'missing-program': 'The MCP program or script is missing.',
  'secret-inline': 'The MCP entry holds a credential; its contents are withheld.',
  'plugin-owned': 'The MCP entry belongs to an app plugin.'
})
const KINDS = ['memory', 'skills', 'plugins', 'mcp']
const APPS = ['claude', 'codex', 'opencode']

export function leftoverLocation(item) {
  return locationText(item.locator)
}

export function validateLeftovers(value) {
  if (!Array.isArray(value) || value.length > 10000) return null
  const out = []
  for (const row of value) {
    if (!row || !KINDS.includes(row.kind) || (row.app !== null && !APPS.includes(row.app)) ||
      (row.kind !== 'skills' && row.app === null) || (row.kind === 'memory' && row.app === 'opencode') ||
      (row.source !== undefined && (row.source !== 'managed' || row.app !== 'opencode' || !['plugins', 'mcp'].includes(row.kind))) ||
      !Object.hasOwn(LEFTOVER_REASONS, row.reason) || !Number.isSafeInteger(row.item) || row.item < 1 || row.item > 10000) return null
    const locator = row.locator === undefined ? unresolvedLocation() : validateLocation(row.locator)
    if (locator === null) return null
    out.push({ kind: row.kind, app: row.app, reason: row.reason, item: row.item, identity: 'withheld', ...(row.source === 'managed' ? { source: 'managed' } : {}), locator })
  }
  return out
}

/** All paths, names, hashes, parser errors and arbitrary text end inside the worker. */
export function projectLeftovers(report) {
  const leftovers = []
  let partial = !report || !Array.isArray(report.errors) || report.errors.length > 0
  // A location that cannot be found again is not a gap (owner card 2026-10-22); an item BMN could not read is.
  const add = (kind, app, reason, row = {}) => {
    const locator = validateLocation(row.locator) ?? unresolvedLocation()
    if (reason === 'unreadable') partial = true
    leftovers.push({ kind, app, reason, item: leftovers.length + 1, identity: 'withheld', ...(row.source === 'managed' && app === 'opencode' && ['plugins', 'mcp'].includes(kind) ? { source: 'managed' } : {}), locator })
  }
  const section = (key) => {
    const value = report?.[key]
    if (!value || value.error) { partial = true; return {} }
    return value
  }
  for (const row of section('memory_claude').rows ?? []) {
    if (row.worktree) continue
    if (row.project === 'missing') add('memory', 'claude', 'missing-project', row)
    else if (row.project !== 'exists') add('memory', 'claude', 'ambiguous-project', row)
  }
  const codex = section('memory_codex')
  for (const row of codex.items ?? []) add('memory', 'codex', 'unused-memory', row)
  for (const row of section('skills').items ?? []) {
    if (row.protected || row.verdict === 'protected' || row.verdict?.startsWith('keep:')) continue
    const verdict = row.verdict ?? ''
    const reason = row.state === 'broken-link' ? 'broken-link' : verdict.includes('unreadable') ? 'unreadable'
      : verdict.includes('different content') ? 'conflict' : verdict.includes('unverified') ? 'unverified'
        : verdict.includes('same body') ? 'duplicate' : null
    if (reason) add('skills', null, reason, row)
  }
  for (const app of APPS) {
    const plugins = section(`plugins_${app}`)
    for (const row of plugins.rows ?? []) {
      if (row.class === 'disabled') add('plugins', app, 'disabled', row)
      else if (row.class === 'app-managed') add('plugins', app, 'app-managed', row)
      else if (row.class === 'unreadable') add('plugins', app, 'unreadable', row)
      else if (row.class?.startsWith('failing:') || row.class === 'install folder missing' || row.class === 'listed, not installed') add('plugins', app, 'plugin-missing', row)
    }
  }
  for (const row of section('mcp').rows ?? []) {
    if (!APPS.includes(row.app) || row.state === 'file-missing' || row.verdict === 'keep' || row.verdict?.startsWith('protected:')) continue
    const verdict = row.verdict ?? ''
    const reason = verdict.includes('secret inline') ? 'secret-inline' : verdict.includes('unreadable') ? 'unreadable'
      : verdict.includes('belongs to a plugin') ? 'plugin-owned' : verdict.includes('program resolved at start') ? 'unverified'
        : verdict.includes('project gone') ? 'missing-project' : verdict.includes('missing') ? 'missing-program' : null
    if (reason) add('mcp', row.app, reason, row)
  }
  return { state: partial ? 'partial' : 'passed', problems: partial ? [{ code: 'additional-details', item: 1 }] : [], leftovers }
}
