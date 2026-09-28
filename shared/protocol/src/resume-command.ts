// MODULE: resume-command.ts - the command a program reports for resuming it, and what Resume shows for it (Epic 43)
import { hasControlOrFormatCharacter } from './file-reference'

/**
 * Story 43.1: the command a program in a session said resumes it, kept for the process that said so. It is not a
 * conversation binding: BMN starts it only when it has no conversation of its own for the session, and only when the
 * owner presses Resume after reading it (Story 43.2).
 */
export interface ReportedResumeCommand {
  /** Exactly as reported: a plain command name, then its arguments. */
  argv: string[]
  reportedAt: string
}

export const REPORTED_RESUME_MAX_ARGUMENTS = 64
export const REPORTED_RESUME_MAX_ARGUMENT_BYTES = 1024
export const REPORTED_RESUME_MAX_TOTAL_BYTES = 8 * 1024

const utf8 = new TextEncoder()

/**
 * Why a reported command is refused, naming the rule it breaks, or null when its shape is acceptable. Every
 * control and invisible formatting character is refused, not stripped as Story 34.1 strips them from prose: the
 * owner confirms this text as the command that runs. Whether the name is on the session's PATH is the host's check.
 */
export function reportedResumeArgvProblem(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return 'The command is missing: give the program and its arguments after --'
  if (argv.length > REPORTED_RESUME_MAX_ARGUMENTS) {
    return `The command has ${argv.length} parts; at most ${REPORTED_RESUME_MAX_ARGUMENTS} are allowed`
  }
  let total = 0
  for (const [index, part] of argv.entries()) {
    if (typeof part !== 'string') return `Part ${index + 1} of the command is not text`
    const bytes = utf8.encode(part).byteLength
    if (bytes > REPORTED_RESUME_MAX_ARGUMENT_BYTES) {
      return `Part ${index + 1} of the command is ${bytes} bytes; each may be at most ${REPORTED_RESUME_MAX_ARGUMENT_BYTES}`
    }
    if (hasControlOrFormatCharacter(part)) {
      return `Part ${index + 1} of the command contains a control or invisible formatting character`
    }
    total += bytes
  }
  if (total > REPORTED_RESUME_MAX_TOTAL_BYTES) {
    return `The command is ${total} bytes in all; at most ${REPORTED_RESUME_MAX_TOTAL_BYTES} are allowed`
  }
  const program = argv[0] as string
  if (program === '' || program === '.' || program === '..' || program.includes('/')) {
    return `The program must be a plain command name found on PATH, not a path: "${program}"`
  }
  return null
}

/** A stored reported command, or null when what was stored is not one (a hand-edited or damaged row). */
export function parseReportedResumeCommand(value: unknown): ReportedResumeCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { argv, reportedAt } = value as Record<string, unknown>
  if (reportedResumeArgvProblem(argv) !== null || typeof reportedAt !== 'string' || !Number.isFinite(Date.parse(reportedAt))) {
    return null
  }
  return { argv: [...(argv as string[])], reportedAt }
}

/**
 * Story 43.2: what Resume would run for a session BMN has no conversation of its own for, from the command a program
 * in it reported. `program` is where the name resolves on the session's PATH now; when it no longer resolves,
 * `program` is null and `refusal` says so, and Resume offers Start again instead.
 */
export interface ReportedResumePreview {
  sessionId: string
  source: 'reported'
  argv: string[]
  program: string | null
  /** The session's working folder, where it runs. */
  cwd: string
  reportedAt: string
  /** What the start compares before it runs: the resolved program and the reported arguments; empty when refused. */
  command: string
  refusal: string | null
}
