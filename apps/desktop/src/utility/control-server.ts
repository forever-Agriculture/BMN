// MODULE: control-server.ts - authenticated newline-delimited JSON-RPC control socket for agents and the owner CLI
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import {
  AGENT_ATTENTION_ORIGINS,
  DECISION_LIMITS,
  DECISION_REFERENCE_KINDS,
  GRANT_ACTION_RESULTS,
  GRANT_LIMITS,
  GRANT_ROUND_RESULTS,
  grantIdentifier,
  grantReportText,
  parseGrantCardInput,
  type GrantReportInput,
  type GrantReportResult,
  type GrantTerm,
  type DecisionPayload,
  type DecisionReferenceKind,
  ERROR_CODES,
  isRecord,
  GUARD_AGENTS,
  GUARD_CAUSES,
  MAX_CONTROL_FRAME_BYTES,
  MAX_PROGRESS_EVIDENCE,
  MAX_USAGE_WINDOWS,
  SESSION_MESSAGE_HANDOVER,
  TURN_END_KINDS,
  TURN_MARK_CONFIRMED_STATUSES,
  TURN_MARK_EDGES,
  TURN_MARK_STATUSES,
  cleanSessionMessageText,
  isAttentionOrigin,
  hasDisallowedHandoffControl,
  isHookEventName,
  isProtocolErrorCode,
  parseAttentionEvidence,
  parseAttentionPrompt,
  parseAttentionProducer,
  parseManualChoices,
  type ManualChoices,
  type AttentionProducer,
  reportedResumeArgvProblem,
  stripFormatCharacters,
  type AttentionKind,
  type AttentionEvidence,
  type AttentionPrompt,
  type ConversationObservationSource,
  type GuardAgent,
  type GuardCause,
  type GuardReport,
  type HookEventAgent,
  type HookEventEffect,
  type LiveAgentCli,
  type ProgressState,
  type ProtocolErrorCode,
  type TurnEndKind,
  type TurnMarkEdge,
  type TurnMarkStatus,
  type UsageWindow
} from '@bmn/protocol'
import type { ControlAuth, ControlScope } from './control-auth'
import { OPENCODE_REFERENCE_PATTERN } from './conversation-binding'

export class ControlError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string, readonly retryable = false) {
    super(message)
    this.name = 'ControlError'
  }
}

/** The narrowing this server does on purpose: a conversation belongs to an agent CLI, not to a shell. */
type ConversationAgentCli = LiveAgentCli

export interface ControlHandlers {
  /** Revocation: session tokens are valid only while their incarnation is the current live one. */
  isCurrentIncarnation(sessionId: string, incarnationId: string): boolean
  sessionExists(sessionId: string): boolean
  /** Must resolve to an object with a numeric `watermark`. */
  snapshot(scope: ControlScope): Promise<unknown>
  listSessions(scope: ControlScope): Promise<unknown>
  publishArtifact(p: {
    sessionId: string
    incarnationId: string | null
    path: string
    name?: string
    source: 'agent' | 'owner'
  }): Promise<unknown>
  reportProgress(p: {
    sessionId: string
    incarnationId: string | null
    source: string
    state: ProgressState
    label: string
    detail?: string
    /** Already-published artifact IDs this report points at; empty means none, never the last report's. */
    evidenceIds: readonly string[]
    observedAt: string
  }): Promise<unknown>
  openAttention(p: {
    sessionId: string
    incarnationId: string | null
    requestKey: string
    kind: AttentionKind
    title: string
    body?: string
    expiresAt?: string
    /** The agent's own app already notifies the owner's phone. */
    phoneNotified?: boolean
    /** What opened it, from the closed origin vocabulary. */
    origin?: string
    /** The agent's own question or permission, already validated. */
    prompt?: AttentionPrompt
    producer?: AttentionProducer
    manualChoices?: ManualChoices
    /** Story 76.4: the session's own hook may still refuse this blocking question before its native request opens. */
    awayRefusable?: boolean
  }): Promise<unknown>
  /**
   * A session may address one destination, in any workspace; the handler stores the handoff and queues it for the
   * receiving agent's own hook (Story 75.5).
   */
  prepareHandoff(p: {
    sourceSessionId: string
    sourceIncarnationId: string
    destinationSessionId: string
    text: string
    artifactIds: string[]
    senderCwd: string
  }): Promise<unknown>
  /** Epic 66: the sessions a session may message. Never reachable by the owner token. */
  listPeers(sessionId: string): Promise<unknown>
  /** One short text for one peer; the handler stamps where it is from and stores it. It reaches no terminal. */
  sendMessage(p: {
    senderSessionId: string
    senderIncarnationId: string
    destinationSessionId: string
    text: string
    /** The folder the sending `bmn` process itself stood in. */
    senderCwd: string
  }): Promise<unknown>
  /** The caller's own sent messages and where each stands; nothing of a receiver's activity. */
  messageStatus(sessionId: string, messageId: string | null): Promise<unknown>
  /**
   * Epic 66.4: hands a session's own hook the one message it may print for its agent, consuming it. `destination`
   * is where that agent sends work, as the hook resolved it for this event.
   */
  takeMessage(p: {
    sessionId: string
    incarnationId: string
    pid: number
    app: string
    destination: { provider: string; host: string; basis: string; default: boolean }
  }): Promise<unknown>
  /** The hook's word that it printed what it took. */
  reportMessage(p: { sessionId: string; incarnationId: string; pid: number; messageId: string; claimId: string }): Promise<unknown>
  /** Records why a conversation report was refused, so a refusal is not silent to the owner. */
  reportRefusal(method: string, sessionId: string | null, reason: string): void
  /** The harness's own word about which conversation its process is in; never reachable by the owner token. */
  observeConversation(p: {
    sessionId: string
    incarnationId: string | null
    agentCli: ConversationAgentCli
    conversationReference: string
    source: ConversationObservationSource
    transcriptPath?: string
  }): Promise<unknown>
  withdrawAttention(p: { sessionId: string; requestKey: string; origin?: string; evidence?: AttentionEvidence; producer?: AttentionProducer }): Promise<unknown>
  resolveAttention(p: {
    sessionId: string
    requestKey: string
    resolution: string
    producer?: AttentionProducer
    origin?: string
    /** What the harness reported about how the prompt ended; it can prove an answer, never make one. */
    evidence?: AttentionEvidence
  }): Promise<unknown>
  /**
   * Hands a session's OpenCode plugin the answers BMN already decided from a Telegram tap, consuming them.
   * Only for the session's own live process; nothing here can create or change an answer.
   */
  takeAnswers(p: {
    sessionId: string
    incarnationId: string | null
    waitMs: number
    report: { requestRef: string; delivered: boolean } | null
    /** Claude's waiting `PermissionRequest` hook (Epic 78): only the answer for its own request, and whether it still waits. */
    requestRef?: string
  }): Promise<unknown>
  /** One hook event, recorded so the owner can see which events arrived; it changes nothing by itself. */
  observeHookEvent(p: {
    sessionId: string
    /** The incarnation that reported it, so a later process does not inherit its predecessor's log. */
    incarnationId: string | null
    agent: HookEventAgent
    event: string
    source: string | null
    toolName: string | null
    /** What BMN's OpenCode plugin promises (Story 96.3): 1 reports the owner's stop and quitting; absent from earlier plugins. */
    plugin?: number | undefined
    fingerprint?: string | undefined
    /** Hostname only, from the agent's own base-URL environment; absent when the CLI could not read one. */
    apiHost?: string | undefined
    /** The model name the hook payload carried; absent when it carried none. */
    model?: string | undefined
    /** The Claude config folder the CLI resolved (Story 31.1); absent from other agents and old CLIs. */
    claudeConfigDir?: string | undefined
    effects: readonly HookEventEffect[]
    /** Epic 69: what the event says of a turn. Only a session's own hook may say it. */
    turn?: { conversation: string; turn: string | null; nested: boolean } | undefined
    /** Story 76.4 AC2: the hook holds its conversation's away lock, so it may be handed the away state. */
    awayLock?: true | undefined
  }): Promise<unknown>
  /**
   * Epic 69: one mark of a turn's start, of the hook's confirmation or of its end, from a session's own hook.
   * The answer is one status word and nothing else; never reachable by the owner token.
   */
  markTurn(p: {
    sessionId: string
    incarnationId: string
    requestId: string
    edge: TurnMarkEdge
    app: string
    conversation: string
    turn: string | null
    folder: string | null
    until: number | null
    kind: TurnEndKind | null
    continued: boolean
  }): Promise<TurnMarkStatus>
  /** The connection a turn's start mark came on closed: a "before" nobody confirmed goes at once. */
  dropTurnMark(sessionId: string, requestId: string): void
  /**
   * One plan-use reading from Claude's status line (Story 37.2): the windows and context share the
   * status-line input carried, never the input itself. It is kept in memory for the reporting run.
   */
  reportUsage(p: {
    sessionId: string
    incarnationId: string
    agent: 'claude'
    windows: readonly UsageWindow[]
    contextUsedPercent: number | null
  }): Promise<unknown>
  /**
   * One prompt-guard decision from a session's own prompt hook (Story 60.8): who and where, never
   * the prompt. Kept in memory for the reporting run; a `pass` clears what an earlier prompt left.
   */
  reportGuard(p: GuardReport): Promise<unknown>
  /** Writes text into the PTY as a bracketed paste; appends '\r' only when submit is true. */
  submitInput(p: { sessionId: string; text: string; submit: boolean }): Promise<void>
  /**
   * Story 43.1: the command that resumes the session's running program, reported by a program in the session for
   * that process only. The shape is checked here; whether the name is on the session's PATH is the handler's check.
   */
  reportResumeCommand(p: { sessionId: string; incarnationId: string; argv: readonly string[] }): Promise<unknown>
  clearResumeCommand(p: { sessionId: string; incarnationId: string }): Promise<unknown>
  /** Story 76.3: the owner's said state; the note only to the owner's token (R76-NFR3). */
  awayStatus(scope: ControlScope): Promise<unknown>
  /** Story 83.3: the push policy's stored facts and standing, for `bmn policy`; read by any scope, written by none. */
  policyStatus(): Promise<unknown>
  /** Story 76.4: the session's hook printed the away snapshot BMN handed for this conversation; printed is never read. */
  awayPrinted(p: { sessionId: string; agent: string; conversation: string; revision: number; claimId: string }): Promise<unknown>
  /** Story 76.5: a decision the session's agent made while the owner is away; the host binds provenance and period. */
  recordDecision(p: { sessionId: string; incarnationId: string | null; key: string; revision: number; payload: DecisionPayload }): Promise<unknown>
  /** Story 76.5: what came of a recorded decision, under its own operation key. */
  decisionOutcome(p: { sessionId: string; key: string; op: string; result: 'done' | 'failed'; evidence: string[] }): Promise<unknown>
  /**
   * Story 76.3: away or back. The owner's token says it as `cli`; a session's agent only on his words, naming the revision
   * it saw, as `agent`. `operationKey` makes a retry return the first result.
   */
  changeAway(p: { scope: ControlScope; to: 'away' | 'back'; note?: string | null; expectedRevision?: number; operationKey?: string }): Promise<unknown>
  /** Story 84.3: his departure words, forwarded by an agent naming the away revision it saw, or the owner's CLI. */
  leaveAway(p: { scope: ControlScope; expectedRevision?: number }): Promise<unknown>
  /** Story 84.3: a run's card for the open departure; the host binds the asking session. */
  askGrant(p: { scope: ControlScope; runId: string; card: { title: string; scope: string; nothing: boolean; terms: GrantTerm[] }; operationKey?: string }): Promise<unknown>
  /** Story 84.3 AC4: one run's grant, or every run this caller may see. */
  grantStatus(p: { scope: ControlScope; runId?: string }): Promise<unknown>
  /** R84-FR3, FR8: one round or one item use, recorded before the step it pays for. */
  useGrant(p: { sessionId: string; runId: string; useId: string; boundary?: string; item?: string }): Promise<unknown>
  reportGrant(p: GrantReportInput): Promise<unknown>
}

