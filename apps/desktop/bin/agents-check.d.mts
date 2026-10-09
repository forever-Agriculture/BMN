// MODULE: agents-check.d.mts - types for the Epic 60.3 dispatch check so the main process and tests can import it
import type { RosterAgent, RosterData } from './agents-roster.mjs'
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
export interface CheckReceipt {
  version: 1
  verdict: 'PASS'
  agent: string
  harness: string
  model: string
  role: string
  effort: string
  workspace: string
  cwd: string
  label: { value: 'public' | 'private'; source: 'explicit' | 'inherited' | 'default' }
  data: 'public' | 'private'
  security: 'high' | 'low'
  argv_sha256: string
  harness_version: { version: string | null; state: string }
  route: { provider: string; host: string; basis: string; sources: string[] }
  generation: { number: number; hash: string }
  roster_file_hash: string | null
  resume?: { session_id: string; original_receipt_hash: string; original_receipt: string }
  packet?: { path: string; manifest: { name: string; sha256: string }[]; prompt: string }
  stdin?: { path: string; sha256: string }
  issued_at: string
  receipt_hash: string
}
export type CheckResult =
  | { verdict: 'PASS'; receipt: CheckReceipt; steps: string[]; code?: undefined; message?: undefined; next?: undefined }
  | { verdict: 'REFUSED'; code: string; message: string; next: string; steps: string[]; receipt?: undefined }
export interface CheckOptions { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; restrictedRules?: string | null | (() => string | null); now?: Date }
export declare const REFUSALS: string[]
export declare const TESTED_HARNESS_VERSIONS: Record<string, string[]>
export declare function setReadTracer(tracer: ((path: string) => void) | null): void
export declare function parseDispatch(argv: string[]): Record<string, unknown>
export declare function readCodexConfig(text: string | null): { top: Record<string, string>; profiles: Record<string, Record<string, string>>; providers: Record<string, Record<string, unknown>>; unreadable: string[] }
export declare function evaluate(inputs: CheckInputs, options?: CheckOptions): CheckResult
export declare function verifyReceipt(path: string, argv: string[], options?: CheckOptions): { ok: boolean; reason?: string }
export declare function labelFor(workspace: string, labels: RosterData['data_labels']): { label: 'public' | 'private'; source: 'explicit' | 'inherited' | 'default'; path?: string }
export declare function inspectRoute(agent: RosterAgent, argv: string[] | null, environment: NodeJS.ProcessEnv, cwd: string): Record<string, unknown>
export declare function harnessVersion(command: string, environment: NodeJS.ProcessEnv): string | null
export declare function receiptHash(body: Record<string, unknown>): string
export declare function runCheckCommand(action: string, argv: string[]): Promise<number>
