import type { SavedOutputCatalog } from '@ai-terminal/protocol'
import type { SessionIdentity, SessionManager } from './session-manager'

type SavedOutputManager = Pick<SessionManager, 'savedOutputCatalog'> &
  Partial<Pick<SessionManager, 'savedOutputCatalogForSession'>>

export function routeTerminalSavedOutputGet(
  manager: SavedOutputManager,
  identity: { sessionId: string; incarnationId?: string },
  viewEpoch?: string
): Promise<SavedOutputCatalog> {
  if (identity.incarnationId) {
    return manager.savedOutputCatalog(identity as SessionIdentity, viewEpoch)
  }
  if (!manager.savedOutputCatalogForSession) {
    throw new Error('Session-scoped saved output is unavailable')
  }
  return manager.savedOutputCatalogForSession(identity.sessionId)
}
