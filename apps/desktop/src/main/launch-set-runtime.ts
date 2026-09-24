import type { LaunchSetStartEntryResult, SessionProcessState, SessionRecord } from '@bmn/protocol'

/** A batch can finish after an early entry exited. Only current live incarnations get a pane lease. */
export function shouldAdoptLaunchSetRuntime(
  entry: LaunchSetStartEntryResult,
  record: SessionRecord,
  latestHostState: SessionProcessState | undefined
): entry is LaunchSetStartEntryResult & {
  incarnationId: string
  attachment: NonNullable<LaunchSetStartEntryResult['attachment']>
} {
  return entry.outcome === 'started' && !!entry.incarnationId && !!entry.attachment &&
    record.lastProcess?.incarnationId === entry.incarnationId &&
    record.lastProcess.state === 'live' &&
    (latestHostState === undefined || latestHostState === 'live')
}
