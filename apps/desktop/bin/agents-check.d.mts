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
  stdin: string
  cwd?: string | undefined
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
interface Refused { verdict: 'REFUSED'; code: string; message: string; next: string; steps: string[]; receipt?: undefined }
export type CheckResult = { verdict: 'PASS'; receipt: CheckReceipt; steps: string[]; code?: undefined; message?: undefined; next?: undefined } | Refused
export type ResearchResult = { verdict: 'PASS'; receipt: ResearchReceipt; steps: string[]; code?: undefined; message?: undefined; next?: undefined } | Refused
type Environment = NodeJS.ProcessEnv | Record<string, string>
export interface CheckOptions {
  environment?: Environment
  cwd?: string
  publicRules?: string | null | (() => string | null)
  now?: Date
  testedVersions?: Record<string, string[]>
  resumeVersions?: Record<string, string[]>
}
export interface ResearchOptions { environment?: Environment; cwd?: string; now?: Date; testedVersions?: Record<string, string[]>; fenceVersions?: Record<string, string[]> }
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
export interface ResearchRun { id: string; folder: string; prompt: string; cwd: string }
export declare const REFUSALS: string[]
export declare const TESTED_HARNESS_VERSIONS: Record<string, string[]>
export declare function versionStanding(harness: string, version: string | null, tested?: Record<string, string[]>): { tested: boolean; state: 'tested' | 'newer than BMN tested' | 'not a version BMN tested' | 'version unreadable' }
export declare const RESUME_TESTED_VERSIONS: Record<string, string[]>
export declare const RESEARCH_FENCE_VERSIONS: Record<string, string[]>
export declare const RESEARCH_TOOLS: string
export declare const VISIBILITY_MAX_AGE_MS: number
export declare const BINDING_WINDOW_MS: number
export declare function setReadTracer(tracer: ((path: string) => void) | null): void
export declare function parseDispatch(argv: string[]): Record<string, unknown>
export declare function readCodexConfig(text: string | null): { top: Record<string, string>; profiles: Record<string, Record<string, string>>; providers: Record<string, Record<string, unknown>>; unreadable: string[] }
export declare function evaluate(inputs: CheckInputs, options?: CheckOptions): CheckResult
export declare function evaluateResearch(inputs: ResearchInputs, options?: ResearchOptions): ResearchResult
export declare function verifyReceipt(path: string, argv: string[], options?: CheckOptions): { ok: boolean; reason?: string }
export declare function workspaceRoot(directory: string): string
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
export declare function prepareResearchRun(prompt: string, options?: { now?: Date; id?: string }): ResearchRun
export declare function inspectRoute(agent: RosterAgent, argv: string[] | null, environment: NodeJS.ProcessEnv, cwd: string, data?: RosterData | null): Record<string, unknown>
export declare function harnessVersion(command: string, environment: Environment): string | null
export declare function receiptHash(body: Record<string, unknown>): string
export declare function runCheckCommand(action: string, argv: string[]): Promise<number>
export declare function consequences(before: RosterData | null, after: RosterData): string[]
