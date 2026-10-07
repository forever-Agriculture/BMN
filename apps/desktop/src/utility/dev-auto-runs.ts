import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AttentionRecord, DevAutoRun, DevAutoRunsResult, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { readFileReference } from './file-reference-reader'
import { inspectRepositoryIdentity } from './repository-identity'
import { repositoryGit, repositoryGitError } from './repository-git'

const clip = (value: string): string => value.slice(0, 1_000)
let activeTextReads = 0
const pendingTextReads: Array<() => void> = []
async function textReadSlot(): Promise<() => void> {
  if (activeTextReads >= 4) await new Promise<void>((done) => pendingTextReads.push(done))
  else activeTextReads++
  return () => {
    const next = pendingTextReads.shift()
    if (next) next()
    else activeTextReads--
  }
}
export function insideDirectory(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

export async function worktreeText(root: string, path: string, maxBytes: number): Promise<
  { text: string; unavailable: null } | { text: null; unavailable: string }
> {
  const release = await textReadSlot()
  try {
    const physicalRoot = await realpath(root).catch(() => null)
    if (!physicalRoot) return { text: null, unavailable: 'Checkout unavailable' }
    const physicalPath = await realpath(path)
    if (!insideDirectory(physicalRoot, physicalPath)) return { text: null, unavailable: 'File resolves outside the checkout' }
    const result = await readFileReference({ reference: path, baseDirectory: null, launchDirectory: root }, { maxBytes })
    if (result.status !== 'ready') return { text: null, unavailable: result.message }
    if (!insideDirectory(physicalRoot, result.canonicalPath)) return { text: null, unavailable: 'File resolves outside the checkout' }
    return { text: result.content, unavailable: null }
  } catch (error) {
    return { text: null, unavailable: (error as { code?: string }).code === 'ENOENT' ? 'File absent' : 'File unavailable' }
  } finally { release() }
}

export interface WorktreeLocation { checkout: string; branch: string | null }
export function parseWorktrees(text: string): WorktreeLocation[] {
  const records: WorktreeLocation[] = []
  let current: WorktreeLocation | null = null
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { checkout: field.slice(9), branch: null }
    } else if (current && field.startsWith('branch refs/heads/')) current.branch = field.slice(18)
  }
  if (current) records.push(current)
  return records
}

