// MODULE: agents-check.d.mts - types for the Epic 60.3 dispatch check so the main process and tests can import it
import type { AgentClass, PrivateWork, RosterAgent, RosterData } from './agents-roster.mjs'
export interface CheckInputs {
  agent: string
  role: string
  workspace: string
  data: 'private' | 'public'
  argv: string[]
  cwd?: string | undefined
  stdin?: string | undefined
  packet?: string | undefined
  resumeOf?: string | undefined
}
export interface ResearchInputs {
  agent: string
  argv: string[]
  /** The prompt file; not read by a dry check. */
  stdin?: string | undefined
  cwd?: string | undefined
  /** Ask only whether this agent could research with this argv: no folder, no prompt, no receipt. */
  dry?: boolean
  /** A receipt checked again after its run: the run's own Codex folder is gone by then. */
  settled?: boolean
}
/** One model's result in a fence test (63.3). */
export interface FenceTestModel { model: string; verdict: 'pass' | 'fail' | 'inconclusive'; tools: string[]; reasons: string[]; seconds?: number; catalog_entry?: string }
/** One recorded fence test: `form` names the research form it tested, `catalog` the model list it ran under. */
export interface FenceTestEntry {
  harness: string; at: string; version: string | null; form: string; catalog: 'bundled' | 'live'; verdict: 'pass' | 'fail' | 'inconclusive'
  models: FenceTestModel[]; reasons?: string[]; seconds?: number; renewal?: 'through-link' | 'not-asked' | 'link-replaced' | 'not-written'
  /** Set on what a stopped test returns; such a test is never recorded. */
  stopped?: boolean
  /** Set on what a test cut short by its caller's time limit returns; such a test is never recorded. */
  expired?: boolean
}
export interface FenceStanding {
  passed: boolean; why?: 'untested' | 'failed' | 'live'; tools: string[]; at?: string; reasons?: string[]
  /** The last comparison under the provider's own model list, or null where none was made. */
  live: { at: string; same: boolean; entry: string | null } | null
}
export interface PrivateWorkReceipt { answer: PrivateWork; allowed: boolean; exception?: { id: string; scope: 'this workspace' } }
export interface ReceiptRoute { provider: string | null; host: string; basis: string; sources: string[]; harness_provider: string | null }
interface ReceiptBase {
  version: 1
  verdict: 'PASS'
  agent: string
  class: AgentClass
  harness: string
  model: string
  effort: string
  context_limit_applied: number | null
  /** Why the agent's own limit is not applied to this run; absent where it is applied or the agent has none. */
  context_limit_note?: string
  /**
   * What the check saw of a run for a read-only role (63.2): Codex's sandbox and approvals with the sources that
   * named them, or Claude Code's tool list. Absent for a role that may write.
   */
  sandbox?: { mode: 'read-only'; source: string; approval_policy?: 'never'; approval_source?: string; tools?: string[]; agent_sha256?: string; form_tested_on?: string }
  /** The tools this run was given and a hash of their definitions; absent when it was given none. */
  /** The tools the run was kept to, with a hash of their definitions; or `checked: false` for a run whose tools BMN did not judge (Codex) while the team lists tools. */
  tools?: { applied: string[]; sha256: string; checked?: undefined } | { checked: false; applied?: undefined; sha256?: undefined }
  cwd: string
  argv_sha256: string
  harness_version: { version: string | null; state: string }
  route: ReceiptRoute
  private_work: PrivateWorkReceipt
  generation: { number: number; hash: string }
  roster_file_hash: string | null
  stdin?: { path: string; sha256: string }
  issued_at: string
  receipt_hash: string
}
export interface CheckReceipt extends ReceiptBase {
  mode: 'dispatch'
  role: string
  workspace: string
  public_status: { public: boolean; reason: string; commit?: string }
  data: 'public' | 'private'
  resume?: { session_id: string; original_receipt_hash: string; original_receipt: string }
  packet?: { path: string; manifest: { name: string; sha256: string }[]; prompt: string }
}
export interface ResearchReceipt extends ReceiptBase { mode: 'research'; stdin: { path: string; sha256: string } }
interface Refused { verdict: 'REFUSED'; code: string; message: string; next: string; steps: string[]; receipt?: undefined; note?: undefined
  /** The reason within the code where a caller words it for the owner: for CONTEXT_MISMATCH, checkContext's `why`. */
  detail?: string }
export type CheckResult = {
  verdict: 'PASS'; receipt: CheckReceipt; steps: string[]
  /** One more line said beside the PASS, never part of the receipt (64.2 AC2). */
  note?: string
  code?: undefined; message?: undefined; next?: undefined
} | Refused
export type ResearchResult =
  | { verdict: 'PASS'; receipt: ResearchReceipt; steps: string[]; dry?: undefined; version?: undefined; code?: undefined; message?: undefined; next?: undefined; detail?: undefined }
  | { verdict: 'PASS'; dry: true; version: string | null; steps: string[]; fence?: { tools: string[]; compared: boolean }; receipt?: undefined; code?: undefined; message?: undefined; next?: undefined; detail?: undefined }
  | Refused
