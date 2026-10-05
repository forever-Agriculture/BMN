// MODULE: wsl-discovery.mjs - WSL registrations, a session's recorded distribution, and distribution-qualified paths
// Preparatory (Story 53.5 AC1 and AC3): pure parsing and policy, tested on Linux. The native commands that feed it
// (LXSS_REGISTRATIONS_COMMAND, `wsl.exe --version`) are measured separately on Windows.
import { ProtocolError, validateLinuxPath } from './wsl-session-protocol.mjs'

/**
 * Lists this user's WSL registrations as JSON, read-only: each registry key under Lxss with its name, version,
 * state and base path, plus the default registration. Run by Windows PowerShell with -NoProfile; output is UTF-8.
 */
export const LXSS_REGISTRATIONS_COMMAND = [
  // Any error ends the listing with a failure, so a partial enumeration never reads as complete.
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'",
  "if (-not (Test-Path -LiteralPath $root)) { '{\"present\":false}'; exit 0 }",
  "$default = (Get-ItemProperty -LiteralPath $root -Name DefaultDistribution -ErrorAction SilentlyContinue).DefaultDistribution",
  '$items = @(Get-ChildItem -LiteralPath $root | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; ' +
    '[ordered]@{ id = $_.PSChildName; name = $p.DistributionName; version = $p.Version; state = $p.State; basePath = $p.BasePath } })',
  '[ordered]@{ present = $true; default = $default; registrations = $items } | ConvertTo-Json -Depth 4 -Compress'
].join('; ')

const GUID = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/u
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** `wsl.exe --version` (English labels); a label it cannot find is null, never a failure. */
export function parseWslVersion(text) {
  const field = (label) => new RegExp(`^${label} version:\\s*(\\S+)\\s*$`, 'mu').exec(String(text))?.[1] ?? null
  return { wsl: field('WSL'), kernel: field('Kernel'), windows: field('Windows') }
}

/**
 * The JSON LXSS_REGISTRATIONS_COMMAND prints. Registration identities are lowercased registry GUIDs. Entries that
 * cannot be a usable registration are listed under `ignored` with the reason, never silently dropped; names that
 * differ only in case are marked ambiguous, since WSL compares names without case.
 */
export function parseRegistrations(text) {
  let raw
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/u, ''))
  } catch {
    throw new ProtocolError('INTERNAL', 'the registration list is not JSON')
  }
  if (raw === null || typeof raw !== 'object' || typeof raw.present !== 'boolean') throw new ProtocolError('INTERNAL', 'the registration list has no presence flag')
  if (!raw.present) return { present: false, defaultId: null, registrations: [], ignored: [] }
  const entries = raw.registrations === null || raw.registrations === undefined ? [] : [raw.registrations].flat()
  const registrations = [], ignored = []
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' && GUID.test(entry.id) ? entry.id.toLowerCase() : null
    const reason = id === null ? 'identity is not a registry GUID'
      : typeof entry.name !== 'string' || !NAME.test(entry.name) ? 'name is not a WSL distribution name'
        : ![1, 2].includes(entry.version) ? 'version is neither 1 nor 2' : null
    if (reason) ignored.push({ id: typeof entry?.id === 'string' ? entry.id.slice(0, 64) : null, reason })
    else registrations.push({ id, name: entry.name, version: entry.version, state: Number.isInteger(entry.state) ? entry.state : null,
      basePath: typeof entry.basePath === 'string' ? entry.basePath : null })
  }
  for (const registration of registrations) {
    registration.ambiguousName = registrations.some((other) => other !== registration && other.name.toLowerCase() === registration.name.toLowerCase())
  }
  const defaultId = typeof raw.default === 'string' && GUID.test(raw.default) ? raw.default.toLowerCase() : null
  return { present: true, defaultId, registrations, ignored }
}

const failure = (code, message) => ({ ok: false, code, message })

/**
 * The exact registration a session recorded ({ id, name }), for start and resume. Never falls back to the default
 * or to another registration with the same name: a missing WSL, a removed, renamed or replaced registration and a
 * WSL 1 registration each fail with an actionable message, and native Windows sessions are not involved.
 */
