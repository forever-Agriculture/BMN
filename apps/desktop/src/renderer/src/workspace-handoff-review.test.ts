import { describe, expect, it } from 'vitest'
import type { HandoffReviewSnapshot, InputDraftRecord, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import type { AiTerminalBridge } from '../../preload/bridge'
import { prepareWorkspaceHandoffReview, sameHandoffDraft } from './workspace-handoff-review'

const draft: InputDraftRecord = {
  draftId: 'handoff-1', origin: 'handoff', state: 'draft', sourceSessionId: 'source',
  sessionId: 'target', text: 'Original', updatedAt: '2026-09-24T12:00:00.000Z',
  createdAt: '2026-09-24T11:00:00.000Z', preparedBy: 'agent', requestId: null,
  artifactId: null, artifactIds: [], attemptedIncarnationId: null, detail: null
}
const source = { sessionId: 'source', workspaceId: 'one', archivedAt: null, revision: 1 } as SessionRecord
const target = { sessionId: 'target', workspaceId: 'two', archivedAt: null, revision: 1 } as SessionRecord
const sourceWorkspace = { workspaceId: 'one', archivedAt: null, revision: 1 } as WorkspaceRecord
const destinationWorkspace = { workspaceId: 'two', archivedAt: null, revision: 1 } as WorkspaceRecord
const snapshot = (change: Partial<HandoffReviewSnapshot> = {}): HandoffReviewSnapshot => ({
  draft, source, destination: target, sourceWorkspace, destinationWorkspace, token: 'a'.repeat(64), ...change
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function reads(read: AiTerminalBridge['readHandoffReview']): Pick<AiTerminalBridge, 'readHandoffReview'> {
  return { readHandoffReview: read }
}

describe('workspace handoff review', () => {
  it('confirms one exact saved draft and addressed route', async () => {
    const tokens: Array<string | undefined> = []
    const prepared = await prepareWorkspaceHandoffReview(draft, 'one', reads(async (_id, _workspace, token) => {
      tokens.push(token)
      return snapshot()
    }), () => true, new AbortController().signal)

    expect(tokens).toEqual([undefined, 'a'.repeat(64)])
    expect(prepared.route.sessionId).toBe('source')
    expect(sameHandoffDraft(prepared.draft, draft)).toBe(true)
  })

  it('refuses a draft replaced while the first stored response is delayed', async () => {
    const held = deferred<HandoffReviewSnapshot>()
    let current = snapshot()
    let calls = 0
    const reviewing = prepareWorkspaceHandoffReview(draft, 'one', reads(async (_id, _workspace, token) => {
      if (++calls === 1) return held.promise
      if (token !== current.token) throw new Error('The handoff or destination changed')
      return current
    }), () => true, new AbortController().signal)
    current = snapshot({ draft: { ...draft, text: 'Replacement', updatedAt: '2026-09-24T12:00:01.000Z' },
      token: 'b'.repeat(64) })
    held.resolve(snapshot())

    await expect(reviewing).rejects.toThrow('handoff or destination changed')
  })

  it('refuses a destination archived before the final transactional read', async () => {
    const held = deferred<void>()
    const entered = deferred<void>()
    let destination = target
    let calls = 0
    const reviewing = prepareWorkspaceHandoffReview(draft, 'one', reads(async () => {
      if (++calls === 1) return snapshot()
      entered.resolve()
      await held.promise
      if (destination.archivedAt !== null) throw new Error('The handoff or destination changed')
      return snapshot({ destination })
    }), () => true, new AbortController().signal)
    await entered.promise
    destination = { ...target, revision: 2, archivedAt: '2026-09-24T12:01:00.000Z' }
    held.resolve()

    await expect(reviewing).rejects.toThrow('handoff or destination changed')
  })

  it('refuses a late reply after timeout or workspace switch', async () => {
    const held = deferred<HandoffReviewSnapshot>()
    const controller = new AbortController()
    const reviewing = prepareWorkspaceHandoffReview(draft, 'one', reads(async () => held.promise),
      () => true, controller.signal)
    controller.abort()
    held.resolve(snapshot())
    await expect(reviewing).rejects.toThrow('review expired')

    const switched = deferred<HandoffReviewSnapshot>()
    let current = true
    const second = prepareWorkspaceHandoffReview(draft, 'one', reads(async () => switched.promise),
      () => current, new AbortController().signal)
    current = false
    switched.resolve(snapshot())
    await expect(second).rejects.toThrow('workspace changed')
  })
})