export interface ReceiptRecord {
  key: string
  paramsHash: string
  state: 'staged' | 'done' | 'failed'
  result?: unknown
  error?: { code: string; message: string }
}

export interface ReceiptStore {
  get(key: string): Promise<ReceiptRecord | undefined>
  put(record: ReceiptRecord): Promise<void>
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly records = new Map<string, ReceiptRecord>()

  async get(key: string): Promise<ReceiptRecord | undefined> {
    const record = this.records.get(key)
    return record === undefined ? undefined : structuredClone(record)
  }

  async put(record: ReceiptRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record))
  }
}

interface ControlServerOptions {
  /** Parent dir created 0700; socket chmod 0600; a stale socket file is removed only if connecting to it fails. */
  socketPath: string
  auth: ControlAuth
  handlers: ControlHandlers
  receipts: ReceiptStore
  now?: () => Date
}

type Params = Record<string, unknown>
type RequestId = string | number | null

interface ControlRequest {
  id: string | number
  method: string
  params: unknown
}

interface Connection {
  socket: Socket
  scope: ControlScope | null
  buffered: Buffer[]
  bufferedBytes: number
  closing: boolean
  discarding: boolean
  queue: Promise<void>
}

interface TextRule {
  min: number
  max: number
  unit: 'characters' | 'bytes'
  controls: 'reject' | 'allow-whitespace' | 'allow'
  /**
   * Agent-written text the owner reads: invisible and direction-changing format characters are removed before
   * the length rule, so a field that held only those is empty (Story 34.1).
   */
  strip?: true
}

const JSONRPC_SERVER_ERROR = -32000
const MAX_INPUT_TEXT_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 500
const CLOSE_GRACE_MS = 1000
/** How long one `answer.take` may wait for an answer; the CLI's own deadline is longer. */
const MAX_ANSWER_WAIT_SECONDS = 25
const REQUEST_KEYS = ['jsonrpc', 'id', 'method', 'params']
const PROGRESS_STATES: readonly ProgressState[] = [
  'running', 'waiting', 'blocked', 'claimed-done', 'verified', 'failed', 'unknown'
]
const ATTENTION_KINDS: readonly AttentionKind[] = ['question', 'permission', 'review', 'notice']
/**
 * The harnesses a session token may report as. `terminal` is BMN's own label for a notification the
 * window read out of a session's output, so nothing on the socket may wear it.
 */
const HOOK_EVENT_AGENTS: readonly HookEventAgent[] = ['claude', 'codex', 'opencode']
const HOOK_EVENT_EFFECTS: readonly HookEventEffect[] = ['opened', 'withdrew', 'answered']
const MAX_HOOK_EVENT_EFFECTS = 8
const CONVERSATION_AGENT_CLIS: readonly ConversationAgentCli[] = ['claude', 'codex', 'opencode']
const CONVERSATION_OBSERVATION_SOURCES: readonly ConversationObservationSource[] = ['startup', 'resume', 'clear', 'fork']
/** 8-4-4-4-12 hex, the shape Claude Code session ids and Codex rollout ids use. */
const CONVERSATION_REFERENCE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** A turn's id as an app gives it (Epic 69): Claude Code's `prompt_id`, Codex's `turn_id`. */
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const SESSION_TOKEN_TEXT = /s1\.[A-Za-z0-9_:-]+\.[A-Za-z0-9_:-]+\.[0-9a-fA-F]{16,}/g
const LONG_HEX_TEXT = /[0-9a-fA-F]{32,}/g

const IDENTIFIER: TextRule = { min: 1, max: 128, unit: 'characters', controls: 'reject' }
/** A parsed hostname: a name (letters, digits, '.', '_', '-') or a bracketed IPv6 literal. */
const API_HOST_SHAPE = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/

const RULES = {
  sessionId: IDENTIFIER,
  requestKey: IDENTIFIER,
  idempotencyKey: IDENTIFIER,
  path: { min: 1, max: 4096, unit: 'bytes', controls: 'reject' },
  name: { min: 1, max: 255, unit: 'characters', controls: 'reject' },
  source: { min: 1, max: 64, unit: 'characters', controls: 'reject' },
  /** A progress or hook source and a tool name: shown to the owner, so cleaned like any agent words. */
  shownSource: { min: 1, max: 64, unit: 'characters', controls: 'reject', strip: true },
  apiHost: { min: 1, max: 255, unit: 'characters', controls: 'reject' },
  model: { min: 1, max: 128, unit: 'characters', controls: 'reject', strip: true },
  label: { min: 1, max: 200, unit: 'characters', controls: 'reject', strip: true },
  detail: { min: 1, max: 2000, unit: 'characters', controls: 'allow-whitespace', strip: true },
  title: { min: 1, max: 200, unit: 'characters', controls: 'reject', strip: true },
  body: { min: 1, max: 8000, unit: 'characters', controls: 'allow-whitespace', strip: true },
  resolution: { min: 1, max: 200, unit: 'characters', controls: 'reject' },
  conversationReference: { min: 36, max: 36, unit: 'characters', controls: 'reject' },
  text: { min: 0, max: MAX_INPUT_TEXT_BYTES, unit: 'bytes', controls: 'allow' },
  guardLine: { min: 1, max: 600, unit: 'characters', controls: 'reject', strip: true },
  timestamp: { min: 1, max: 64, unit: 'characters', controls: 'reject' },
  /** Story 76.3: his own note; the store refuses one over 200 characters rather than cutting it. */
  awayNote: { min: 0, max: 4096, unit: 'characters', controls: 'reject' },
  /** Story 76.5: a decision's words, shown to the owner as inert text. */
  decisionChoice: { min: 1, max: DECISION_LIMITS.choice, unit: 'characters', controls: 'reject', strip: true },
  decisionReason: { min: 1, max: DECISION_LIMITS.reason, unit: 'characters', controls: 'allow-whitespace', strip: true },
  decisionAffects: { min: 1, max: DECISION_LIMITS.affects, unit: 'characters', controls: 'allow-whitespace', strip: true },
  decisionReverse: { min: 1, max: DECISION_LIMITS.reverse, unit: 'characters', controls: 'allow-whitespace', strip: true }
} satisfies Record<string, TextRule>

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The invalid-argument ControlError, returned for the caller to throw: unlike the main and host helpers, it does not throw. */
function invalidError(message: string): ControlError {
  return new ControlError(ERROR_CODES.invalidArgument, message)
}

function unauthorized(message: string): ControlError {
  return new ControlError(ERROR_CODES.unauthorized, message)
}

function hasControlCharacter(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f) return true
    if (code < 0x20 && !(allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d))) return true
  }
  return false
}

