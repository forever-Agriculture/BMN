// MODULE: layout-writer.ts - the single serialized, coalescing per-workspace layout write path
import {
  ERROR_CODES,
  type LayoutGetResult,
  type LayoutPutParams,
  type WorkspaceLayoutState
} from '@bmn/protocol'
import { failureDetail, hasBridgeErrorCode } from './bridge-error'

/**
 * One layout transition. It is folded onto the latest desired state and folded again onto the
 * authoritative state after a revision conflict, so it must be a pure function of its input. It
 * returns the same object when it changes nothing.
 */
export type LayoutChange = (state: WorkspaceLayoutState) => WorkspaceLayoutState

export interface LayoutWriterPort {
  put(params: LayoutPutParams): Promise<WorkspaceLayoutState>
  get(workspaceId: string): Promise<LayoutGetResult>
  /** Every change to a workspace's desired or authoritative layout is published here. */
  publish(state: WorkspaceLayoutState): void
  notice(message: string): void
  failure(message: string): void
}

export interface LayoutWriter {
  /** Replaces every lane with the given authoritative states; in-flight results are discarded. */
  reset(states: readonly WorkspaceLayoutState[]): void
  /** Adds or replaces one workspace's lane with an authoritative state. */
  adopt(state: WorkspaceLayoutState): void
  layout(workspaceId: string): WorkspaceLayoutState | undefined
  layouts(): Record<string, WorkspaceLayoutState>
  /** Folds a change into the workspace's desired state and schedules its write. Never throws. */
  apply(workspaceId: string, change: LayoutChange): boolean
  /** Resolves once the workspace has no write in flight and nothing pending. */
  idle(workspaceId: string): Promise<void>
}

/** Consecutive revision conflicts tolerated before the lane gives up and shows authoritative state. */
export const LAYOUT_CONFLICT_RETRY_LIMIT = 3

interface Lane {
  confirmed: WorkspaceLayoutState
  desired: WorkspaceLayoutState
  pending: LayoutChange[]
  inFlight: boolean
  conflicts: number
  idle: Array<() => void>
}

/**
 * The single layout write path. Each workspace has one lane: at most one `layout.put` is in flight,
 * later changes coalesce into the next put, every put carries the last authoritative revision, and
 * a typed REVISION_CONFLICT re-fetches authoritative state and re-applies the pending changes.
 */
export function createLayoutWriter(port: LayoutWriterPort): LayoutWriter {
  const lanes = new Map<string, Lane>()

  const settleIdle = (lane: Lane): void => {
    if (lane.inFlight || lane.pending.length > 0) return
    const waiters = lane.idle.splice(0)
    for (const resolve of waiters) resolve()
  }

  const rebase = (lane: Lane): void => {
    let state = lane.confirmed
    const kept: LayoutChange[] = []
    for (const change of lane.pending) {
      try {
        const next = change(state)
        if (next === state) continue
        state = next
        kept.push(change)
      } catch (error) {
        port.failure(failureDetail(error, 'A layout change no longer applies'))
      }
    }
    lane.pending = kept
    lane.desired = state
  }

  const abandon = (lane: Lane, message: string): void => {
    lane.inFlight = false
    lane.pending = []
    lane.conflicts = 0
    lane.desired = lane.confirmed
    port.publish(lane.confirmed)
    port.failure(message)
    settleIdle(lane)
  }

  const pump = (workspaceId: string, lane: Lane): void => {
    if (lane.inFlight || lane.pending.length === 0) {
      settleIdle(lane)
      return
    }
    const sent = lane.pending.length
    const expectedRevision = lane.confirmed.revision
    const state: WorkspaceLayoutState = { ...lane.desired, revision: expectedRevision }
    const current = (): boolean => lanes.get(workspaceId) === lane
    lane.inFlight = true
    let request: Promise<WorkspaceLayoutState>
    try {
      request = port.put({ workspaceId, expectedRevision, state })
    } catch (error) {
      request = Promise.reject(error)
    }
    void request.then(
      (authoritative) => {
        if (!current()) return
        lane.inFlight = false
        lane.conflicts = 0
        lane.confirmed = authoritative
        lane.pending = lane.pending.slice(sent)
        rebase(lane)
        port.publish(lane.desired)
        pump(workspaceId, lane)
      },
      (error: unknown) => {
        if (!current()) return
        if (!hasBridgeErrorCode(error, ERROR_CODES.revisionConflict)) {
          abandon(lane, failureDetail(error, 'Layout could not be saved'))
          return
        }
        lane.conflicts += 1
        if (lane.conflicts > LAYOUT_CONFLICT_RETRY_LIMIT) {
          abandon(lane, 'Layout could not be saved: it kept changing elsewhere')
          return
        }
        void port.get(workspaceId).then(
          (result) => {
            if (!current()) return
            lane.inFlight = false
            if (result.notice) port.notice(result.notice)
            lane.confirmed = result.layout
            rebase(lane)
            port.publish(lane.desired)
            pump(workspaceId, lane)
          },
          (refetchError: unknown) => {
            if (!current()) return
            abandon(lane, failureDetail(refetchError, 'Layout could not be re-read'))
          }
        )
      }
    )
  }

  const retire = (lane: Lane | undefined): void => {
    if (!lane) return
    const waiters = lane.idle.splice(0)
    for (const resolve of waiters) resolve()
  }

  const adopt = (state: WorkspaceLayoutState): void => {
    retire(lanes.get(state.workspaceId))
    lanes.set(state.workspaceId, {
      confirmed: state,
      desired: state,
      pending: [],
      inFlight: false,
      conflicts: 0,
      idle: []
    })
  }

  return {
    reset: (states) => {
      for (const lane of lanes.values()) retire(lane)
      lanes.clear()
      for (const state of states) adopt(state)
    },
    adopt,
    layout: (workspaceId) => lanes.get(workspaceId)?.desired,
    layouts: () =>
      Object.fromEntries([...lanes].map(([workspaceId, lane]) => [workspaceId, lane.desired])),
    apply: (workspaceId, change) => {
      const lane = lanes.get(workspaceId)
      if (!lane) return false
      let next: WorkspaceLayoutState
      try {
        next = change(lane.desired)
      } catch (error) {
        port.failure(failureDetail(error, 'Layout change was rejected'))
        return false
      }
      if (next === lane.desired) return false
      lane.pending.push(change)
      lane.desired = next
      port.publish(next)
      pump(workspaceId, lane)
      return true
    },
    idle: (workspaceId) => {
      const lane = lanes.get(workspaceId)
      if (!lane || (!lane.inFlight && lane.pending.length === 0)) return Promise.resolve()
      return new Promise((resolve) => lane.idle.push(resolve))
    }
  }
}
