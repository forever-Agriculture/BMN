// MODULE: departure-actions.ts - one owner action through the revision-fenced departure bridge
import { compareGrantOrder, ownerGrantView, type DesktopDepartureInput, type OwnerDepartureReply, type OwnerGrantView } from '@bmn/protocol'
export async function performDepartureAction(input: DesktopDepartureInput, send: (input: DesktopDepartureInput) => Promise<OwnerDepartureReply>): Promise<OwnerDepartureReply> {
  let reply = await send(input)
  if (input.action !== 'open') return reply
  for (let retry = 0; retry < 2 && reply.outcome === 'stale' && input.periodId !== null &&
    (reply.view.generation ?? 0) === (input.expectedGeneration ?? 0) && reply.view.period?.periodId === input.periodId && reply.view.period.state === 'leaving'; retry++) {
    reply = await send({ ...input, expectedRevision: reply.view.revision })
  }
  return reply
}

export async function readDepartureGrant(generation: number, read: () => Promise<OwnerGrantView>): Promise<OwnerGrantView> {
  try { return await read() }
  catch { return ownerGrantView({ state: 'unknown', generation, reason: 'The list could not be read' }) }
}

export interface GrantViewState {
  view: OwnerGrantView | null
  unreadable: boolean
  latest: number
  invalidatedThrough: number
}

export const INITIAL_GRANT_VIEW: GrantViewState = { view: null, unreadable: false, latest: 0, invalidatedThrough: 0 }

/** During a failed read, keep the last list mounted. Only a fresh read may establish the view again. */
export function adoptGrantView(state: GrantViewState, view: OwnerGrantView,
  request: number, issued: number, fromRead: boolean): GrantViewState {
  if (request <= state.invalidatedThrough) return state
  if (view.generation != null && state.view?.generation != null && view.generation < state.view.generation) return state
  if (view.read === 'unknown') {
    if (request < state.latest) return state
    return { view: state.view ?? view, unreadable: true, latest: request, invalidatedThrough: issued }
  }
  if (state.unreadable && !fromRead) return state
  const order = state.view?.read === 'read' ? compareGrantOrder(view, state.view) : 1
  if (order < 0 || (order === 0 && request < state.latest)) return state
  return { ...state, view, unreadable: false, latest: Math.max(request, state.latest) }
}