function closedParams(value: unknown, allowed: readonly string[]): Params {
  if (value === undefined) return {}
  if (!isRecord(value)) throw invalidError('params must be an object')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidError(`Unknown parameter: ${key.slice(0, 64)}`)
  }
  return value
}

/**
 * The value a handler receives. Stripping returns a new string and never rewrites `params`, so an idempotency
 * receipt keeps hashing the parameters exactly as received and a retry of an earlier request still matches.
 */
function checkedText(key: string, received: string, rule: TextRule): string {
  const value = rule.strip ? stripFormatCharacters(received) : received
  const size = rule.unit === 'bytes' ? Buffer.byteLength(value, 'utf8') : value.length
  if (size < rule.min || size > rule.max) {
    throw invalidError(`${key} must be ${rule.min}..${rule.max} ${rule.unit}`)
  }
  if (rule.controls !== 'allow' && hasControlCharacter(value, rule.controls === 'allow-whitespace')) {
    throw invalidError(`${key} must not contain control characters`)
  }
  return value
}

function readText(params: Params, key: string, rule: TextRule): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidError(`${key} must be a string`)
  return checkedText(key, value, rule)
}

function requireText(params: Params, key: string, rule: TextRule): string {
  const value = readText(params, key, rule)
  if (value === undefined) throw invalidError(`${key} is required`)
  return value
}

function readTimestamp(params: Params, key: string): string | undefined {
  const value = readText(params, key, RULES.timestamp)
  if (value === undefined) return undefined
  const time = Date.parse(value)
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(time)) {
    throw invalidError(`${key} must be an ISO 8601 timestamp with a timezone`)
  }
  return new Date(time).toISOString()
}

/** A share of a limit as the agent reported it; above 100 when a plan is overdrawn, never negative. */
function readPercent(params: Params, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
    throw invalidError(`${key} must be a number from 0 to 1000`)
  }
  return value
}

function readBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || typeof value === 'boolean') return value
  throw invalidError(`${key} must be a boolean`)
}

/** Evidence a hook sent with a resolve or withdraw; malformed evidence is refused, not dropped. */
function readEvidence(params: Params): AttentionEvidence | undefined {
  if (params.evidence === undefined) return undefined
  const parsed = parseAttentionEvidence(params.evidence)
  if (!parsed.ok) throw invalidError(parsed.error)
  return parsed.value
}

