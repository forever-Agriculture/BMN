// MODULE: route-baselines.ts - Epic 60.3 AC3: an untested harness version is offered for acceptance only when it resolves the route a tested or accepted version did
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { RosterHarness } from '@bmn/protocol'
import { RosterError } from '../../bin/agents-roster.mjs'
import { stateDirectory } from '../../bin/agents-state.mjs'

/** What an inspection resolved: the parts that must match before an untested version is offered. */
export interface RouteResolution {
  harness: RosterHarness
  version: string | null
  provider: string | null
  host: string | null
  basis: string
  sources: string[]
}

export interface RouteBaseline extends Omit<RouteResolution, 'version'> { version: string; at: string }

export type AcceptanceVerdict =
  | { acceptable: true; comparison: string }
  | { acceptable: false; comparison: string }

export function baselinesPath(): string {
  return `${stateDirectory()}/route-baselines.json`
}

function readBaselines(): Partial<Record<RosterHarness, RouteBaseline>> {
  try {
    const value = JSON.parse(readFileSync(baselinesPath(), 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<Record<RosterHarness, RouteBaseline>> : {}
  } catch {
    return {}
  }
}

function writeBaselines(baselines: Partial<Record<RosterHarness, RouteBaseline>>): void {
  mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 })
  chmodSync(stateDirectory(), 0o700)
  const temporary = `${baselinesPath()}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(baselines, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, baselinesPath())
}

const same = (a: Omit<RouteResolution, 'harness' | 'version'>, b: Omit<RouteResolution, 'harness' | 'version'>): boolean =>
  a.provider === b.provider && a.host === b.host && a.basis === b.basis && JSON.stringify([...a.sources].sort()) === JSON.stringify([...b.sources].sort())

function describe(route: Omit<RouteResolution, 'harness' | 'version'>): string {
  return `${route.host ?? 'unknown host'} (${route.basis}${route.sources.length ? `, from ${route.sources.join(', ')}` : ', no overrides'})`
}

/**
 * A tested or already accepted version records what it resolves; an untested one is acceptable only
 * when its resolution equals that record. Without a record nothing is offered: BMN has nothing to
 * compare the new version's choice of destination with.
 */
export function judgeInspection(resolution: RouteResolution, accepted: readonly string[], testedOrAccepted: boolean, now: Date): AcceptanceVerdict {
  const baselines = readBaselines()
  const baseline = baselines[resolution.harness]
  if (resolution.version === null) return { acceptable: false, comparison: `The ${resolution.harness} version cannot be read.` }
  if (testedOrAccepted) {
    writeBaselines({ ...baselines, [resolution.harness]: { ...resolution, version: resolution.version, at: now.toISOString() } })
    return { acceptable: false, comparison: `${resolution.version} is ${accepted.includes(resolution.version) ? 'owner-accepted' : 'tested by BMN'}; recorded its route as the one later versions must match.` }
  }
  if (baseline === undefined) {
    return { acceptable: false, comparison: `No route was recorded on a tested or accepted ${resolution.harness} version; inspect once on one before accepting ${resolution.version}.` }
  }
  if (!same(resolution, baseline)) {
    return { acceptable: false, comparison: `Resolves ${describe(resolution)}, not ${describe(baseline)} as ${baseline.version} did; not offered.` }
  }
  return { acceptable: true, comparison: `Same route and sources as ${baseline.version}: ${describe(resolution)}.` }
}

/**
 * At approval time (60.3 AC3): a newly accepted version must be the one installed now, and must
 * still resolve the route and sources a tested or accepted version recorded. Throws to refuse.
 */
export function assertStillAcceptable(version: string, resolution: RouteResolution): void {
  const baseline = readBaselines()[resolution.harness]
  if (resolution.version !== version) {
    throw new RosterError('ROUTE_CHANGED', `${resolution.harness} ${version} is not the installed version (${resolution.version ?? 'unreadable'}); inspect it in Preferences > Agents first`)
  }
  if (baseline === undefined || !same(resolution, baseline)) {
    throw new RosterError('ROUTE_CHANGED', `${resolution.harness} ${version} does not resolve the route a tested or accepted version recorded; it cannot be accepted`)
  }
}
