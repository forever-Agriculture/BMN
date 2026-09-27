// MODULE: attention-prompt.ts - the structured question or permission an agent asked, as hooks report it
import { hasExactKeys } from './closed-shape'

/** The harness whose dialog the prompt is; each is answered its own way (docs/remote-answers.md). */
export type AttentionPromptHarness = 'claude' | 'codex' | 'opencode'

/**
 * Which row of the remote-answer shape matrix this prompt is. `choice` covers one or several
 * single-choice questions; a dialog with any multi-select question is `multi-select`.
 */
export type AttentionPromptShape =
  | 'choice'
  | 'async-choice'
  | 'multi-select'
  | 'subagent'
  | 'permission'
  | 'sandbox-network'

export interface AttentionPromptOption {
  label: string
  description: string | null
}

export interface AttentionPromptQuestion {
  /** The harness's own question id (Codex answers are keyed by it); null when it has none. */
  id: string | null
  header: string | null
  text: string
  multiSelect: boolean
  options: AttentionPromptOption[]
  /**
   * OpenCode's own `custom` flag: false when the agent turned off typed answers for this question. Absent
   * when the harness did not say, and for every Claude and Codex question, which always allow one.
   */
  custom?: boolean
}

export interface AttentionQuestionsPrompt {
  type: 'questions'
  harness: AttentionPromptHarness
  shape: Exclude<AttentionPromptShape, 'permission' | 'sandbox-network'>
  /** The harness's request id when it has one (OpenCode `que_…`), else null. */
  requestRef: string | null
  /** The tool call that asked (Claude and Codex `tool_use_id`), which its PostToolUse repeats. */
  toolUseId: string | null
  questions: AttentionPromptQuestion[]
}

export interface AttentionPermissionPrompt {
  type: 'permission'
  harness: AttentionPromptHarness
  shape: 'permission' | 'sandbox-network' | 'subagent'
  /** The harness's request id when it has one (OpenCode `per_…`), else null. */
  requestRef: string | null
  toolUseId: string | null
  /** What wants permission, as the harness names it: `Bash`, `Edit`, OpenCode `bash`. */
  tool: string
  /** The exact command, path or URL; null when the harness did not say exactly. */
  command: string | null
  /** The directory the agent is working in, when the harness reported it. */
  cwd: string | null
  /**
   * What Claude draws under the command (its `tool_input.description`), null when it gave none; absent from
   * prompts written before it was recorded. Anything else drawn there is not this dialog.
   */
  description?: string | null
}

export type AttentionPrompt = AttentionQuestionsPrompt | AttentionPermissionPrompt

/** Protective bounds for what a hook may store; semantic limits live with each harness's key script. */
export const ATTENTION_PROMPT_LIMITS = Object.freeze({
  questions: 10,
  options: 20,
  text: 2_000,
  header: 100,
  label: 200,
  description: 500,
  identifier: 128,
  tool: 100,
  command: 4_000,
  cwd: 4_096,
  /** One reported answer: a typed text, or Claude's chosen labels joined into one string. */
  answer: 4_000
})

const HARNESSES: readonly AttentionPromptHarness[] = ['claude', 'codex', 'opencode']
const QUESTION_SHAPES: readonly AttentionQuestionsPrompt['shape'][] = ['choice', 'async-choice', 'multi-select', 'subagent']
const PERMISSION_SHAPES: readonly AttentionPermissionPrompt['shape'][] = ['permission', 'sandbox-network', 'subagent']

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Any C0 control, DEL or C1 control; `multiline` lets tab, line feed and carriage return through. */
function hasControl(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (multiline && (code === 0x09 || code === 0x0a || code === 0x0d)) continue
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

class PromptError extends Error {}

function text(value: unknown, key: string, max: number, multiline = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PromptError(`prompt ${key} must be 1..${max} characters`)
  }
  if (hasControl(value, multiline)) throw new PromptError(`prompt ${key} must not contain control characters`)
  return value
}

