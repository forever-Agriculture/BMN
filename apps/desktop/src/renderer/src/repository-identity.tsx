import { useEffect, useRef, useState } from 'react'
import type { RepositoryIdentity } from '@bmn/protocol'
import { displayPath } from './session-presentation'

export interface IdentityLookupState {
  directory: string
  key: string
  loading: boolean
  identity?: RepositoryIdentity | undefined
}

/** One lookup at a time. A changed directory or newer refresh invalidates every older response. */
export function createIdentityLookup(
  read: (directory: string) => Promise<RepositoryIdentity>,
  publish: (state: IdentityLookupState) => void
): { start(directory: string, key?: string): Promise<RepositoryIdentity | undefined>; cancel(): void } {
  let generation = 0
  return {
    async start(directory, key = directory) {
      const current = ++generation
      publish({ directory, key, loading: true })
      try {
        const identity = await read(directory)
        if (current !== generation) return undefined
        publish({ directory, key, loading: false, identity })
        return identity
      } catch {
        if (current !== generation) return undefined
        const identity: RepositoryIdentity = {
          state: 'unavailable', directory, observedAt: new Date().toISOString(),
          reason: 'Repository inspection failed'
        }
        publish({ directory, key, loading: false, identity })
        return identity
      }
    },
    cancel() { generation += 1 }
  }
}

export function identityChanged(previous: RepositoryIdentity | undefined, next: RepositoryIdentity): boolean {
  if (!previous || previous.state === 'unavailable' || next.state === 'unavailable') return false
  if (previous.state !== next.state) return true
  if (previous.state !== 'repository' || next.state !== 'repository') return false
  return previous.root !== next.root || previous.linkedWorktree !== next.linkedWorktree ||
    previous.head.state !== next.head.state ||
    ('name' in previous.head ? previous.head.name : '') !== ('name' in next.head ? next.head.name : '')
}

export function useRepositoryIdentity(directory: string | null, requestKey = directory): {
  identity: RepositoryIdentity | undefined
  loading: boolean
  refresh: () => Promise<RepositoryIdentity | undefined>
} {
  const [state, setState] = useState<IdentityLookupState>()
  const lookup = useRef<ReturnType<typeof createIdentityLookup> | null>(null)
  if (!lookup.current) {
    lookup.current = createIdentityLookup(
      (path) => window.aiTerminal.inspectRepository(path),
      setState
    )
  }
  useEffect(() => {
    if (directory) void lookup.current?.start(directory, requestKey ?? directory)
    else lookup.current?.cancel()
    return () => lookup.current?.cancel()
  }, [directory, requestKey])
  const current = directory && state?.directory === directory && state.key === requestKey ? state : undefined
  return {
    identity: current?.identity,
    loading: !!directory && (current?.loading ?? true),
    refresh: () => directory ? lookup.current!.start(directory, requestKey ?? directory) : Promise.resolve(undefined)
  }
}

/** Full section in Session details; `compact` is the one line under the launcher's Directory field. */
export function RepositoryIdentityView({
  directory, identity, loading, onRefresh, compact = false, home = null
}: {
  directory: string
  identity?: RepositoryIdentity | undefined
  loading: boolean
  onRefresh?: () => void
  compact?: boolean
  home?: string | null
}): React.JSX.Element {
  const current = identity?.directory === directory ? identity : undefined
  let description = 'Reading repository identity…'
  if (!loading && current?.state === 'not-repository') description = 'Not a Git repository'
  if (!loading && current?.state === 'unavailable') description = `Repository identity unavailable: ${current.reason}`
  if (!loading && current?.state === 'repository') {
    const branch = current.head.state === 'branch'
      ? `Branch ${current.head.name}`
      : current.head.state === 'unborn'
        ? `Unborn branch ${current.head.name}`
        : 'Detached HEAD'
    description = `${branch} · ${current.linkedWorktree ? 'Linked worktree' : 'Main worktree'}`
  }
  const read = current && !loading ? new Date(current.observedAt).toLocaleTimeString() : null
  if (compact) {
    return <div className="repository-identity compact" aria-live="polite">
      <span title={read ? `Read from selected directory at ${read}` : undefined}>{description}</span>
      {onRefresh ? <button type="button" className="ghost small" onClick={onRefresh}>Refresh identity</button> : null}
    </div>
  }
  return <section className="repository-identity inspector-section" aria-live="polite">
    <h3>Repository
      {onRefresh ? <button type="button" className="ghost small" onClick={onRefresh}>Refresh identity</button> : null}
    </h3>
    <dl className="kv">
      <dt>Directory</dt>
      <dd className="path" title={directory}><bdi>{displayPath(directory, home)}</bdi></dd>
      {current?.state === 'repository' && !loading ? <>
        <dt>Repository root</dt>
        <dd className="path" title={current.root}><bdi>{displayPath(current.root, home)}</bdi></dd>
      </> : null}
      <dt>State</dt>
      <dd title={description}>{description}</dd>
    </dl>
    {read ? <small>Read from selected directory at {read}</small> : null}
  </section>
}
