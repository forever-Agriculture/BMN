import { useEffect, useRef, useState } from 'react'
import type { RepositoryIdentity, SessionRecord, WorkspaceRecord } from '@bmn/protocol'

export interface CheckoutPeer {
  sessionId: string
  sessionName: string
  workspaceName: string
}

export interface CheckoutComparison {
  /** A non-Git selection has no checkout to compare. */
  outsideGit: boolean
  /** An unreadable selected directory or live peer leaves the comparison inconclusive. */
  incomplete: boolean
  peers: CheckoutPeer[]
}

interface PeerInput {
  directory: string
  sessions: readonly SessionRecord[]
  workspaces: readonly WorkspaceRecord[]
  liveSessionIds: ReadonlySet<string>
  incomplete?: boolean
}

const MAX_PEER_DIRECTORIES = 32
const MAX_CONCURRENT_READS = 3
const CHECK_DEADLINE_MS = 10_000

interface QueuedCheckoutRead {
  directory: string
  read: (directory: string) => Promise<RepositoryIdentity>
  needed: () => boolean
  resolve: (identity: RepositoryIdentity) => void
  reject: (reason: unknown) => void
}

let activeCheckoutReads = 0
const checkoutReadQueue: QueuedCheckoutRead[] = []

function skippedCheckoutRead(directory: string): RepositoryIdentity {
  return { state: 'unavailable', directory, observedAt: new Date().toISOString(),
    reason: 'Checkout preview changed or timed out' }
}

/** One cap across previews, including reads from superseded generations still in flight. */
function pumpCheckoutReads(): void {
  for (let index = checkoutReadQueue.length - 1; index >= 0; index -= 1) {
    const task = checkoutReadQueue[index]!
    if (!task.needed()) {
      checkoutReadQueue.splice(index, 1)
      task.resolve(skippedCheckoutRead(task.directory))
    }
  }
  while (activeCheckoutReads < MAX_CONCURRENT_READS && checkoutReadQueue.length > 0) {
    const task = checkoutReadQueue.shift()!
    if (!task.needed()) { task.resolve(skippedCheckoutRead(task.directory)); continue }
    activeCheckoutReads += 1
    try {
      task.read(task.directory).then(
        (identity) => { activeCheckoutReads -= 1; task.resolve(identity); pumpCheckoutReads() },
        (error: unknown) => { activeCheckoutReads -= 1; task.reject(error); pumpCheckoutReads() }
      )
    } catch (error) {
      activeCheckoutReads -= 1
      task.reject(error)
    }
  }
}

function queuedCheckoutRead(
  directory: string, read: (directory: string) => Promise<RepositoryIdentity>, needed: () => boolean
): Promise<RepositoryIdentity> {
  return new Promise((resolve, reject) => {
    checkoutReadQueue.push({ directory, read, needed, resolve, reject })
    pumpCheckoutReads()
  })
}

/** Start reads the host's current session records, including sessions added after preview opened. */
export async function currentPeerInput(directory: string, source: {
  listWorkspaces(): Promise<WorkspaceRecord[]>
  listSessions(workspaceId: string): Promise<SessionRecord[]>
} = window.aiTerminal): Promise<PeerInput> {
  const deadline = Date.now() + CHECK_DEADLINE_MS
  const bounded = async <T,>(read: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Checkout session read timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([read(), new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Checkout session read timed out')), remaining)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  let workspaces: WorkspaceRecord[]
  try { workspaces = await bounded(() => source.listWorkspaces()) } catch {
    return { directory, sessions: [], workspaces: [], liveSessionIds: new Set(), incomplete: true }
  }
  const active = workspaces.filter((workspace) => !workspace.archivedAt)
  const sessions: SessionRecord[] = []
  let incomplete = false
  let next = 0
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, active.length) }, async () => {
    while (next < active.length && Date.now() < deadline) {
      const workspace = active[next++]!
      try { sessions.push(...await bounded(() => source.listSessions(workspace.workspaceId))) }
      catch { incomplete = true }
    }
  }))
  if (next < active.length) incomplete = true
  return { directory, sessions, workspaces: active,
    liveSessionIds: new Set(sessions.filter((session) => session.lastProcess?.state === 'live')
      .map((session) => session.sessionId)), incomplete }
}

function livePeers(input: PeerInput): Array<{ session: SessionRecord; workspaceName: string }> {
  const workspaces = new Map(input.workspaces.filter((workspace) => !workspace.archivedAt)
    .map((workspace) => [workspace.workspaceId, workspace.name]))
  return input.sessions.flatMap((session) => {
    const workspaceName = workspaces.get(session.workspaceId)
    return input.liveSessionIds.has(session.sessionId) && !session.archivedAt && workspaceName && session.cwd
      ? [{ session, workspaceName }] : []
  })
}