function nullableText(value: unknown, key: string, max: number, multiline = false): string | null {
  return value === null ? null : text(value, key, max, multiline)
}

function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new PromptError(`prompt ${key} is not recognised`)
  return value as T
}

function list(value: unknown, key: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new PromptError(`prompt ${key} must hold 1..${max} entries`)
  }
  return value
}

function option(value: unknown): AttentionPromptOption {
  if (!isRecord(value) || !hasExactKeys(value, ['label', 'description'])) throw new PromptError('prompt option has the wrong shape')
  return {
    label: text(value.label, 'option label', ATTENTION_PROMPT_LIMITS.label),
    description: nullableText(value.description, 'option description', ATTENTION_PROMPT_LIMITS.description, true)
  }
}

function question(value: unknown): AttentionPromptQuestion {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'header', 'text', 'multiSelect', 'options'], ['custom'])) {
    throw new PromptError('prompt question has the wrong shape')
  }
  if (typeof value.multiSelect !== 'boolean') throw new PromptError('prompt question multiSelect must be true or false')
  if ('custom' in value && typeof value.custom !== 'boolean') throw new PromptError('prompt question custom must be true or false')
  return {
    id: nullableText(value.id, 'question id', ATTENTION_PROMPT_LIMITS.identifier),
    header: nullableText(value.header, 'question header', ATTENTION_PROMPT_LIMITS.header),
    text: text(value.text, 'question text', ATTENTION_PROMPT_LIMITS.text, true),
    multiSelect: value.multiSelect,
    options: list(value.options, 'options', ATTENTION_PROMPT_LIMITS.options).map(option),
    ...('custom' in value ? { custom: value.custom as boolean } : {})
  }
}

/** Validates a prompt a hook sent: closed keys, closed vocabularies, bounded sizes. Never trusts the harness. */
export function parseAttentionPrompt(value: unknown): Parsed<AttentionPrompt> {
  try {
    if (!isRecord(value)) throw new PromptError('prompt must be an object')
    if (value.type === 'questions') {
      if (!hasExactKeys(value, ['type', 'harness', 'shape', 'requestRef', 'toolUseId', 'questions'])) {
        throw new PromptError('prompt has the wrong shape')
      }
      return {
        ok: true,
        value: {
          type: 'questions',
          harness: oneOf(value.harness, 'harness', HARNESSES),
          shape: oneOf(value.shape, 'shape', QUESTION_SHAPES),
          requestRef: nullableText(value.requestRef, 'requestRef', ATTENTION_PROMPT_LIMITS.identifier),
          toolUseId: nullableText(value.toolUseId, 'toolUseId', ATTENTION_PROMPT_LIMITS.identifier),
          questions: list(value.questions, 'questions', ATTENTION_PROMPT_LIMITS.questions).map(question)
        }
      }
    }
    if (value.type === 'permission') {
      const keys = ['type', 'harness', 'shape', 'requestRef', 'toolUseId', 'tool', 'command', 'cwd']
      const described = 'description' in value
      if (!hasExactKeys(value, described ? [...keys, 'description'] : keys)) {
        throw new PromptError('prompt has the wrong shape')
      }
      return {
        ok: true,
        value: {
          type: 'permission',
          harness: oneOf(value.harness, 'harness', HARNESSES),
          shape: oneOf(value.shape, 'shape', PERMISSION_SHAPES),
          requestRef: nullableText(value.requestRef, 'requestRef', ATTENTION_PROMPT_LIMITS.identifier),
          toolUseId: nullableText(value.toolUseId, 'toolUseId', ATTENTION_PROMPT_LIMITS.identifier),
          tool: text(value.tool, 'tool', ATTENTION_PROMPT_LIMITS.tool),
          command: nullableText(value.command, 'command', ATTENTION_PROMPT_LIMITS.command, true),
          cwd: nullableText(value.cwd, 'cwd', ATTENTION_PROMPT_LIMITS.cwd),
          ...(described
            ? { description: nullableText(value.description, 'description', ATTENTION_PROMPT_LIMITS.description, true) }
            : {})
        }
      }
    }
    throw new PromptError('prompt type must be questions or permission')
  } catch (error) {
    if (error instanceof PromptError) return { ok: false, error: error.message }
    throw error
  }
}

