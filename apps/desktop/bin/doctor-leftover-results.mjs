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
  return locationText(item.currentLocator ?? item.locator)
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