export function resolveRecordedDistribution(recorded, discovery) {
  const native = 'Windows sessions are not affected.'
  if (!discovery || discovery.present === false) {
    return failure('WSL_MISSING', `WSL is not available on this computer. Install WSL 2 (wsl.exe --install), then start this session again. ${native}`)
  }
  const byId = discovery.registrations.find((registration) => registration.id === recorded.id)
  if (!byId) {
    const sameName = discovery.registrations.find((registration) => registration.name.toLowerCase() === recorded.name.toLowerCase())
    return failure('DISTRO_CHANGED', sameName
      ? `The distribution "${recorded.name}" was replaced by a new registration with the same name. Choose it again to use it for this session. ${native}`
      : `The distribution "${recorded.name}" is no longer installed. Choose another distribution for this session. ${native}`)
  }
  if (byId.name !== recorded.name) {
    return failure('DISTRO_CHANGED', `The distribution "${recorded.name}" is now named "${byId.name}". Choose it again to confirm it for this session. ${native}`)
  }
  if (byId.ambiguousName) {
    return failure('DISTRO_CHANGED', `More than one distribution is named "${byId.name}" apart from letter case. Rename one, then choose again. ${native}`)
  }
  if (byId.version !== 2) {
    return failure('UNSUPPORTED_PROFILE', `"${byId.name}" runs as WSL 1. Convert it with wsl.exe --set-version ${byId.name} 2, then start this session again. ${native}`)
  }
  return { ok: true, registration: byId }
}

/** A Linux path qualified by its distribution's registration identity; equal paths in two distributions never collide. */
export function qualifiedGuestPath(distributionId, linuxPath) {
  if (typeof distributionId !== 'string' || !/^\{[0-9a-f-]{36}\}$/u.test(distributionId)) throw new ProtocolError('PROTOCOL', 'distribution identity is not a lowercase registration GUID')
  return { distributionId, path: validateLinuxPath(linuxPath, 'path') }
}

/** The path below an authorized root, as segments; a path outside the root, or the root of another distribution, fails. */
export function confineGuestPath(root, target) {
  if (root.distributionId !== target.distributionId) throw new ProtocolError('AUTH', 'path belongs to another distribution')
  const base = root.path === '/' ? '' : root.path
  if (target.path !== root.path && !target.path.startsWith(`${base}/`)) throw new ProtocolError('AUTH', 'path is outside the authorized root')
  return target.path === root.path ? [] : target.path.slice(base.length + 1).split('/')
}

/**
 * A Windows path into a distribution (\\wsl$\<name>\... or \\wsl.localhost\<name>\...) as a qualified guest path.
 * Null for any other Windows path. The name must match exactly one registration, apart from letter case; otherwise the
 * mapping is ambiguous or unknown and fails rather than guessing. Device, query and relative forms fail.
 */
export function guestPathFromWindows(windowsPath, discovery) {
  const match = /^\\\\(wsl\$|wsl\.localhost)\\([^\\/]+)(\\.*)?$/iu.exec(String(windowsPath))
  if (!match) {
    if (/^\\\\[?.]\\/u.test(String(windowsPath))) throw new ProtocolError('PROTOCOL', 'device paths cannot name a distribution path')
    return null
  }
  const name = match[2]
  const matches = (discovery?.registrations ?? []).filter((registration) => registration.name.toLowerCase() === name.toLowerCase())
  if (matches.length === 0) throw new ProtocolError('DISTRO_CHANGED', `no installed distribution is named "${name}"`)
  if (matches.length > 1) throw new ProtocolError('PROTOCOL', `the distribution name "${name}" is ambiguous`)
  // Windows accepts either separator; one trailing separator is dropped, anything else must already be normalized.
  const remainder = (match[3] ?? '\\').replaceAll('\\', '/')
  return qualifiedGuestPath(matches[0].id, remainder.length > 1 && remainder.endsWith('/') ? remainder.slice(0, -1) : remainder)
}
