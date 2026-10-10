// MODULE: route-baselines.ts - Epic 60.3 AC3: an untested app version is offered for acceptance only when it sends data where a tested or accepted version did
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ROSTER_APP_NAMES, type RosterHarness } from '@bmn/protocol'
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
  const where = route.host === null ? 'an unknown destination' : route.host.startsWith('default:') ? `the default servers of ${route.host.slice('default:'.length)}` : route.host
  return `${where} (${route.sources.length ? `set by ${route.sources.join(', ')}` : 'nothing overrides it'})`
}

/**
 * A tested or already accepted version records what it resolves; an untested one is acceptable only
 * when its resolution equals that record. Without a record nothing is offered: BMN has nothing to
 * compare the new version's choice of destination with.
 */
export function judgeInspection(resolution: RouteResolution, accepted: readonly string[], testedOrAccepted: boolean, now: Date): AcceptanceVerdict {
  const baselines = readBaselines()
  const baseline = baselines[resolution.harness]
  const app = ROSTER_APP_NAMES[resolution.harness]
  if (resolution.version === null) return { acceptable: false, comparison: `${app} is not installed, or its version cannot be read.` }
  if (testedOrAccepted) {
    writeBaselines({ ...baselines, [resolution.harness]: { ...resolution, version: resolution.version, at: now.toISOString() } })
    return { acceptable: false, comparison: `${resolution.version} is ${accepted.includes(resolution.version) ? 'accepted by you' : 'tested by BMN'}. Later versions must send data to the same place.` }
  }
  if (baseline === undefined) {
    return { acceptable: false, comparison: `BMN never saw where a tested or accepted ${app} version sends data, so it has nothing to compare ${resolution.version} with.` }
  }
  if (!same(resolution, baseline)) {
    return { acceptable: false, comparison: `${resolution.version} sends data to ${describe(resolution)}, not to ${describe(baseline)} as ${baseline.version} did.` }
  }
  return { acceptable: true, comparison: `Sends data to the same place as ${baseline.version}: ${describe(resolution)}.` }
}

/**
 * At approval time (60.3 AC3): a newly accepted version must be the one installed now, and must
 * still resolve the route and sources a tested or accepted version recorded. Throws to refuse.
 */
export function assertStillAcceptable(version: string, resolution: RouteResolution): void {
  const baseline = readBaselines()[resolution.harness]
  if (resolution.version !== version) {
    throw new RosterError('ROUTE_CHANGED', `${resolution.harness} ${version} is not the installed version (${resolution.version ?? 'unreadable'}); open Rules > Health and accept the installed one`)
  }
  if (baseline === undefined || !same(resolution, baseline)) {
    throw new RosterError('ROUTE_CHANGED', `${resolution.harness} ${version} does not send data where a tested or accepted version did; it cannot be accepted`)
  }
}