/** The prompt as stored, or null for a row written before prompts existed or one that no longer parses. */
export function readStoredPrompt(json: string | null): AttentionPrompt | null {
  if (json === null) return null
  try {
    const parsed = parseAttentionPrompt(JSON.parse(json))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

/** The same dialog, ignoring which event carried it: the ids an event may omit are not content. */
function content(prompt: AttentionPrompt): string {
  return JSON.stringify({ ...prompt, requestRef: null, toolUseId: null })
}

/**
 * Two reports of one dialog merge into one prompt: Claude's PreToolUse carries the tool call id and its
 * PermissionRequest does not, so the id one of them knows is kept. Returns null when they are different
 * dialogs.
 */
export function mergeSamePrompt(stored: AttentionPrompt, incoming: AttentionPrompt): AttentionPrompt | null {
  if (content(stored) !== content(incoming)) return null
  // Two ids that are both known and differ are two dialogs that happen to read the same.
  if (stored.requestRef !== null && incoming.requestRef !== null && stored.requestRef !== incoming.requestRef) return null
  if (stored.toolUseId !== null && incoming.toolUseId !== null && stored.toolUseId !== incoming.toolUseId) return null
  return {
    ...stored,
    requestRef: stored.requestRef ?? incoming.requestRef,
    toolUseId: stored.toolUseId ?? incoming.toolUseId
  }
}

/**
 * What a harness reported about how a prompt ended, sent with the hook's resolve or withdraw. It proves
 * an answer landed only when it names that answer (docs/remote-answers.md, "Proof of an answer"); it can
 * never answer anything itself.
 */
export interface AttentionEvidence {
  /** The tool call the report is about (Claude and Codex `tool_use_id`). */
  toolUseId: string | null
  /** The harness's request id (OpenCode `requestID`). */
  requestRef: string | null
  /**
   * What each question was answered with, in the order the prompt asked them, exactly as the harness reported
   * it: Claude one string per question (labels joined by ", "), Codex its answers list, OpenCode its labels.
   * Null when the report names none.
   */
  answers: string[][] | null
  /** What the harness did with a permission; null when the report is not about one. */
  permission: 'allowed' | 'denied' | null
  /** The tool that ran and exactly what it acted on, for a permission the report cannot name by id. */
  tool: string | null
  command: string | null
}

const EVIDENCE_KEYS = ['toolUseId', 'requestRef', 'answers', 'permission', 'tool', 'command']

/** Validates the evidence a hook sent, with the same bounds a prompt has. */
export function parseAttentionEvidence(value: unknown): Parsed<AttentionEvidence> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) throw new PromptError('evidence has the wrong shape')
    let answers: string[][] | null = null
    if (value.answers !== null) {
      answers = list(value.answers, 'evidence answers', ATTENTION_PROMPT_LIMITS.questions).map((labels) =>
        list(labels, 'evidence labels', ATTENTION_PROMPT_LIMITS.options).map((label) =>
          text(label, 'evidence label', ATTENTION_PROMPT_LIMITS.answer)))
    }
    return {
      ok: true,
      value: {
        toolUseId: nullableText(value.toolUseId, 'evidence toolUseId', ATTENTION_PROMPT_LIMITS.identifier),
        requestRef: nullableText(value.requestRef, 'evidence requestRef', ATTENTION_PROMPT_LIMITS.identifier),
        answers,
        permission: value.permission === null ? null : oneOf(value.permission, 'evidence permission', ['allowed', 'denied'] as const),
        tool: nullableText(value.tool, 'evidence tool', ATTENTION_PROMPT_LIMITS.tool),
        command: nullableText(value.command, 'evidence command', ATTENTION_PROMPT_LIMITS.command, true)
      }
    }
  } catch (error) {
    if (error instanceof PromptError) return { ok: false, error: error.message }
    throw error
  }
}