function requireEnum<T extends string>(params: Params, key: string, allowed: readonly T[]): T {
  const value = params[key]
  if (value === undefined) throw invalidError(`${key} is required`)
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalidError(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * Provenance is optional metadata, so a malformed, oversized or unauthorized origin is dropped and recorded -
 * never allowed to stop the open, withdraw or resolve it came with. `owner`, `input`, `telegram` and `expiry`
 * are the app's own words: a session token may claim only its harness's hook events and the CLI it runs itself,
 * so an agent cannot dress its own action up as the owner's.
 */
function acceptableOrigin(value: unknown, scope: ControlScope): boolean {
  if (typeof value !== 'string' || !isAttentionOrigin(value)) return false
  if (scope.kind === 'owner') return true
  // ...and only as a harness it could actually be running, never as the window's own label.
  if (value.startsWith('hook:')) {
    return HOOK_EVENT_AGENTS.some((agent) => value.startsWith(`hook:${agent}:`))
  }
  return (AGENT_ATTENTION_ORIGINS as readonly string[]).includes(value)
}

/** One dropped origin per caller per this long reaches the refusal log; the reason never varies. */
const ORIGIN_REFUSAL_QUIET_MS = 60_000

/** A bounded array of identifiers, for a repeatable option; absent means an empty list, never inherited. */
/** A decision key or operation key: letters, digits and . _ : - only, at most 120. */
function decisionKey(value: string, key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw invalidError(`${key} must be letters, digits and . _ : - (at most 120)`)
  return value
}

function readIdentifiers(params: Params, key: string, max: number): string[] {
  const value = params[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidError(`${key} must be an array`)
  if (value.length > max) throw invalidError(`${key} must hold at most ${max} entries`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw invalidError(`${key} entries must be text`)
    return checkedText(`${key}[${index}]`, entry, IDENTIFIER)
  })
}

function requireEffects(params: Params, key: string): HookEventEffect[] {
  const value = params[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidError(`${key} must be an array`)
  if (value.length > MAX_HOOK_EVENT_EFFECTS) {
    throw invalidError(`${key} must hold at most ${MAX_HOOK_EVENT_EFFECTS} entries`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !(HOOK_EVENT_EFFECTS as readonly string[]).includes(entry)) {
      throw invalidError(`${key} entries must be one of: ${HOOK_EVENT_EFFECTS.join(', ')}`)
    }
  }
  return value as HookEventEffect[]
}

/** The pid of the agent a hook speaks for, as the hook read it from the process table. */
function requirePid(params: Params): number {
  const { pid } = params
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || pid > 0x7fff_ffff) throw invalidError('pid must be a process id')
  return pid
}

/** How a destination can be known; an unknown one is never sent. */
const DESTINATION_BASES = ['observed-default', 'explicit', 'owner-declared'] as const
/** The longest message text a request may carry before invisible characters are removed from it. */
const MESSAGE_TEXT_RECEIVED_MAX = 16 * 1024

function requestId(message: unknown): RequestId {
  if (!isRecord(message)) return null
  const { id } = message
  if (typeof id === 'string' && id.length <= 128) return id
  if (typeof id === 'number' && Number.isFinite(id)) return id
  return null
}

function parseRequest(message: unknown): ControlRequest {
  if (!isRecord(message)) throw invalidError('Request must be a JSON-RPC 2.0 object')
  for (const key of Object.keys(message)) {
    if (!REQUEST_KEYS.includes(key)) throw invalidError(`Unknown request member: ${key.slice(0, 64)}`)
  }
  if (message.jsonrpc !== '2.0') throw invalidError('jsonrpc must be "2.0"')
  const id = requestId(message)
  if (id === null) throw invalidError('Request id must be a finite number or a string of at most 128 characters')
  if (typeof message.method !== 'string' || message.method.length === 0) {
    throw invalidError('method must be a non-empty string')
  }
  if (message.params !== undefined && !isRecord(message.params)) throw invalidError('params must be an object')
  return { id, method: message.method, params: message.params }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function paramsHash(params: Params): string {
  const rest = { ...params }
  delete rest.idempotencyKey
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/** What an identical retry gets from its receipt: the result, 'uncertain' for a staged one, or the stored failure. */
function replayed(existing: ReceiptRecord): unknown {
  if (existing.state === 'done') return withDuplicate(existing.result)
  if (existing.state === 'staged') return { state: 'uncertain', duplicate: true }
  const stored = existing.error
  const code = stored && isProtocolErrorCode(stored.code) ? stored.code : ERROR_CODES.ioError
  throw new ControlError(code, stored?.message || 'Earlier attempt failed')
}

/** The methods whose stripped fields can make a request accepted before Story 34.1 fail validation now. */
const STRIPPED_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['attention.open', 'handoff.prepare'])

function withDuplicate(result: unknown): unknown {
  return isRecord(result) ? { ...result, duplicate: true } : { result: result ?? null, duplicate: true }
}

function incarnationOf(scope: ControlScope): string | null {
  return scope.kind === 'session' ? scope.incarnationId : null
}

function scopeKey(scope: ControlScope): string {
  return scope.kind === 'owner' ? 'owner' : `session:${scope.sessionId}`
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createConnection(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy()
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stats
  try {
    stats = await lstat(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSocket()) throw new Error('Refusing to replace a non-socket file at the control socket path')
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Control socket is already in use by a live server')
  }
  try {
    await unlink(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class ControlServer {
  private server: Server | undefined
  private readonly connections = new Set<Connection>()
  /** When each caller last had a dropped origin recorded, so a bad parameter cannot flood the log. */
  private readonly originRefusals = new Map<string, number>()
  private readonly receiptLocks = new Map<string, Promise<void>>()
  private readonly now: () => Date

  constructor(private readonly options: ControlServerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error('Control server is already listening')
    const { socketPath } = this.options
    const directory = dirname(socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await removeStaleSocket(socketPath)
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    try {
      await chmod(socketPath, 0o600)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Node unlinks the socket path when a listening pipe server closes. */
  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    for (const connection of this.connections) {
      connection.closing = true
      connection.socket.destroy()
    }
    this.connections.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      scope: null,
      buffered: [],
      bufferedBytes: 0,
      closing: false,
      discarding: false,
      queue: Promise.resolve()
    }
    this.connections.add(connection)
    socket.on('data', (chunk: Buffer) => this.receive(connection, chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      connection.closing = true
      this.connections.delete(connection)
    })
  }

  private receive(connection: Connection, chunk: Buffer): void {
    if (connection.closing || connection.discarding) return
    let start = 0
    let newline = chunk.indexOf(0x0a, start)
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline)
      if (connection.bufferedBytes + piece.byteLength > MAX_CONTROL_FRAME_BYTES) {
        this.rejectOversize(connection)
        return
      }
      const line = Buffer.concat([...connection.buffered, piece])
      connection.buffered = []
      connection.bufferedBytes = 0
      this.enqueue(connection, () => this.handleLine(connection, line))
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    const rest = chunk.subarray(start)
    if (connection.bufferedBytes + rest.byteLength > MAX_CONTROL_FRAME_BYTES) {
      this.rejectOversize(connection)
      return
    }
    if (rest.byteLength > 0) {
      connection.buffered.push(Buffer.from(rest))
      connection.bufferedBytes += rest.byteLength
    }
  }

  /** Earlier complete lines still run first; everything after the oversize line is discarded. */
  private rejectOversize(connection: Connection): void {
    connection.discarding = true
    connection.buffered = []
    connection.bufferedBytes = 0
    this.enqueue(connection, async () => {
      this.fail(connection, null, invalidError(`Request line exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`), true)
    })
  }

  private enqueue(connection: Connection, task: () => Promise<void>): void {
    connection.queue = connection.queue
      .then(async () => {
        if (!connection.closing) await task()
      })
      .catch(() => {
        connection.closing = true
        connection.socket.destroy()
      })
  }

  private async handleLine(connection: Connection, line: Buffer): Promise<void> {
    const beforeAuth = connection.scope === null
    let text: string
    try {
      text = utf8.decode(line)
    } catch {
      this.fail(connection, null, invalidError('Request is not valid UTF-8'), beforeAuth)
      return
    }
    if (text.trim() === '') return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.fail(connection, null, invalidError('Request is not valid JSON'), beforeAuth)
      return
    }
    let request: ControlRequest
    try {
      request = parseRequest(message)
    } catch (error) {
      this.fail(connection, requestId(message), error, beforeAuth)
      return
    }
    const scope = connection.scope
    if (scope === null) {
      this.authenticate(connection, request)
      return
    }
    try {
      this.assertNotRevoked(scope)
    } catch (error) {
      this.fail(connection, request.id, error, true)
      return
    }
    try {
      const result = await this.dispatchOrReplay(scope, request.method, request.params, connection)
      this.respond(connection, { jsonrpc: '2.0', id: request.id, result: result ?? null })
    } catch (error) {
      this.fail(connection, request.id, error, false)
    }
  }

  private authenticate(connection: Connection, request: ControlRequest): void {
    try {
      if (request.method !== 'auth') throw unauthorized('The first request on a connection must be auth')
      const params = closedParams(request.params, ['token'])
      const scope = this.options.auth.verify(params.token)
      if (scope === null) throw unauthorized('Invalid credential')
      this.assertNotRevoked(scope)
      connection.scope = scope
      this.respond(connection, {
        jsonrpc: '2.0',
        id: request.id,
        result: scope.kind === 'owner' ? { scope: 'owner' } : { scope: 'session', sessionId: scope.sessionId }
      })
    } catch (error) {
      this.fail(connection, request.id, error, true)
    }
  }

  private assertNotRevoked(scope: ControlScope): void {
    if (
      scope.kind === 'session' &&
      !this.options.handlers.isCurrentIncarnation(scope.sessionId, scope.incarnationId)
    ) {
      throw unauthorized('Credential revoked')
    }
  }

  private respond(connection: Connection, payload: Record<string, unknown>): void {
    if (connection.closing) return
    let line: string
    try {
      line = JSON.stringify(payload)
    } catch {
      line = JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id ?? null,
        error: {
          code: JSONRPC_SERVER_ERROR,
          message: 'Control result could not be encoded',
          data: { code: ERROR_CODES.ioError, retryable: false }
        }
      })
    }
    connection.socket.write(`${line}\n`)
  }

  private fail(connection: Connection, id: RequestId, error: unknown, close: boolean): void {
    const controlError = this.toControlError(error)
    this.respond(connection, {
      jsonrpc: '2.0',
      id,
      error: {
        code: JSONRPC_SERVER_ERROR,
        message: this.redact(controlError.message),
        data: { code: controlError.code, retryable: controlError.retryable }
      }
    })
    if (!close || connection.closing) return
    connection.closing = true
    connection.socket.end()
    setTimeout(() => connection.socket.destroy(), CLOSE_GRACE_MS).unref()
  }

  private toControlError(error: unknown): ControlError {
    if (error instanceof ControlError) return error
    const detail = error instanceof Error ? error.message : String(error)
    return new ControlError(ERROR_CODES.ioError, `Control request failed: ${detail}`)
  }

  private redact(message: string): string {
    const { ownerToken } = this.options.auth
    return message
      .split(ownerToken)
      .join('[redacted]')
      .replace(SESSION_TOKEN_TEXT, '[redacted]')
      .replace(LONG_HEX_TEXT, '[redacted]')
      .slice(0, MAX_ERROR_MESSAGE_LENGTH)
  }

  /** Session scope may omit sessionId (own) or name only itself; owner scope must name an existing session. */
  /**
   * The origin to store, or undefined when none was offered or the one offered was dropped and recorded.
   * The refused word is never echoed - a caller must not be able to write its own line into the refusal
   * log - and one line per caller per quiet period is enough, since the reason never varies. Without that
   * a caller could turn a cheap parameter mistake into an unbounded queue of appends.
   */
  private usableOrigin(
    params: Params,
    scope: ControlScope,
    method: string,
    handlers: ControlHandlers
  ): string | undefined {
    const value = params.origin
    if (value === undefined || value === null) return undefined
    if (acceptableOrigin(value, scope)) return value as string
    const caller = scope.kind === 'session' ? scope.sessionId : null
    const now = Date.now()
    // The map holds only callers still inside their quiet period, so it cannot grow with the sessions that
    // have ever made the mistake.
    for (const [seen, at] of this.originRefusals) {
      if (now - at >= ORIGIN_REFUSAL_QUIET_MS) this.originRefusals.delete(seen)
    }
    if (!this.originRefusals.has(caller ?? '')) {
      this.originRefusals.set(caller ?? '', now)
      handlers.reportRefusal(method, caller, 'origin refused: unknown provenance for this credential')
    }
    return undefined
  }

  private producer(params: Params, scope: ControlScope, origin: string | undefined): AttentionProducer | undefined {
    if (params.producer === undefined) return undefined
    const producer = parseAttentionProducer(params.producer)
    if (!producer || scope.kind !== 'session' || !origin?.startsWith(`hook:${producer.agentCli}:`)) {
      throw invalidError('producer requires a matching foreground hook and session credential')
    }
    return producer
  }

  private target(scope: ControlScope, params: Params): string {
    const requested = readText(params, 'sessionId', RULES.sessionId)
    if (scope.kind === 'session') {
      if (requested !== undefined && requested !== scope.sessionId) {
        throw unauthorized('Session credentials may only target their own session')
      }
      return scope.sessionId
    }
    if (requested === undefined) throw invalidError('sessionId is required for owner requests')
    if (!this.options.handlers.sessionExists(requested)) {
      throw new ControlError(ERROR_CODES.notFound, 'Session not found')
    }
    return requested
  }

  /**
   * Story 34.1: a request accepted before format characters were stripped can now fail validation (a title
   * that held only them is empty). An identical retry under the same idempotency key still gets its stored
   * receipt, as `idempotent` would give it; a new request keeps the validation error.
   */
  private async dispatchOrReplay(scope: ControlScope, method: string, rawParams: unknown, connection?: Connection): Promise<unknown> {
    try {
      return await this.dispatch(scope, method, rawParams, connection)
    } catch (error) {
      // Only those methods: a receipt key joins scope, method and key with `|`, so an unknown method must never
      // reach a receipt.
      if (!STRIPPED_IDEMPOTENT_METHODS.has(method) || !(error instanceof ControlError) ||
        error.code !== ERROR_CODES.invalidArgument || !isRecord(rawParams)) throw error
      let idempotencyKey: string | undefined
      try {
        idempotencyKey = readText(rawParams, 'idempotencyKey', RULES.idempotencyKey)
      } catch {
        throw error
      }
      if (idempotencyKey === undefined) throw error
      const existing = await this.options.receipts.get(`${scopeKey(scope)}|${method}|${idempotencyKey}`).catch(() => undefined)
      if (existing === undefined || existing.paramsHash !== paramsHash(rawParams)) throw error
      return replayed(existing)
    }
  }

  private async dispatch(scope: ControlScope, method: string, rawParams: unknown, connection?: Connection): Promise<unknown> {
    const { handlers } = this.options
    switch (method) {
      case 'auth':
        throw invalidError('Connection is already authenticated')
      case 'state.snapshot': {
        closedParams(rawParams, [])
        const snapshot = await handlers.snapshot(scope)
        if (!isRecord(snapshot) || typeof snapshot.watermark !== 'number' || !Number.isFinite(snapshot.watermark)) {
          throw new ControlError(ERROR_CODES.ioError, 'State snapshot is missing its watermark', true)
        }
        return snapshot
      }
      case 'session.list':
        closedParams(rawParams, [])
        return handlers.listSessions(scope)
      case 'artifact.publish': {
        const params = closedParams(rawParams, ['sessionId', 'path', 'name', 'idempotencyKey'])
        const path = requireText(params, 'path', RULES.path)
        if (!isAbsolute(path)) throw invalidError('path must be absolute')
        const name = readText(params, 'name', RULES.name)
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.publishArtifact({
          sessionId,
          incarnationId: incarnationOf(scope),
          path,
          ...(name === undefined ? {} : { name }),
          source: scope.kind === 'session' ? 'agent' : 'owner'
        }))
      }
      case 'handoff.prepare': {
        const params = closedParams(rawParams, ['destinationSessionId', 'text', 'artifactIds', 'senderCwd', 'idempotencyKey'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may prepare a handoff')
        const destinationSessionId = requireText(params, 'destinationSessionId', RULES.sessionId)
        const handoffText = requireText(params, 'text', {
          min: 1, max: 16 * 1024, unit: 'bytes', controls: 'allow-whitespace', strip: true
        })
        if (hasDisallowedHandoffControl(handoffText)) {
          throw invalidError('Handoff text may contain only newline and tab control characters')
        }
        const artifactIds = readIdentifiers(params, 'artifactIds', 10)
        // Story 75.5: the folder the command ran in, whose repository the provider check at hand-over covers.
        const senderCwd = requireText(params, 'senderCwd', RULES.path)
        if (!isAbsolute(senderCwd)) throw invalidError('senderCwd must be absolute')
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.prepareHandoff({
          sourceSessionId: scope.sessionId,
          sourceIncarnationId: scope.incarnationId,
          destinationSessionId,
          text: handoffText,
          artifactIds,
          senderCwd
        }))
      }
      case 'peers.list': {
        closedParams(rawParams, [])
        if (scope.kind !== 'session') throw unauthorized('Only a session may list its peers')
        return handlers.listPeers(scope.sessionId)
      }
      case 'message.send': {
        const params = closedParams(rawParams, ['destinationSessionId', 'text', 'senderCwd', 'idempotencyKey'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may leave a message for a peer')
        const destinationSessionId = requireText(params, 'destinationSessionId', RULES.sessionId)
        if (typeof params.text !== 'string') throw invalidError('text is required')
        if (params.text.length > MESSAGE_TEXT_RECEIVED_MAX) throw invalidError('text is too long')
        const cleaned = cleanSessionMessageText(params.text)
        if ('problem' in cleaned) throw invalidError(cleaned.problem)
        const senderCwd = requireText(params, 'senderCwd', RULES.path)
        if (!isAbsolute(senderCwd)) throw invalidError('senderCwd must be absolute')
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.sendMessage({
          senderSessionId: scope.sessionId,
          senderIncarnationId: scope.incarnationId,
          destinationSessionId,
          text: cleaned.text,
          senderCwd
        }))
      }
      case 'message.status': {
        const params = closedParams(rawParams, ['messageId'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may read the state of its own messages')
        return handlers.messageStatus(scope.sessionId, readText(params, 'messageId', IDENTIFIER) ?? null)
      }
      case 'message.take': {
        // Read-and-consume only, for the session's own hook: nothing here can write to a terminal or name another session.
        const params = closedParams(rawParams, ['agent', 'pid', 'destination'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may collect its own messages')
        const app = requireEnum(params, 'agent', Object.keys(SESSION_MESSAGE_HANDOVER))
        const pid = requirePid(params)
        if (params.destination === undefined) throw invalidError('destination is required')
        const destination = closedParams(params.destination, ['provider', 'host', 'basis', 'default'])
        if (typeof destination.default !== 'boolean') throw invalidError('destination.default must be true or false')
        return handlers.takeMessage({
          sessionId: scope.sessionId, incarnationId: scope.incarnationId, pid, app,
          destination: {
            provider: requireText(destination, 'provider', IDENTIFIER),
            host: requireText(destination, 'host', RULES.name),
            basis: requireEnum(destination, 'basis', DESTINATION_BASES),
            default: destination.default
          }
        })
      }
      case 'message.report': {
        const params = closedParams(rawParams, ['messageId', 'claimId', 'pid'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may report a message it printed')
        return handlers.reportMessage({
          sessionId: scope.sessionId, incarnationId: scope.incarnationId, pid: requirePid(params),
          messageId: requireText(params, 'messageId', IDENTIFIER), claimId: requireText(params, 'claimId', IDENTIFIER)
        })
      }
      case 'turn.mark': {
        // Epic 69: a session's own hook marks where its agent's turn starts and ends. It names no session: the
        // token says whose turn it is. What comes back is one status word; nothing of a capture can ride on it.
        const params = closedParams(rawParams, ['requestId', 'until', 'app', 'edge', 'kind', 'conversation', 'turn', 'folder', 'continued'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may mark its own turns')
        const edge = requireEnum(params, 'edge', TURN_MARK_EDGES)
        const app = requireEnum(params, 'app', HOOK_EVENT_AGENTS)
        const requestId = requireText(params, 'requestId', IDENTIFIER)
        const conversation = requireText(params, 'conversation', RULES.conversationReference)
        if (!CONVERSATION_REFERENCE.test(conversation)) throw invalidError('conversation is not a conversation reference')
        const turn = readText(params, 'turn', IDENTIFIER)
        if (turn !== undefined && !TURN_ID.test(turn)) throw invalidError('turn is not a turn id')
        const own: Record<TurnMarkEdge, readonly string[]> = { start: ['until', 'folder', 'continued'], confirm: [], end: ['kind'] }
        for (const key of ['until', 'folder', 'continued', 'kind']) {
          if (params[key] !== undefined && !own[edge].includes(key)) throw invalidError(`${key} does not belong to the edge ${edge}`)
        }
        let until: number | null = null
        let folder: string | null = null
        if (edge === 'start') {
          if (typeof params.until !== 'number' || !Number.isSafeInteger(params.until) || params.until <= 0) {
            throw invalidError('until must be a time in whole milliseconds')
          }
          until = params.until
          folder = readText(params, 'folder', RULES.path) ?? null
          if (folder !== null && !isAbsolute(folder)) throw invalidError('folder must be an absolute path')
          if (params.continued !== undefined && params.continued !== true) throw invalidError('continued must be true')
        }
        const status = await handlers.markTurn({
          sessionId: scope.sessionId, incarnationId: scope.incarnationId, requestId, edge, app, conversation: conversation.toLowerCase(),
          turn: turn ?? null, folder, until, kind: edge === 'end' ? requireEnum(params, 'kind', TURN_END_KINDS) : null,
          continued: params.continued === true
        })
        if (!(TURN_MARK_STATUSES as readonly unknown[]).includes(status)) throw new ControlError(ERROR_CODES.ioError, 'The mark was not answered')
        if (edge === 'start' && connection && TURN_MARK_CONFIRMED_STATUSES.includes(status)) {
          // The "before" waits for the hook's confirmation on this connection; when it closes first, the capture goes.
          const dropped = (): void => handlers.dropTurnMark(scope.sessionId, requestId)
          if (connection.closing) dropped()
          else connection.socket.once('close', dropped)
        }
        return { status }
      }
      case 'progress.report': {
        const params = closedParams(rawParams, [
          'sessionId', 'source', 'state', 'label', 'detail', 'observedAt', 'evidenceIds'
        ])
        const source = requireText(params, 'source', RULES.shownSource)
        const state = requireEnum(params, 'state', PROGRESS_STATES)
        const label = requireText(params, 'label', RULES.label)
        const detail = readText(params, 'detail', RULES.detail)
        const evidenceIds = readIdentifiers(params, 'evidenceIds', MAX_PROGRESS_EVIDENCE)
        const observedAt = readTimestamp(params, 'observedAt') ?? this.now().toISOString()
        const sessionId = this.target(scope, params)
        return handlers.reportProgress({
          sessionId,
          incarnationId: incarnationOf(scope),
          source,
          state,
          label,
          ...(detail === undefined ? {} : { detail }),
          evidenceIds,
          observedAt
        })
      }
      case 'attention.open': {
        const params = closedParams(rawParams, [
          'sessionId', 'requestKey', 'kind', 'title', 'body', 'expiresAt', 'idempotencyKey', 'phoneNotified',
          'origin', 'prompt', 'producer', 'manualChoices', 'awayRefusable'
        ])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        if (requestKey.startsWith('handoff:')) throw invalidError('The handoff request key is reserved')
        // Only the plan-use watch opens these; a session re-opening one would rewrite its reset period (Story 37.2).
        if (requestKey.startsWith('usage:')) throw invalidError('The usage request key is reserved')
        const kind = requireEnum(params, 'kind', ATTENTION_KINDS)
        const title = requireText(params, 'title', RULES.title)
        const body = readText(params, 'body', RULES.body)
        const expiresAt = readTimestamp(params, 'expiresAt')
        const idempotencyKey = readText(params, 'idempotencyKey', RULES.idempotencyKey)
        const phoneNotified = readBoolean(params, 'phoneNotified')
        let prompt: AttentionPrompt | undefined
        if (params.prompt !== undefined) {
          const parsed = parseAttentionPrompt(params.prompt)
          if (!parsed.ok) throw invalidError(parsed.error)
          // A question prompt belongs to a question request and a permission prompt to a permission one.
          if ((parsed.value.type === 'questions') !== (kind === 'question') || (parsed.value.type === 'permission') !== (kind === 'permission')) {
            throw invalidError('prompt type must match the request kind')
          }
          prompt = parsed.value
        }
        const origin = this.usableOrigin(params, scope, method, handlers)
        const producer = this.producer(params, scope, origin)
        const manualChoices = params.manualChoices === undefined ? undefined : parseManualChoices(params.manualChoices)
        if (manualChoices === null || manualChoices && (prompt || origin !== 'cli' || !['question', 'permission'].includes(kind))) {
          throw invalidError('manualChoices require a CLI question or decision with 2–8 distinct choices and no native prompt')
        }
        // Only a session's own hook, for its own question tool, says it can still refuse the question.
        const awayRefusable = readBoolean(params, 'awayRefusable')
        if (awayRefusable !== undefined && (scope.kind !== 'session' || kind !== 'question' || !origin?.startsWith('hook:'))) {
          throw invalidError('awayRefusable is for a session hook\'s own question')
        }
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, () => handlers.openAttention({
          sessionId,
          incarnationId: incarnationOf(scope),
          requestKey,
          kind,
          title,
          ...(body === undefined ? {} : { body }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(phoneNotified === undefined ? {} : { phoneNotified }),
          ...(origin === undefined ? {} : { origin }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(manualChoices ? { manualChoices } : {}),
          ...(producer === undefined ? {} : { producer }),
          ...(awayRefusable === true ? { awayRefusable } : {})
        }))
      }
      case 'conversation.observe': {
        // A hook discards what this call answers, so every refusal is recorded instead of vanishing.
        try {
          const params = closedParams(rawParams, [
            'sessionId', 'agentCli', 'conversationReference', 'source', 'transcriptPath'
          ])
          // The owner keeps the explicit replace route; only a session may speak for its own process.
          if (scope.kind !== 'session') {
            throw unauthorized('Only a session credential may report its own conversation')
          }
          const observedCli = requireEnum(params, 'agentCli', CONVERSATION_AGENT_CLIS)
          const conversationReference = requireText(params, 'conversationReference',
            observedCli === 'opencode'
              ? { min: 30, max: 30, unit: 'characters', controls: 'reject' }
              : RULES.conversationReference)
          if (observedCli === 'opencode'
            ? !OPENCODE_REFERENCE_PATTERN.test(conversationReference)
            : !CONVERSATION_REFERENCE.test(conversationReference)) {
            throw invalidError(observedCli === 'opencode'
              ? 'conversationReference must be an OpenCode session ID'
              : 'conversationReference must be a UUID')
          }
          const source = requireEnum(params, 'source', CONVERSATION_OBSERVATION_SOURCES)
          const transcriptPath = readText(params, 'transcriptPath', RULES.path)
          if (transcriptPath !== undefined && !isAbsolute(transcriptPath)) {
            throw invalidError('transcriptPath must be absolute')
          }
          const sessionId = this.target(scope, params)
          return await handlers.observeConversation({
            sessionId,
            incarnationId: incarnationOf(scope),
            agentCli: observedCli,
            conversationReference: observedCli === 'opencode' ? conversationReference : conversationReference.toLowerCase(),
            source,
            ...(transcriptPath === undefined ? {} : { transcriptPath })
          })
        } catch (error) {
          handlers.reportRefusal(
            method,
            scope.kind === 'session' ? scope.sessionId : null,
            this.redact(this.toControlError(error).message)
          )
          throw error
        }
      }
      case 'attention.withdraw': {
        const params = closedParams(rawParams, ['sessionId', 'requestKey', 'origin', 'evidence', 'producer'])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        if (requestKey.startsWith('handoff:') && scope.kind !== 'session') {
          throw unauthorized('Only the source session may withdraw its handoff')
        }
        const origin = this.usableOrigin(params, scope, method, handlers)
        const evidence = readEvidence(params)
        const producer = this.producer(params, scope, origin)
        const sessionId = this.target(scope, params)
        return handlers.withdrawAttention({
          sessionId,
          requestKey,
          ...(origin === undefined ? {} : { origin }),
          ...(evidence === undefined ? {} : { evidence }),
          ...(producer === undefined ? {} : { producer })
        })
      }
      case 'attention.resolve': {
        const params = closedParams(rawParams, ['sessionId', 'requestKey', 'resolution', 'origin', 'evidence', 'producer'])
        const requestKey = requireText(params, 'requestKey', RULES.requestKey)
        if (requestKey.startsWith('handoff:')) throw invalidError('Deliver or discard the handoff to resolve it')
        const resolution = requireText(params, 'resolution', RULES.resolution)
        const origin = this.usableOrigin(params, scope, method, handlers)
        const evidence = readEvidence(params)
        const producer = this.producer(params, scope, origin)
        const sessionId = this.target(scope, params)
        return handlers.resolveAttention({
          sessionId,
          requestKey,
          resolution,
          ...(origin === undefined ? {} : { origin }),
          ...(evidence === undefined ? {} : { evidence }),
          ...(producer === undefined ? {} : { producer })
        })
      }
      case 'answer.take': {
        // Read-and-consume only: the answers were decided inside the app from a Telegram tap (Epic 30, decision 5).
        const params = closedParams(rawParams, ['wait', 'reported', 'requestRef'])
        if (scope.kind !== 'session') throw unauthorized('Only a session may collect its own answers')
        const requestRef = params.requestRef === undefined ? undefined : requireText(params, 'requestRef', IDENTIFIER)
        const wait = params.wait ?? 0
        if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > MAX_ANSWER_WAIT_SECONDS) {
          throw invalidError(`wait must be a whole number of seconds from 0 to ${MAX_ANSWER_WAIT_SECONDS}`)
        }
        // What OpenCode's server said to a reply the plugin posted: it settles only an answer this session was handed.
        let report: { requestRef: string; delivered: boolean } | null = null
        if (params.reported !== undefined) {
          const reported = closedParams(params.reported, ['requestRef', 'delivered'])
          if (typeof reported.delivered !== 'boolean') throw invalidError('reported.delivered must be true or false')
          report = { requestRef: requireText(reported, 'requestRef', IDENTIFIER), delivered: reported.delivered }
        }
        return handlers.takeAnswers({
          sessionId: scope.sessionId, incarnationId: scope.incarnationId, waitMs: wait * 1000, report,
          ...(requestRef === undefined ? {} : { requestRef })
        })
      }
      case 'hook.observe': {
        // Observations are diagnostic; the repeat watch may open or withdraw its one notice.
        const params = closedParams(rawParams, ['sessionId', 'agent', 'event', 'source', 'toolName', 'plugin', 'effects', 'fingerprint', 'apiHost', 'model', 'claudeConfigDir',
          'conversation', 'turn', 'nested', 'awayLock'])
        const agent = requireEnum(params, 'agent', HOOK_EVENT_AGENTS)
        const event = requireText(params, 'event', RULES.source)
        if (!isHookEventName(event)) throw invalidError('event must be printable ASCII without spaces')
        const source = readText(params, 'source', RULES.shownSource)
        const toolName = readText(params, 'toolName', RULES.shownSource)
        // Story 96.3: what BMN's OpenCode plugin says it promises; only an OpenCode hook carries it, and an older plugin none.
        const plugin = params.plugin
        if (plugin !== undefined && (agent !== 'opencode' || typeof plugin !== 'number' || !Number.isSafeInteger(plugin) || plugin < 1 || plugin > 999)) {
          throw invalidError('plugin must be a whole number from 1 to 999, from an OpenCode hook')
        }
        const fingerprint = readText(params, 'fingerprint', RULES.source)
        if (fingerprint !== undefined && !/^[0-9a-f]{16}$/.test(fingerprint)) {
          throw invalidError('fingerprint must be 16 lowercase hexadecimal characters')
        }
        // The host is a hostname the CLI parsed, never a URL: no scheme, path, query or credentials
        // may ride along, and a bracketed IPv6 literal is the only form with ':' or '[' in it. The
        // URL parser keeps '_' in names, so it passes here rather than refusing the observation.
        const apiHost = readText(params, 'apiHost', RULES.apiHost)
        if (apiHost !== undefined && !API_HOST_SHAPE.test(apiHost)) {
          throw invalidError('apiHost must be a hostname')
        }
        const model = readText(params, 'model', RULES.model)
        // Where a Claude session's settings live (Story 31.1). An old CLI sends none and still passes.
        const claudeConfigDir = readText(params, 'claudeConfigDir', RULES.path)
        if (claudeConfigDir !== undefined && (agent !== 'claude' || !claudeConfigDir.startsWith('/'))) {
          throw invalidError('claudeConfigDir must be an absolute path from a Claude hook')
        }
        const effects = requireEffects(params, 'effects')
        // Epic 69: which conversation and turn the event belongs to. It moves a turn's record, so only a session's
        // own hook may say it: the owner's token, which may observe for a named session, may not.
        const conversation = readText(params, 'conversation', RULES.conversationReference)
        const turnId = readText(params, 'turn', IDENTIFIER)
        if (conversation === undefined ? turnId !== undefined || params.nested !== undefined
          : !CONVERSATION_REFERENCE.test(conversation) || (turnId !== undefined && !TURN_ID.test(turnId)) ||
            (params.nested !== undefined && params.nested !== true)) {
          throw invalidError('conversation, turn and nested must name a conversation, a turn id and true')
        }
        if (conversation !== undefined && scope.kind !== 'session') throw unauthorized('Only a session may report its own turn')
        // Story 76.4 AC2: the hook holds its conversation's away lock; only then may it be handed the away state.
        if (params.awayLock !== undefined && (params.awayLock !== true || conversation === undefined)) throw invalidError('awayLock must be true, with a conversation')
        const sessionId = this.target(scope, params)
        return handlers.observeHookEvent({
          sessionId,
          incarnationId: incarnationOf(scope),
          agent,
          event,
          source: source ?? null,
          toolName: toolName ?? null,
          ...(plugin === undefined ? {} : { plugin }),
          ...(fingerprint === undefined ? {} : { fingerprint }),
          ...(apiHost === undefined ? {} : { apiHost }),
          ...(model === undefined ? {} : { model }),
          ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }),
          ...(conversation === undefined ? {} : { turn: { conversation: conversation.toLowerCase(), turn: turnId ?? null, nested: params.nested === true } }),
          ...(params.awayLock === true ? { awayLock: true } : {}),
          effects
        })
      }
      case 'usage.report': {
        // Only a session's own status line reports, and only what it read for the run it belongs to.
        const params = closedParams(rawParams, ['sessionId', 'agent', 'windows', 'contextUsedPercent'])
        if (scope.kind !== 'session') throw unauthorized('Only a session credential may report its plan use')
        if (params.agent !== 'claude') throw invalidError('agent must be claude')
        const raw = params.windows
        if (!Array.isArray(raw) || raw.length > MAX_USAGE_WINDOWS) {
          throw invalidError(`windows must be an array of at most ${MAX_USAGE_WINDOWS} windows`)
        }
        const windows = raw.map((item): UsageWindow => {
          const window = closedParams(item, ['minutes', 'usedPercent', 'resetsAt'])
          const minutes = window.minutes
          if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 527_040) {
            throw invalidError('windows[].minutes must be a whole number of minutes')
          }
          const usedPercent = readPercent(window, 'usedPercent')
          const resetsAt = readTimestamp(window, 'resetsAt')
          if (usedPercent === undefined || resetsAt === undefined) throw invalidError('windows[] needs usedPercent and resetsAt')
          return { minutes, usedPercent, resetsAt }
        })
        if (new Set(windows.map((window) => window.minutes)).size !== windows.length) {
          throw invalidError('windows must not repeat a window length')
        }
        const contextUsedPercent = readPercent(params, 'contextUsedPercent') ?? null
        if (windows.length === 0 && contextUsedPercent === null) throw invalidError('a reading needs a window or context use')
        return handlers.reportUsage({
          sessionId: this.target(scope, params),
          incarnationId: scope.incarnationId,
          agent: 'claude',
          windows,
          contextUsedPercent
        })
      }
      case 'guard.report': {
        // Only a session's own prompt hook reports, and only for the run it belongs to.
        const params = closedParams(rawParams, ['sessionId', 'agent', 'outcome', 'cause', 'line', 'allow', 'workspace', 'folder', 'processFolder',
          'providerId', 'providerName', 'agentName', 'host', 'pid', 'start', 'conversation'])
        if (scope.kind !== 'session') throw unauthorized('Only a session credential may report its prompt guard')
        const agent = params.agent
        if (typeof agent !== 'string' || !(GUARD_AGENTS as readonly string[]).includes(agent)) throw invalidError(`agent must be one of ${GUARD_AGENTS.join(', ')}`)
        const outcome = params.outcome
        if (outcome !== 'pass' && outcome !== 'stop') throw invalidError('outcome must be pass or stop')
        const sessionId = this.target(scope, params)
        if (outcome === 'pass') {
          if (Object.keys(params).some((key) => !['sessionId', 'agent', 'outcome'].includes(key))) throw invalidError('a pass carries nothing else')
          return handlers.reportGuard({ sessionId, incarnationId: scope.incarnationId, agent: agent as GuardAgent, outcome })
        }
        const cause = params.cause
        if (typeof cause !== 'string' || !(GUARD_CAUSES as readonly string[]).includes(cause)) throw invalidError(`cause must be one of ${GUARD_CAUSES.join(', ')}`)
        const line = requireText(params, 'line', RULES.guardLine)
        const folderPath = (key: string): string | null => {
          const value = readText(params, key, RULES.path)
          if (value !== undefined && !isAbsolute(value)) throw invalidError(`${key} must be an absolute path`)
          return value ?? null
        }
        const providerId = readText(params, 'providerId', RULES.source) ?? null
        if (providerId !== null && !/^[a-z0-9-]{1,32}$/.test(providerId)) throw invalidError('providerId must match [a-z0-9-]{1,32}')
        const pid = params.pid
        if (pid !== undefined && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2)) throw invalidError('pid must be a process id')
        const start = readText(params, 'start', RULES.source) ?? null
        if (start !== null && !/^\d{1,20}$/.test(start)) throw invalidError('start must be a process start time')
        const conversation = readText(params, 'conversation', RULES.conversationReference) ?? null
        if (conversation !== null && !CONVERSATION_REFERENCE.test(conversation)) throw invalidError('conversation is not a conversation reference')
        const workspace = folderPath('workspace')
        const allow = readBoolean(params, 'allow') ?? false
        // Allow here names a provider and a workspace; a report that offers it without both is not one BMN can act on.
        if (allow && (cause !== 'public-only' || workspace === null || providerId === null || pid === undefined || start === null)) {
          throw invalidError('allow needs a stopped public-only prompt with its provider, workspace and process')
        }
        return handlers.reportGuard({
          sessionId, incarnationId: scope.incarnationId, agent: agent as GuardAgent, outcome, cause: cause as GuardCause, line, allow,
          workspace, folder: folderPath('folder'), processFolder: folderPath('processFolder'), providerId,
          providerName: readText(params, 'providerName', RULES.label) ?? null,
          agentName: readText(params, 'agentName', RULES.label) ?? null,
          host: readText(params, 'host', RULES.apiHost) ?? null,
          pid: pid ?? null, start, conversation
        })
      }
      case 'input.submit': {
        const params = closedParams(rawParams, ['sessionId', 'text', 'submit', 'idempotencyKey'])
        const text = requireText(params, 'text', RULES.text)
        const submit = readBoolean(params, 'submit') ?? false
        if (text.length === 0 && !submit) throw invalidError('text is empty and submit is false')
        const idempotencyKey = requireText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        return this.idempotent(scope, method, idempotencyKey, params, async () => {
          await handlers.submitInput({ sessionId, text, submit })
          return { ok: true }
        })
      }
      case 'resume.report': {
        const params = closedParams(rawParams, ['sessionId', 'argv', 'idempotencyKey'])
        if (scope.kind !== 'session') throw unauthorized('Only a program in the session may report how to resume it')
        const problem = reportedResumeArgvProblem(params.argv)
        if (problem !== null) throw invalidError(problem)
        const argv = params.argv as string[]
        readText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        // No receipt: a report only replaces the process's own command, so repeating one is harmless, while a
        // receipt would answer a later report with the same key (after a clear, or another report) and store nothing.
        return handlers.reportResumeCommand({ sessionId, incarnationId: scope.incarnationId, argv })
      }
      case 'resume.clear': {
        const params = closedParams(rawParams, ['sessionId', 'idempotencyKey'])
        if (scope.kind !== 'session') throw unauthorized('Only a program in the session may clear how to resume it')
        readText(params, 'idempotencyKey', RULES.idempotencyKey)
        const sessionId = this.target(scope, params)
        return handlers.clearResumeCommand({ sessionId, incarnationId: scope.incarnationId })
      }
      case 'decision.record': {
        const params = closedParams(rawParams, ['key', 'revision', 'choice', 'reason', 'affects', 'reverse', 'references', 'depends'])
        if (scope.kind !== 'session') throw unauthorized('Only a session\'s agent records a decision it made')
        const key = decisionKey(requireText(params, 'key', IDENTIFIER), 'key')
        const revision = params.revision
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw invalidError('revision must be the away revision you saw (bmn away --status)')
        const references = readIdentifiers(params, 'references', DECISION_LIMITS.references).map((text) => {
          const at = text.indexOf(':')
          const kind = text.slice(0, at) as DecisionReferenceKind
          const id = text.slice(at + 1)
          if (at < 1 || !DECISION_REFERENCE_KINDS.includes(kind) || id === '') throw invalidError('a reference is KIND:ID with KIND one of session, artifact, workflow')
          return { kind, id }
        })
        const depends = readIdentifiers(params, 'depends', DECISION_LIMITS.depends).map((text) => decisionKey(text, 'depends'))
        return handlers.recordDecision({
          sessionId: scope.sessionId, incarnationId: incarnationOf(scope), key, revision: revision as number,
          payload: {
            choice: requireText(params, 'choice', RULES.decisionChoice), reason: requireText(params, 'reason', RULES.decisionReason),
            affects: requireText(params, 'affects', RULES.decisionAffects), reverse: requireText(params, 'reverse', RULES.decisionReverse),
            references, depends
          }
        })
      }
      case 'decision.outcome': {
        const params = closedParams(rawParams, ['key', 'op', 'result', 'evidenceIds'])
        if (scope.kind !== 'session') throw unauthorized('Only the session that recorded a decision reports its outcome')
        const result = params.result
        if (result !== 'done' && result !== 'failed') throw invalidError('result must be done or failed')
        return handlers.decisionOutcome({
          sessionId: scope.sessionId, key: decisionKey(requireText(params, 'key', IDENTIFIER), 'key'),
          op: decisionKey(requireText(params, 'op', IDENTIFIER), 'op'), result,
          evidence: readIdentifiers(params, 'evidenceIds', DECISION_LIMITS.evidence)
        })
      }
      case 'away.printed': {
        const params = closedParams(rawParams, ['agent', 'conversation', 'revision', 'claimId'])
        if (scope.kind !== 'session') throw unauthorized('Only a session\'s hook reports what it printed')
        const agent = requireEnum(params, 'agent', HOOK_EVENT_AGENTS)
        const conversation = requireText(params, 'conversation', RULES.conversationReference)
        if (!CONVERSATION_REFERENCE.test(conversation)) throw invalidError('conversation must name a conversation')
        const revision = params.revision
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw invalidError('revision must be a whole number')
        const claimId = requireText(params, 'claimId', IDENTIFIER)
        return handlers.awayPrinted({ sessionId: scope.sessionId, agent, conversation: conversation.toLowerCase(), revision: revision as number, claimId })
      }
      case 'away.status': {
        closedParams(rawParams, [])
        return handlers.awayStatus(scope)
      }
      case 'policy.status': {
        closedParams(rawParams, [])
        return handlers.policyStatus()
      }
      // Story 83.3: the push policy changes only in Health, by the owner's own hand; no caller of the socket writes it.
      case 'policy.set':
        throw unauthorized('Only the owner changes the push policy, in BMN Health')
      case 'away.set': {
        const params = closedParams(rawParams, ['to', 'note', 'revision', 'idempotencyKey'])
        const to = params.to
        if (to === 'leaving') {
          // Story 84.3: his departure words start a departure; no note, and an agent names the revision it saw, as for away.
          if (params.note !== undefined) throw invalidError('A note goes with away, not leaving')
          const revision = params.revision
          if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0)) throw invalidError('revision must be a whole number')
          if (scope.kind === 'session' && revision === undefined) throw invalidError('An agent names the away revision it saw (bmn away --status)')
          readText(params, 'idempotencyKey', RULES.idempotencyKey)
          return handlers.leaveAway({ scope, ...(revision === undefined ? {} : { expectedRevision: revision as number }) })
        }
        if (to !== 'away' && to !== 'back') throw invalidError('to must be away, back or leaving')
        const note = params.note === undefined || params.note === null ? params.note : readText(params, 'note', RULES.awayNote)
        const revision = params.revision
        if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0)) throw invalidError('revision must be a whole number')
        // An agent says it only on the owner's words, against the state it saw: a stale revision changes nothing.
        if (scope.kind === 'session' && revision === undefined) throw invalidError('An agent names the away revision it saw (bmn away --status)')
        // The note comes only from the owner's own hands (Story 76.1, Fable's question 1).
        // Clearing it is setting it: an agent sends no note field at all, null included (Astra's review).
        if (scope.kind === 'session' && note !== undefined) throw invalidError('Only the owner sets a note; say away without one')
        const operationKey = readText(params, 'idempotencyKey', RULES.idempotencyKey)
        return handlers.changeAway({
          scope, to,
          ...(note === undefined ? {} : { note: note as string | null }),
          ...(revision === undefined ? {} : { expectedRevision: revision as number }),
          ...(operationKey === undefined ? {} : { operationKey: `${scopeKey(scope)}|${operationKey}` })
        })
      }
      case 'grant.ask': {
        const params = closedParams(rawParams, ['runId', 'card', 'idempotencyKey'])
        const runId = grantIdentifier(params.runId, GRANT_LIMITS.runId)
        if (runId === null) throw invalidError(`runId must be your run's id: letters, digits and . _ : / - (at most ${GRANT_LIMITS.runId})`)
        const parsed = parseGrantCardInput(params.card)
        if ('problem' in parsed) throw invalidError(`Nothing was asked: ${parsed.problem}`)
        const operationKey = readText(params, 'idempotencyKey', RULES.idempotencyKey)
        return handlers.askGrant({ scope, runId, card: parsed.card, ...(operationKey === undefined ? {} : { operationKey: `${scopeKey(scope)}|${operationKey}` }) })
      }
      case 'grant.status': {
        const params = closedParams(rawParams, ['runId'])
        if (params.runId === undefined) return handlers.grantStatus({ scope })
        const runId = grantIdentifier(params.runId, GRANT_LIMITS.runId)
        if (runId === null) throw invalidError(`runId must be a run's id (at most ${GRANT_LIMITS.runId})`)
        return handlers.grantStatus({ scope, runId })
      }
      case 'grant.use': {
        const params = closedParams(rawParams, ['runId', 'useId', 'boundary', 'item'])
        if (scope.kind !== 'session') throw unauthorized('Only a session\'s agent records a use of its run\'s grant')
        const runId = grantIdentifier(params.runId, GRANT_LIMITS.runId)
        const useId = grantIdentifier(params.useId, GRANT_LIMITS.useId)
        if (runId === null || useId === null) throw invalidError('runId and useId are identifiers: letters, digits and . _ : / -')
        const boundary = params.boundary === undefined ? undefined : grantIdentifier(params.boundary, GRANT_LIMITS.boundary)
        const item = params.item === undefined ? undefined : grantIdentifier(params.item, GRANT_LIMITS.itemId)
        if (boundary === null || item === null || (boundary === undefined) === (item === undefined)) throw invalidError('A use names either one boundary (a round) or one item')
        return handlers.useGrant({ sessionId: scope.sessionId, runId, useId, ...(boundary === undefined ? {} : { boundary }), ...(item === undefined ? {} : { item }) })
      }
      case 'grant.report': {
        // Story 84.7: what the agent saw happen, kept apart from BMN's record for the morning; it grants nothing.
        const params = closedParams(rawParams, ['runId', 'periodId', 'useId', 'result', 'boundary', 'stepBack', 'item', 'text'])
        if (scope.kind !== 'session') throw unauthorized('Only a session\'s agent reports a step of its run')
        const runId = grantIdentifier(params.runId, GRANT_LIMITS.runId)
        if (runId === null) throw invalidError('runId is an identifier: letters, digits and . _ : / -')
        const sessionId = scope.sessionId
        const text = (required: boolean): string | null => {
          const read = grantReportText(params.text, required)
          if ('problem' in read) throw invalidError(read.problem)
          return read.text
        }
        if (params.useId !== undefined) {
          const useId = grantIdentifier(params.useId, GRANT_LIMITS.useId)
          if (useId === null || params.stepBack !== undefined || params.boundary !== undefined || params.item !== undefined) throw invalidError('An outcome names one use id and its result')
          // The departure the use was recorded in, as `grant use` returned it: a use id may come again in a later one.
          const periodId = grantIdentifier(params.periodId, GRANT_LIMITS.periodId)
          if (periodId === null) throw invalidError('An outcome names the period its use was recorded in (periodId, as grant use returned it)')
          const result = params.result
          if (![...GRANT_ROUND_RESULTS, ...GRANT_ACTION_RESULTS].includes(result as GrantReportResult)) throw invalidError('result is passed, failed or blocked for a round; done, uncertain or refused for an action')
          return handlers.reportGrant({ runId, sessionId, kind: 'outcome', periodId, useId, result: result as GrantReportResult, text: text(result === 'refused') })
        }
        if (params.result !== undefined || params.periodId !== undefined) throw invalidError('A result and its period go with --use-id')
        if (params.stepBack === true) {
          const boundary = grantIdentifier(params.boundary, GRANT_LIMITS.boundary)
          if (boundary === null || params.item !== undefined) throw invalidError('A step back names its boundary')
          return handlers.reportGrant({ runId, sessionId, kind: 'step-back', boundary, text: text(true) as string })
        }
        const item = grantIdentifier(params.item, GRANT_LIMITS.itemId)
        if (item === null || params.boundary !== undefined || params.stepBack !== undefined) throw invalidError('A report names a use id, a step back at a boundary, or a refused item')
        return handlers.reportGrant({ runId, sessionId, kind: 'refused', item, text: text(true) as string })
      }
      // Story 84.3 AC3: only the owner answers a card, in the window or on Telegram; no token reaching this socket can,
      // the owner's CLI token included, since agents can read it (the reason Telegram answers stay in-process, 8ee22dd).
      case 'grant.answer':
        throw unauthorized('Only the owner answers a grant card, in the BMN window or on Telegram')
      default:
        throw invalidError(`Unknown method: ${method.slice(0, 64)}`)
    }
  }

  /**
   * Receipts make retries safe: a staged receipt means an earlier delivery may have happened before a crash,
   * so it is reported as uncertain and never repeated.
   */
  private async idempotent(
    scope: ControlScope,
    method: string,
    idempotencyKey: string | undefined,
    params: Params,
    run: () => Promise<unknown>
  ): Promise<unknown> {
    if (idempotencyKey === undefined) return run()
    const key = `${scopeKey(scope)}|${method}|${idempotencyKey}`
    const hash = paramsHash(params)
    return this.withReceiptLock(key, async () => {
      const { receipts } = this.options
      const existing = await receipts.get(key)
      if (existing !== undefined) {
        if (existing.paramsHash !== hash) {
          throw new ControlError(ERROR_CODES.revisionConflict, 'idempotency key reused with different parameters')
        }
        return replayed(existing)
      }
      await receipts.put({ key, paramsHash: hash, state: 'staged' })
      let result: unknown
      try {
        result = await run()
      } catch (error) {
        const controlError = this.toControlError(error)
        const message = this.redact(controlError.message)
        // A lost failure record leaves the receipt staged: later replays report 'uncertain', never re-run.
        await receipts
          .put({ key, paramsHash: hash, state: 'failed', error: { code: controlError.code, message } })
          .catch(() => undefined)
        throw new ControlError(controlError.code, message, controlError.retryable)
      }
      // The effect already happened; a lost done record degrades replays to 'uncertain', never a second delivery.
      await receipts.put({ key, paramsHash: hash, state: 'done', result }).catch(() => undefined)
      return result
    })
  }

  private async withReceiptLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.receiptLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = previous.then(() => current)
    this.receiptLocks.set(key, chained)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.receiptLocks.get(key) === chained) this.receiptLocks.delete(key)
    }
  }
}
