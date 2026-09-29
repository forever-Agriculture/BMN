import type {
  ConversationBindingState,
  ConversationResumePreview,
  ReportedResumeCommand,
  ReportedResumePreview,
  SessionRecord
} from '@bmn/protocol'
import { quoteArgv } from './launch-template'

export interface ConversationBindingPresentation {
  label: string
  detail: string
  canResume: boolean
  canLocate: boolean
  canStartNew: boolean
}

export function conversationBindingPresentation(
  binding: ConversationBindingState | undefined
): ConversationBindingPresentation {
  if (!binding) {
    return {
      label: 'Conversation binding loading',
      detail: 'Checking whether this CLI conversation can be resumed exactly.',
      canResume: false,
      canLocate: false,
      canStartNew: false
    }
  }
  const cli = binding.agentCli === 'other'
    ? 'CLI'
    : `${binding.agentCli[0]!.toUpperCase()}${binding.agentCli.slice(1)}`
  if (binding.status === 'bound') {
    return {
      label: `${cli} conversation bound`,
      detail: `${binding.detail}. Reference ${binding.conversationReference}.`,
      canResume: true,
      canLocate: false,
      canStartNew: false
    }
  }
  if (binding.status === 'missing') {
    return {
      label: 'Chat unavailable',
      detail: binding.detail,
      canResume: false,
      canLocate: true,
      canStartNew: true
    }
  }
  return {
    label: `${cli} conversation resume unsupported`,
    detail: binding.detail,
    canResume: false,
    canLocate: false,
    canStartNew: true
  }
}

/**
 * Story 43.2: Resume is offered for a conversation BMN captured, as before, and, where it captured none, for a stopped
 * session's command that a program in it reported. This is the host's own order, so the button and what starts agree.
 * `liveIncarnationId` is the window's live entry, which stays after its process exits so the pane keeps the output:
 * the process counts as stopped once the record says that incarnation ended.
 */
export function resumeAvailable(
  binding: ConversationBindingState | undefined,
  record: Pick<SessionRecord, 'reportedResume' | 'lastProcess'> | undefined,
  liveIncarnationId: string | undefined
): boolean {
  if (conversationBindingPresentation(binding).canResume) return true
  if (binding?.status !== 'unsupported' || record?.reportedResume === undefined) return false
  const last = record.lastProcess
  return liveIncarnationId === undefined || (last?.incarnationId === liveIncarnationId && last.state !== 'live')
}

/** Local HH:MM, or "--:--" when the time cannot be read. */
function clockTime(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return Number.isNaN(at.getTime()) ? '--:--' : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Who said the command and when, in the words Session details, Resume and the interrupted list all use. */
export function reportedResumeProvenance(reportedAt: string): string {
  return `Reported by the program in this session at ${clockTime(reportedAt)}`
}

/** Story 43.1 AC3: the Session details line, with the command exactly as reported. */
export function reportedResumeLine(command: ReportedResumeCommand): { label: string; argv: string; when: string } {
  return {
    label: 'Resume command reported by the program:',
    argv: quoteArgv(command.argv),
    when: `at ${clockTime(command.reportedAt)}`
  }
}

export interface ReportedResumeConfirmation {
  message: string
  /** The command exactly as the program reported it. */
  argv: string
  /** The resolved command BMN will launch after applying session arguments. */
  command: string
  /** Where its name resolves on the session's PATH now; null when it no longer does. */
  program: string | null
  folder: string
  provenance: string
  /** Why it cannot run, when it cannot; Resume then offers Start again. */
  refusal: string | null
}

/** Story 43.2 AC2: the Resume dialog for a reported command says what runs, where, and who said so. */
export function reportedResumeConfirmation(
  preview: ReportedResumePreview,
  sessionName: string
): ReportedResumeConfirmation {
  return {
    message: preview.refusal === null
      ? `Resume "${sessionName}" with the command a program in it reported. This command runs:`
      : `"${sessionName}" cannot be resumed with the command a program in it reported:`,
    argv: quoteArgv(preview.argv),
    command: preview.command,
    program: preview.program,
    folder: preview.cwd,
    provenance: reportedResumeProvenance(preview.reportedAt),
    refusal: preview.refusal
  }
}

export async function resumeBoundConversation<Result>(
  binding: ConversationBindingState | undefined,
  resume: () => Promise<Result>
): Promise<{ started: true; result: Result } | { started: false; message: string }> {
  const presentation = conversationBindingPresentation(binding)
  if (!presentation.canResume) return { started: false, message: presentation.detail }
  return { started: true, result: await resume() }
}

export interface ResumeConfirmationPresentation {
  /** What the owner is about to reopen, before any process starts. */
  message: string
  /** The exact command BMN will run, shown on its own so nothing is paraphrased. */
  command: string
  /** What Resume leaves behind and why, or `null` when it carries everything over. */
  notCarried: { names: string; reason: string } | null
}

/**
 * The words of the Resume confirmation. The command comes from the utility's own launch builder,
 * so what is shown here is what runs.
 */
export function resumeConfirmationPresentation(
  preview: ConversationResumePreview,
  sessionName: string
): ResumeConfirmationPresentation {
  const cli = preview.agentCli === 'claude' ? 'Claude Code'
    : preview.agentCli === 'opencode' ? 'OpenCode'
      : preview.agentCli === 'cursor' ? 'Cursor' : 'Codex'
  return {
    message: `Resume the ${cli} conversation in "${sessionName}". This command runs:`,
    command: preview.command,
    // Saying why keeps a dropped argument from reading as something BMN mislaid.
    notCarried: preview.notCarried === ''
      ? null
      : {
          names: preview.notCarried,
          reason: preview.agentCli === 'cursor'
            ? 'BMN carries only --model and --workspace into cursor-agent --resume.'
            : `${preview.agentCli} resume does not accept them.`
        }
  }
}