/** Only saved launch directories are compared; the current shell directory is not observed. */
export async function inspectCheckoutPeers(
  input: PeerInput,
  read: (directory: string, needed?: () => boolean) => Promise<RepositoryIdentity>,
  deadlineMs = CHECK_DEADLINE_MS,
  shouldContinue: () => boolean = () => true
): Promise<CheckoutComparison> {
  const deadline = Date.now() + deadlineMs
  const inspect = async (directory: string): Promise<RepositoryIdentity> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || !shouldContinue()) return skippedCheckoutRead(directory)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(directory, () => shouldContinue() && Date.now() < deadline),
        new Promise<RepositoryIdentity>((resolve) => {
          timer = setTimeout(() => resolve({ state: 'unavailable', directory,
            observedAt: new Date().toISOString(), reason: 'Checkout check timed out' }), remaining)
        })
      ])
    } catch {
      return { state: 'unavailable', directory, observedAt: new Date().toISOString(), reason: 'Checkout check failed' }
    } finally { if (timer) clearTimeout(timer) }
  }
  const selected = await inspect(input.directory)
  if (!shouldContinue()) return { outsideGit: false, incomplete: true, peers: [] }
  if (selected.state === 'not-repository') return { outsideGit: true, incomplete: false, peers: [] }
  if (selected.state === 'unavailable') return { outsideGit: false, incomplete: true, peers: [] }

  const peers = livePeers(input)
  const paths = [...new Set(peers.map(({ session }) => session.cwd))]
  const inspected = new Map<string, RepositoryIdentity>([[input.directory, selected]])
  const pending = paths.filter((path) => !inspected.has(path))
  let next = 0
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, pending.length) }, async () => {
    while (shouldContinue() && next < pending.length && next < MAX_PEER_DIRECTORIES && Date.now() < deadline) {
      const path = pending[next++]!
      inspected.set(path, await inspect(path))
    }
  }))
  const matches: CheckoutPeer[] = []
  let incomplete = !!input.incomplete || pending.length > MAX_PEER_DIRECTORIES || next < pending.length
  for (const { session, workspaceName } of peers) {
    const identity = inspected.get(session.cwd)
    if (!identity || identity.state === 'unavailable') incomplete = true
    if (identity?.state === 'repository' && identity.root === selected.root) {
      matches.push({ sessionId: session.sessionId, sessionName: session.name, workspaceName })
    }
  }
  return { outsideGit: false, incomplete, peers: matches }
}

interface LookupState { key: string; loading: boolean; report?: CheckoutComparison }

/** A changed preview or live-session set invalidates every older Git result. */
export function createCheckoutLookup(
  read: (directory: string) => Promise<RepositoryIdentity>,
  publish: (state: LookupState) => void
): { start(input: PeerInput, key: string): Promise<CheckoutComparison | undefined>; cancel(): void } {
  let generation = 0
  return {
    async start(input, key) {
      const current = ++generation
      pumpCheckoutReads()
      publish({ key, loading: true })
      const stillCurrent = (): boolean => current === generation
      const report = await inspectCheckoutPeers(input,
        (directory, needed = stillCurrent) => queuedCheckoutRead(directory, read,
          () => stillCurrent() && needed()), CHECK_DEADLINE_MS, stillCurrent)
      if (current !== generation) return undefined
      publish({ key, loading: false, report })
      return report
    },
    cancel() { generation += 1; pumpCheckoutReads() }
  }
}

export function newlyDiscoveredCheckoutRisk(previous: CheckoutComparison, fresh: CheckoutComparison): boolean {
  if (fresh.incomplete && !previous.incomplete) return true
  const known = new Set(previous.peers.map((peer) => peer.sessionId))
  return fresh.peers.some((peer) => !known.has(peer.sessionId))
}

export function useCheckoutPeers(
  directory: string | null,
  sessions: readonly SessionRecord[],
  workspaces: readonly WorkspaceRecord[],
  liveSessionIds: ReadonlySet<string>,
  previewKey: string
): { report: CheckoutComparison | undefined; loading: boolean; refresh: () => Promise<CheckoutComparison | undefined> } {
  const [state, setState] = useState<LookupState>()
  const lookup = useRef<ReturnType<typeof createCheckoutLookup> | null>(null)
  if (!lookup.current) lookup.current = createCheckoutLookup((path) => window.aiTerminal.inspectRepository(path), setState)
  const input = { directory: directory ?? '', sessions, workspaces, liveSessionIds }
  const key = JSON.stringify([directory, previewKey, livePeers(input).map(({ session, workspaceName }) =>
    [session.sessionId, session.cwd, session.name, workspaceName])])
  const currentKey = useRef(key)
  currentKey.current = key
  useEffect(() => {
    if (directory) void lookup.current?.start(input, key)
    else lookup.current?.cancel()
    return () => lookup.current?.cancel()
  }, [key])
  const current = directory && state?.key === key ? state : undefined
  return {
    report: current?.report,
    loading: !!directory && (current?.loading ?? true),
    refresh: async () => {
      if (!directory) return undefined
      const fresh = await currentPeerInput(directory)
      if (key !== currentKey.current) return undefined
      const report = await lookup.current!.start(fresh, key)
      return key === currentKey.current ? report : undefined
    }
  }
}

export function CheckoutPeerWarning({ report, loading, similarNames = [], similarUnavailable = false }: {
  report: CheckoutComparison | undefined
  loading: boolean
  similarNames?: readonly string[]
  similarUnavailable?: boolean
}): React.JSX.Element | null {
  if (loading) return <p role="status">Checking selected launch directories for live checkout peers…</p>
  if (!report || (report.peers.length === 0 && !report.incomplete && similarNames.length === 0 && !similarUnavailable)) return null
  return <p className="inline-warning" role="status">
    {report.peers.length > 0 ? <>Selected launch directories share this checkout with live BMN sessions: {
      report.peers.map((peer) => `${peer.workspaceName} / ${peer.sessionName}`).join(', ')
    }. These sessions may edit the same files. Current shell directories and activity are not checked. </> : null}
    {similarNames.length > 0 ? <>Similar live sessions already use this directory and command: {similarNames.join(', ')}. Starting creates new sessions. </> : null}
    {similarUnavailable ? <>Could not check for matching live commands. </> : null}
    {report.incomplete ? <>Checkout peer check incomplete; review existing sessions before starting.</> : null}
  </p>
}
