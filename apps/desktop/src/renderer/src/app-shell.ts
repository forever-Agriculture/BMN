// MODULE: app-shell.ts - the application shell's dialog and side-panel states and its two waits, moved whole from main.tsx (Story 80.19)
import type { ConversationBindingState, InterruptedSessionCohort, SessionRecord, SessionResumePreview, WorkspaceRecord } from '@bmn/protocol'
import type { FileReferenceRequest } from './file-reference-dialog'
import type { PreferencesPlace } from './preferences-dialog'
import type { QuickLookRequest } from './quick-look'
import type { ProgressPresentation } from './session-presentation'

type ShellDialog =
  | { kind: 'palette' }
  | { kind: 'recent-sessions'; sessionIds: string[] }
  | { kind: 'workspace-pins'; workspaceId: string; openedFromWorkspaceId: string | null }
  /** Chooses the session for a second pane beside `sessionId`. */
  | { kind: 'split-picker'; sessionId: string | null }
  | { kind: 'preferences'; page?: PreferencesPlace }
  | { kind: 'workspace-results'; workspace: WorkspaceRecord; openedFromWorkspaceId: string | null }
  /** The owner's reading of one workspace's messages between sessions (Epic 66). */
  | { kind: 'workspace-messages'; workspaceId: string; openedFromWorkspaceId: string | null }
  /** Read-only: a session's kept turns, one opened to its files and a file's difference (Story 69.5). */
  | { kind: 'turn-changes'; sessionId: string }
  | { kind: 'new-workspace' }
  | { kind: 'dev-auto-runs'; workspaceId?: string }
  | { kind: 'rename-workspace'; workspace: WorkspaceRecord }
  | { kind: 'locate'; session: SessionRecord; binding: ConversationBindingState }
  | { kind: 'stop'; session: SessionRecord }
  /** Shows the exact command before Resume starts anything. */
  | { kind: 'resume'; session: SessionRecord; preview: SessionResumePreview }
  | { kind: 'file-reference'; request: FileReferenceRequest }
  /** Quick look (Epic 67); focus goes back to `returnTo`'s terminal when it closes. */
  | { kind: 'quick-look'; request: QuickLookRequest; returnTo: string | null; openedFromWorkspaceId: string | null }
  /** The one offer to resume what an update or a quit stopped; every row shows its command. */
  | { kind: 'resume-interrupted'; cohort: InterruptedSessionCohort }
  /** Read-only: what this session's harness reported, for a request that did or did not arrive. */
  | { kind: 'hook-events'; session: SessionRecord }
  | { kind: 'plan-use' }
  /** Story 76.3: "I'm away…": the palette's second mode, a note for himself or just Enter. */
  | { kind: 'away-note' }
  /** Story 76.6: "While you were away", the current period's summary, read-only. */
  | { kind: 'away-summary' }
  /** Story 84.3: Before you go, the departure's cards, answered only here or on Telegram. */
  | { kind: 'before-you-go' }
  /**
   * Read-only: one progress observation and the published files it points at. The observation is
   * captured when the detail opens, so a newer report cannot swap itself in under the owner.
   */
  | {
      kind: 'progress-evidence'
      session: SessionRecord
      opened: ProgressPresentation
      reportedIncarnationId: string | null
      /** The process the observation belonged to; a different one closes the detail. */
      incarnationId: string | null
    }

type SidePanel = 'files' | 'details' | 'new' | null

const APP_EVENT_REFRESH_MS = 15_000
/** How long a new session's shell gets to read its first command line before BMN types nothing into it. */
const SHELL_READY_WAIT_MS = 10_000

export type { ShellDialog, SidePanel }
export { APP_EVENT_REFRESH_MS, SHELL_READY_WAIT_MS }