/** Same continuation and terminal grammar as dev-auto/hooks/dev-auto-session-start.py. */
export function handoffFinished(text: string): boolean {
  const fields = [...text.matchAll(/^- (Status|Explicit user stop[^:\n]*):([^\n]*(?:\n(?!- |#)[^\n]*)*)/gm)]
  const statuses = fields.filter((field) => field[1] === 'Status')
  const stops = fields.filter((field) => field[1] !== 'Status')
  const note = '(?:[ \\t]*[—–\\-;:(.,!][^\\n]*)?'
  return statuses.length === 1 && stops.length === 1 &&
    new RegExp(`^COMPLETE${note}$`, 'i').test(statuses[0]![2]!.trim()) &&
    new RegExp(`^none${note}$`, 'i').test(stops[0]![2]!.trim()) &&
    new RegExp(`^-[ \\t]*Status:[ \\t]*COMPLETE${note}$`, 'i').test(text.trimEnd().split('\n').at(-1)!.trim())
}

export function parseHandoff(text: string, format?: (value: string) => string): Pick<DevAutoRun, 'project' | 'status' | 'nextAction' | 'decisions' | 'omittedDecisions' | 'finished' | 'ownerCheckout' | 'ownerBranch' | 'truncatedFields'> {
  let truncatedFields = 0
  const bound = (value: string): string => {
    const formatted = format ? format(value) : value
    if (formatted.length > 1_000) truncatedFields++
    return clip(formatted)
  }
  const field = (name: string, raw = false): string | null => {
    const rows = text.split(/\r?\n/u).filter((line) => line.startsWith(`- ${name}:`))
    if (rows.length !== 1) return null
    const value = rows[0]!.slice(name.length + 3).trim()
    return (raw ? value : bound(value)) || null
  }
  const lines = text.split(/\r?\n/u)
  const heading = lines.indexOf('## Decisions and findings')
  const decisions: string[] = []
  if (heading >= 0) {
    const section = lines.slice(heading + 1).join('\n').split(/^## /m)[0]!
    const match = /^- Decided for you(?: \([^\n]*\))?:([^\n]*(?:\n(?!- |#)[^\n]*)*)/m.exec(section)
    if (match) {
      for (const row of match[1]!.split('\n')) {
        const value = row.trim().replace(/^[-*]\s+/u, '')
        if (value) decisions.push(bound(value))
      }
    }
  }
  const owning = field('Owning checkout and branch', true)
  const split = owning?.lastIndexOf(' / ') ?? -1
  return {
    project: field('Project / selected epics'), status: field('Status'), nextAction: field('Next safe action'),
    decisions: decisions.slice(0, 20), omittedDecisions: Math.max(0, decisions.length - 20), finished: handoffFinished(text),
    ownerCheckout: split >= 0 ? owning!.slice(0, split) : null,
    ownerBranch: split >= 0 ? owning!.slice(split + 3) : null,
    ...(format ? { truncatedFields } : {})
  }
}

export function selectedEpics(project: string | null): number[] {
  const match = /\bepics?\s*[: ]\s*(\d[\d\s,–—-]*)/iu.exec(project ?? '')
  if (!match) return []
  const result = new Set<number>()
  for (const item of match[1]!.split(/[,\s]+/u)) {
    const range = /^(\d+)(?:[-–—](\d+))?$/u.exec(item)
    if (!range) continue
    const start = Number(range[1]), end = Number(range[2] ?? range[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) continue
    for (let offset = 0; offset <= Math.min(end - start, 100) && result.size < 100; offset++) result.add(start + offset)
  }
  return [...result].slice(0, 100)
}

export function parseBoard(text: string, epics: number[]): DevAutoRun['board']['rows'] {
  const rows: DevAutoRun['board']['rows'] = []
  let inSection = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^development_status:\s*(?:#.*)?$/u.test(line)) { inSection = true; continue }
    if (inSection && /^\S/u.test(line) && !line.startsWith('#')) break
    if (!inSection) continue
    const match = /^\s{2}([\w.-]+):\s*([\w-]+)\s*(?:#\s*(.*))?$/u.exec(line)
    if (!match) continue
    const number = Number(/^(?:epic-)?(\d+)(?:-|\.|$)/u.exec(match[1]!)?.[1])
    if (epics.includes(number)) rows.push({ key: clip(match[1]!), status: clip(match[2]!), comment: clip(match[3] ?? '') })
  }
  return rows
}

async function boardFor(root: string, defaultRoot: string, epics: number[]): Promise<DevAutoRun['board']> {
  let config = await worktreeText(root, join(root, '_bmad/bmm/config.yaml'), 64 * 1024)
  if (config.unavailable === 'File absent' && root !== defaultRoot) config = await worktreeText(defaultRoot, join(defaultRoot, '_bmad/bmm/config.yaml'), 64 * 1024)
  if (config.text === null && config.unavailable !== 'File absent') return { checkout: null, rows: [], unavailable: `Board unavailable: ${config.unavailable}` }
  let path = /^implementation_artifacts:\s*(.+?)\s*$/m.exec(config.text ?? '')?.[1] ?? '_bmad-output/implementation-artifacts'
  path = path.replace(/^(['"])(.*)\1$/u, '$2').replaceAll('{project-root}', root)
  const boardPath = resolve(root, path, 'sprint-status.yaml')
  if (!insideDirectory(root, boardPath)) return { checkout: null, rows: [], unavailable: 'Board unavailable: configured path is outside the checkout' }
  const localPath = relative(root, boardPath)
  let tracked: boolean
  try { tracked = (await repositoryGit(root, ['ls-files', '-z', '--', localPath])).split('\0').includes(localPath.replaceAll(sep, '/')) } catch {
    return { checkout: null, rows: [], unavailable: 'Board unavailable: tracking could not be read' }
  }
  const checkout = tracked ? root : defaultRoot
  const board = await worktreeText(checkout, join(checkout, localPath), 256 * 1024)
  return { checkout, rows: board.text === null ? [] : parseBoard(board.text, epics), unavailable: board.text === null ? `Board unavailable: ${board.unavailable}` : null }
}

async function limitedMap<T, R>(items: T[], job: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await job(items[index]!) }
  }))
  return results
}

export async function readDevAutoRuns(workspaces: readonly WorkspaceRecord[], sessions: readonly SessionRecord[],
  attention: readonly AttentionRecord[], workspaceId?: string, format?: (value: string) => string,
  liveLaunchDirectories: ReadonlyMap<string, string> = new Map()): Promise<DevAutoRunsResult> {
  const result: DevAutoRunsResult = { runs: [], skipped: 0, issues: [], observedAt: new Date().toISOString() }
  const addIssue = (message: string): void => { result.skipped++; if (result.issues.length < 100) result.issues.push(clip(message)) }
  const directories = new Map<string, Set<string>>()
  for (const workspace of workspaces.filter((item) => item.archivedAt === null && (!workspaceId || item.workspaceId === workspaceId))) {
    const workspaceSessions = sessions.filter(session => session.workspaceId === workspace.workspaceId && session.archivedAt === null)
    for (const cwd of [workspace.defaultCwd, ...workspaceSessions.map(session => session.cwd),
      ...workspaceSessions.flatMap(session => {
        const liveDirectory = liveLaunchDirectories.get(session.sessionId)
        return liveDirectory ? [liveDirectory] : []
      })]) {
      if (!cwd) continue
      if (!directories.has(cwd)) directories.set(cwd, new Set())
      directories.get(cwd)!.add(workspace.workspaceId)
    }
  }
  const roots = new Map<string, { root: string; ids: Set<string> }>()
  const sessionRoots = new Map<string, string>()
  // Also bound discovery itself; each skipped directory is explicitly counted.
  const all = [...directories]
  for (const [cwd] of all.slice(256)) addIssue(`Directory discovery bound: ${cwd}`)
  const identities = await limitedMap(all.slice(0, 256), async ([cwd, ids]) => ({ identity: await inspectRepositoryIdentity(cwd), cwd, ids }))
  for (const { identity, cwd, ids } of identities) {
    if (identity.state !== 'repository') { addIssue(`${identity.directory}: ${identity.state === 'unavailable' ? identity.reason : 'Not a repository'}`); continue }
    sessionRoots.set(cwd, identity.root)
    // Common Git directory deduplicates repositories reached through different worktrees.
    let key: string
    try { key = (await repositoryGit(identity.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() } catch (error) { addIssue(repositoryGitError(error)); continue }
    if (!roots.has(key)) {
      if (roots.size >= 32) { addIssue(`Repository bound: ${identity.root}`); continue }
      roots.set(key, { root: identity.root, ids: new Set() })
    }
    for (const id of ids) roots.get(key)!.ids.add(id)
  }
  const liveSessions = sessions.filter(session => session.archivedAt === null && session.lastProcess?.state === 'live')
  for (const session of liveSessions) if (!liveLaunchDirectories.has(session.sessionId)) addIssue('Live-session launch directory unavailable')
  const liveDirectories = [...new Set(liveSessions.flatMap(session => {
    const cwd = liveLaunchDirectories.get(session.sessionId)
    return cwd ? [cwd] : []
  }))].filter(cwd => !sessionRoots.has(cwd))
  for (const cwd of liveDirectories.slice(256)) addIssue(`Live-session directory bound: ${cwd}`)
  await limitedMap(liveDirectories.slice(0, 256), async (cwd) => {
    const identity = await inspectRepositoryIdentity(cwd)
    if (identity.state === 'repository') sessionRoots.set(cwd, identity.root)
    else if (identity.state === 'unavailable') addIssue(`${cwd}: owner-item checkout unavailable`)
  })
  const tasks: Array<{ location: WorktreeLocation; defaultRoot: string; ids: string[] }> = []
  for (const values of roots.values()) {
    const { root } = values
    const ids = [...values.ids]
    try {
      const locations = parseWorktrees(await repositoryGit(root!, ['worktree', 'list', '--porcelain', '-z']))
      for (const location of locations.slice(64)) addIssue(`Worktree bound: ${location.checkout}`)
      for (const location of locations.slice(0, 64)) tasks.push({ location, defaultRoot: locations[0]?.checkout ?? root!, ids })
    } catch (error) { addIssue(`${root}: ${repositoryGitError(error)}`) }
  }
  const rows = await limitedMap(tasks, async ({ location, defaultRoot, ids }): Promise<DevAutoRun | null> => {
    const file = await worktreeText(location.checkout, join(location.checkout, '.dev-auto/handoff.md'), 64 * 1024)
    if (file.unavailable === 'File absent') {
      if (format) addIssue(`${location.checkout}: handoff absent`)
      return null
    }
    const fields = parseHandoff(file.text ?? '', format)
    let ownership: DevAutoRun['ownership'] = 'unknown'
    if (fields.ownerCheckout && fields.ownerBranch && isAbsolute(fields.ownerCheckout)) {
      const [owner, checkout] = await Promise.all([realpath(fields.ownerCheckout).catch(() => null), realpath(location.checkout).catch(() => null)])
      if (fields.ownerBranch !== location.branch || (owner && checkout && owner !== checkout)) ownership = 'copy'
      else if (owner && checkout) ownership = 'own'
    }
    const ownerItems: DevAutoRun['ownerItems'] = []
    if (ownership !== 'copy') {
      for (const session of sessions.filter((item) => item.archivedAt === null && item.lastProcess?.state === 'live')) {
        const launchDirectory = liveLaunchDirectories.get(session.sessionId)
        if (!launchDirectory || sessionRoots.get(launchDirectory) !== location.checkout) continue
        for (const item of attention.filter((request) => request.sessionId === session.sessionId && request.incarnationId === session.lastProcess!.incarnationId && request.state === 'open')) {
          if (ownerItems.length < 100) {
            const title = format ? format(item.title) : item.title
            if (format && title.length > 1_000) fields.truncatedFields = (fields.truncatedFields ?? 0) + 1
            ownerItems.push({ sessionId: session.sessionId, requestId: item.requestId, title: clip(title) })
          }
          else addIssue('Owner items exceeded the display bound')
        }
      }
    }
    if (file.unavailable) addIssue(`${location.checkout}: ${file.unavailable}`)
    if (fields.omittedDecisions) {
      result.skipped += fields.omittedDecisions
      if (result.issues.length < 100) result.issues.push(clip(`${location.checkout}: ${fields.omittedDecisions} decisions beyond the 20-entry bound`))
    }
    const board = await boardFor(location.checkout, defaultRoot, selectedEpics(format ? parseHandoff(file.text ?? '').project : fields.project))
    if (board.unavailable) addIssue(`${location.checkout}: ${board.unavailable}`)
    return {
      ...fields, workspaceIds: ids, ...location, ownership, unavailable: file.unavailable,
      ...(ownership === 'copy' ? { status: null, nextAction: null, finished: false, ownerItems: [] } : { ownerItems }),
      board
    }
  })
  let size = 0
  for (const row of rows) {
    if (!row) continue
    const bytes = Buffer.byteLength(JSON.stringify(row))
    if (size + bytes > 750 * 1024) { addIssue(`Snapshot output bound: ${row.checkout}`); continue }
    size += bytes
    result.runs.push(row)
  }
  return result
}