type Environment = NodeJS.ProcessEnv | Record<string, string>
export interface CheckOptions {
  environment?: Environment
  cwd?: string
  publicRules?: string | null | (() => string | null)
  now?: Date
  testedVersions?: Record<string, string[]>
  resumeVersions?: Record<string, string[]>
  /** The recorded context-setting tests; the tests' seam for 60.9 AC1. */
  contextTestLog?: import('./agents-context.mjs').ContextTestEntry[]
  /** The recorded tools tests; the tests' seam for 60.12 AC5. */
  toolsTestLog?: import('./agents-tools.mjs').ToolsTestEntry[]
  /** The tests' seam for where an organisation's policy files for Claude Code would be. */
  toolsPolicyRoot?: string
}
export interface ResearchOptions { environment?: Environment; cwd?: string; now?: Date; testedVersions?: Record<string, string[]>; fenceVersions?: Record<string, string[]>; contextTestLog?: import('./agents-context.mjs').ContextTestEntry[]
  /** The recorded fence tests; the tests' seam for 63.3. */
  fenceTestLog?: FenceTestEntry[] }
export interface VisibilityRecord {
  version: 1
  workspace: string
  checked_at: string
  origin: string | null
  repository_id?: number
  visibility: 'public' | 'private'
  default_branch?: string
  commit?: string
  reason?: string
}
export type WorkspaceVisibility = { public: true; reason: string; record: VisibilityRecord & { commit: string } } | { public: false; reason: string; record?: VisibilityRecord }
export interface Destination {
  known: boolean
  reason?: string
  default?: boolean
  provider?: string | null
  host?: string
  basis?: string
  harness_provider?: string | null
  unapproved?: string
}
export interface ResearchRun { id: string; folder: string; prompt: string; cwd: string; /** The run's own Codex folder, for a Codex run. */ codex?: string }
export declare const REFUSALS: string[]
export declare const TESTED_HARNESS_VERSIONS: Record<string, string[]>
export declare function versionStanding(harness: string, version: string | null, tested?: Record<string, string[]>): { tested: boolean; state: 'tested' | 'newer than BMN tested' | 'not a version BMN tested' | 'version unreadable' }
export declare const RESUME_TESTED_VERSIONS: Record<string, string[]>
export declare const RESEARCH_FENCE_VERSIONS: Record<string, string[]>
export declare const RESEARCH_TOOLS: string
export declare const WEB_QUESTION_COMMAND: string
export declare const WEB_NEXT_STEP: string
export declare const OPENCODE_NEXT_STEP: string
export declare const OPENCODE_RESEARCH_TOOLS_SEEN: string[]
export declare const WEB_TOOLS_NOTE: string
export declare const CODEX_RESEARCH_CONFIG: string[]
export declare const CODEX_RESEARCH_ANSWER: string
export declare const CODEX_RESEARCH_DISABLED: string[]
export declare const CODEX_RESEARCH_HOME: string
export declare const CODEX_SIGN_IN: string
/** The tools Codex keeps offering under the research form, each looked at; any other fails the fence test. */
export declare const CODEX_RESEARCH_TOOLS_SEEN: string[]
export declare function researchFormHash(harness: string): string
export declare function researchFormProblem(parsed: Record<string, unknown>): string | null
export declare function codexSignInFile(environment?: Environment): string
export declare function removeResearchCodexFolders(only?: { folder: string } | null): void
export declare function fenceTestsPath(): string
export declare function fenceTests(): FenceTestEntry[]
export declare function fenceStanding(harness: string, version: string | null, model: string, tests?: FenceTestEntry[]): FenceStanding
export declare const VISIBILITY_MAX_AGE_MS: number
export declare const BINDING_WINDOW_MS: number
export declare function setReadTracer(tracer: ((path: string) => void) | null): void
export declare function parseDispatch(argv: string[], options?: { research?: boolean }): Record<string, unknown>
export declare function readCodexConfig(text: string | null): { top: Record<string, string>; profiles: Record<string, Record<string, string>>; providers: Record<string, Record<string, unknown>>; unreadable: string[]
  context: { top: Record<string, number>; profiles: Record<string, Record<string, number>>; unreadable: string | null }
  /** What a run may do, as the file says it: `sandbox_mode` and `approval_policy`, at the top and per profile. */
  access: { top: Record<string, string>; profiles: Record<string, Record<string, string>>; unreadable: string | null } }
