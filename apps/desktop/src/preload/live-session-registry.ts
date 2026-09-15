interface LiveSessionEntry {
  sessionId: string
  attachmentId: string
}

interface SessionEntry {
  sessionId: string
}

interface RegistryStartupSuccess<Live extends LiveSessionEntry, Session extends SessionEntry> {
  ok: true
  liveSessions: Live[]
  sessions: Session[]
}

interface RegistryStartupFailure {
  ok: false
}

/**
 * Records a session that became live after startup (resumed or created) in the startup snapshot a
 * late `onStartup` subscriber replays, replacing that session's previous incarnation only. A
 * failure snapshot is left as is: the recovery startup that follows it carries every live session.
 */
export function withLiveSession<
  Live extends LiveSessionEntry,
  Session extends SessionEntry,
  Startup extends RegistryStartupSuccess<Live, Session> | RegistryStartupFailure
>(latest: Startup | undefined, live: Live, session?: Session): Startup | undefined {
  if (!latest || !latest.ok) return latest
  const current = latest as Startup & RegistryStartupSuccess<Live, Session>
  const liveSessions = [
    ...current.liveSessions.filter((entry) => entry.sessionId !== live.sessionId),
    live
  ]
  const sessions = session
    ? [...current.sessions.filter((entry) => entry.sessionId !== session.sessionId), session]
    : current.sessions
  return { ...current, liveSessions, sessions }
}
