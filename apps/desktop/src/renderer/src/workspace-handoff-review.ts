// MODULE: workspace-handoff-review.ts - confirm one exact stored handoff revision before opening Files
import type { HandoffReviewSnapshot, InputDraftRecord, SessionRecord } from '@bmn/protocol'
import type { AiTerminalBridge } from '../../preload/bridge'
import { boundedRead } from './bounded-read'

type HandoffReads = Pick<AiTerminalBridge, 'readHandoffReview'>

export function sameHandoffDraft(left: InputDraftRecord, right: InputDraftRecord): boolean {
  return left.draftId === right.draftId && left.updatedAt === right.updatedAt &&
    left.createdAt === right.createdAt && left.origin === right.origin && left.state === right.state &&
    left.sourceSessionId === right.sourceSessionId && left.sessionId === right.sessionId &&
    left.preparedBy === right.preparedBy && left.requestId === right.requestId &&
    left.text === right.text && left.artifactId === right.artifactId &&
    JSON.stringify(left.artifactIds) === JSON.stringify(right.artifactIds) &&
    left.attemptedIncarnationId === right.attemptedIncarnationId && left.detail === right.detail
}

export interface PreparedHandoffReview {
  draft: InputDraftRecord
  route: SessionRecord
  snapshot: HandoffReviewSnapshot
}

export async function prepareWorkspaceHandoffReview(
  draft: InputDraftRecord,
  workspaceId: string,
  reads: HandoffReads,
  stillCurrent: () => boolean,
  signal: AbortSignal
): Promise<PreparedHandoffReview> {
  const ensureCurrent = (): void => {
    if (signal.aborted) throw new Error('The handoff review expired. Refresh results before review.')
    if (!stillCurrent()) throw new Error('The destination or workspace changed. Refresh results before review.')
  }
  ensureCurrent()
  const first = await boundedRead(reads.readHandoffReview(draft.draftId, workspaceId))
  ensureCurrent()
  if (!sameHandoffDraft(first.draft, draft)) {
    throw new Error('The handoff changed or was removed. Refresh results before review.')
  }
  // Confirmation is another atomic worker read. A mutation between the two reads changes its token.
  const snapshot = await boundedRead(reads.readHandoffReview(draft.draftId, workspaceId, first.token))
  ensureCurrent()
  if (snapshot.token !== first.token || !sameHandoffDraft(snapshot.draft, draft)) {
    throw new Error('The handoff or destination changed. Refresh results before review.')
  }
  const route = snapshot.draft.state === 'draft' ? snapshot.source : snapshot.destination
  ensureCurrent()
  return { draft: snapshot.draft, route, snapshot }
}