export declare function evaluate(inputs: CheckInputs, options?: CheckOptions): CheckResult
export declare function evaluateResearch(inputs: ResearchInputs, options?: ResearchOptions): ResearchResult
/** One input of an ask with the folder it comes from: a folder exception counts only inside it (R72-NFR6). */
export interface AskInput { kind: 'question' | 'file' | 'project' | 'picture'; label: string; root: string | null; relative?: string; sha256?: string; public_commit?: string | null }
export interface AskConsent { kind: AskInput['kind']; label: string; root: string | null; basis: string }
export interface AskInputs { agent: string; role: string; effort: string; access: 'question' | 'files' | 'project'; data: 'private' | 'public'; wide?: boolean; run: string; argv: string[] }
export interface AskReceipt extends Omit<ReceiptBase, 'cwd'> {
  mode: 'ask'; role: string; access: 'question' | 'files' | 'project'; form: string; pictures?: number
  run: string; data: 'public' | 'private'; consent: AskConsent[]; inputs_sha256: string
  snapshots: { config: string; executable: { launcher: string; payload: string }; environment: string; rules: string | null; prompt: string }
  harness_version: { version: string | null; state: string; form: 'proven' }
}
export type AskResult = { verdict: 'PASS'; receipt: AskReceipt; steps: string[]; argv: string[]; code?: undefined; message?: undefined; next?: undefined; detail?: undefined } | (Refused & { argv?: undefined })
export interface AskRequest { access: string; model: string; effort: string; rules: string | null; pictures: string[]; context: { argv: string[]; env: string[] } }
export declare function teamRunsDirectory(): string
export declare function askStandingWords(harness: string, version: string | null, mode: string): string | null
export declare function askConsent(data: RosterData, destination: { provider: string | null; basis: string }, inputs: AskInput[], label: 'private' | 'public', now?: Date, note?: (text: string) => void): AskConsent[]
export declare function expectedDestination(data: RosterData, agent: RosterAgent): { provider: string; basis: string }
export declare function askRequest(agent: RosterAgent, version: string | null, request: { access: string; effort: string; rules?: string | null; pictures?: string[]; contextTestLog?: import('./agents-context.mjs').ContextTestEntry[] }): AskRequest
export declare function evaluateAsk(inputs: AskInputs, options?: { environment?: Environment; now?: Date; testedVersions?: Record<string, string[]>; contextTestLog?: import('./agents-context.mjs').ContextTestEntry[]; program?: { launcher: string; payload: string; root: string; paths: string[] }; version?: string | null }): AskResult
export declare function verifyReceipt(path: string, argv: string[], options?: CheckOptions): { ok: boolean; reason?: string }
export declare function workspaceRoot(directory: string): string
export declare function sessionRecord(codexHome: string | null, id: string): { id?: unknown; cwd?: unknown; provider?: unknown; cli_version?: unknown } | null
export declare function sessionRecordFiles(codexHome: string | null, id: string): string[]
export declare function sessionRecordAt(path: string): { id?: unknown; cwd?: unknown; provider?: unknown; cli_version?: unknown } | null
export declare function workspaceOrigin(workspace: string): { origin: string; reason?: undefined } | { reason: string; origin?: undefined }
export declare function normalizedGithubOrigin(url: string): string | null
export declare function visibilityDirectory(): string
export declare function visibilityPath(workspace: string): string
export declare function workspaceVisibility(workspace: string, now?: Date): WorkspaceVisibility
export declare function refreshVisibility(workspace: string, options?: { now?: Date; api?: string; request?: typeof fetch; timeoutMs?: number }): Promise<VisibilityRecord>
export declare function destinationOf(data: RosterData, harness: string, route: Record<string, unknown>): Destination
export declare function privateWorkAnswer(data: RosterData, destination: Destination, root: string | null): { allowed: boolean; answer: PrivateWork; reason: string; exception?: { id: string; scope: 'this workspace' } }
export declare function publicOnlyReasons(agent: RosterAgent, data: RosterData): string[]
export declare function bindingPath(receiptHash: string): string
export declare function bindSession(receiptFile: string, sessionId: string, options?: { now?: Date }): { receipt_hash: string; session_id: string }
export declare function researchRunsDirectory(): string
export declare function prepareResearchRun(prompt: string, options?: { now?: Date; id?: string; harness?: string; environment?: Environment }): ResearchRun
export declare function inspectRoute(agent: RosterAgent, argv: string[] | null, environment: NodeJS.ProcessEnv, cwd: string, data?: RosterData | null): Record<string, unknown>
export declare function harnessVersion(command: string, environment: Environment): string | null
export declare function contextTestSources(harness: string, environment: Environment, folder: string): import('./agents-context.mjs').ContextSource[]
export declare function limitStanding(agent: RosterAgent, version: string | null, options?: { environment?: Environment; cwd?: string; tests?: import('./agents-context.mjs').ContextTestEntry[]; auto?: boolean }):
  { state: 'applied' } | { state: 'not-applied' | 'refused'; reason: string } | null
export declare function receiptHash(body: Record<string, unknown>): string
export declare function runCheckCommand(action: string, argv: string[]): Promise<number>
export declare function consequences(before: RosterData | null, after: RosterData): string[]
/** The Claude Code tools that cannot change a file: the only ones a run for a read-only role may be given. */
export declare const CLAUDE_READ_ONLY_TOOLS: string[]
/** The write-attempt test that showed the Claude Code form, and the version it ran on. */
export declare const CLAUDE_READ_ONLY_TESTED: { version: string; on: string }
/** What a command for a read-only role must carry, per app. */
export declare const READ_ONLY_ITEMS: { codex: string[]; claude: string[] }
