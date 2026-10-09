// MODULE: agents-rules.d.mts - types for the Epic 60.4 rules module so the main process and tests can import it
import type { Generation } from './agents-state.mjs'
import type { PathState } from './safe-config-write.mjs'
export type RulesHarness = 'claude' | 'codex' | 'opencode' | 'cursor'
export interface MasterIssue { code: string; line: number; message: string }
export interface Master { path: string; text: string; hash: string; parts: { kind: string; [key: string]: unknown }[] }
export interface Rendering { harness: RulesHarness; text: string; hash: string; restricted: boolean; reason: string; team_form: string; bytes: number }
export interface TargetCheck {
  harness: RulesHarness
  path: string
  state: 'unreadable' | 'missing' | 'link' | 'unmanaged' | 'edited-outside' | 'stale' | 'current'
  restricted: boolean
  reason: string
  rendered_hash: string
  link_target?: string
  detail?: string
}
export interface InstallResult { code: string; transaction: string | null; written: { harness: RulesHarness; path: string; restricted: boolean }[]; message?: string }
export interface ProbeEntry { harness: RulesHarness; at: string; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; version: string | null; host?: string | null; route: string; rendered_hash: string; master_hash: string }
export declare const TEAM_LIMIT_BYTES: number
export declare function masterPath(): string
export declare function targetPath(harness: RulesHarness, environment?: NodeJS.ProcessEnv | Record<string, string>): string
export declare function parseMaster(text: string): { parts: Master['parts']; errors: MasterIssue[] }
export declare function readMaster(path?: string): Master
export declare function teamExpansion(generation: Generation | null): { form: string; text: string }
export declare function routeFor(harness: RulesHarness, generation: Generation | null): { restricted: boolean; reason: string; route: unknown }
export declare function render(master: Master, harness: RulesHarness, generation: Generation | null, options?: { restricted?: boolean | null }): Rendering
export declare function restrictedRendering(harness: RulesHarness): string
export declare function lastWritten(): Record<string, string>
export declare function checkTargets(environment?: NodeJS.ProcessEnv | Record<string, string>): TargetCheck[]
export declare function installRules(harnesses: RulesHarness[], options?: { yes?: boolean; asJson?: boolean; environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; afterConfirm?: () => void; beforeTarget?: (harness: RulesHarness, index: number) => void; expectedPlanHash?: string }): Promise<InstallResult>
export declare function planInstall(harnesses: RulesHarness[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<{ code: string; message?: string; planHash: string | null; plans: unknown[] }>
export declare function planView(result: Awaited<ReturnType<typeof planInstall>>): { code: string; message?: string; plan_hash: string | null; targets: { harness: RulesHarness; path: string; kind: string; restricted: boolean; reason: string; team_form: string; link_target?: string; diff: string; fold: string[] }[] }
export declare function listTransactions(): { id: string; valid: boolean; created_at?: string; state?: string; targets?: RulesHarness[] }[]
export declare function restoreTransaction(id: string, options?: { yes?: boolean; asJson?: boolean; planOnly?: boolean; expectedPlanHash?: string }): Promise<{ code: string; restored?: RulesHarness[]; message?: string; plan_hash?: string; targets?: { harness: RulesHarness; path: string; becomes: string; diff: string }[] }>
export declare function masterHistory(): { revision: number; hash: string; bytes: number; at: string; reason: string; intact: boolean }[]
export declare function writeMaster(expected: PathState, text: string, reason: string, options?: { now?: Date }): PathState
export declare function revertMaster(revision: number, options?: { yes?: boolean; asJson?: boolean }): Promise<{ code: string; revision?: number }>
export declare function importedMaster(sourceText: string, opencodeText: string | null): string
export type ProbeInspector = (harness: RulesHarness) => { version: string | null; host: string | null }
export declare function probeInspector(environment?: NodeJS.ProcessEnv | Record<string, string>): Promise<ProbeInspector>
export declare function beforeFirstToolCall(rollout: string): string
export declare function lastProbes(options?: { inspect?: ProbeInspector }): (Partial<ProbeEntry> & { harness: RulesHarness; outcome: ProbeEntry['outcome'] | null; stale?: boolean })[]
export declare function probe(harness: RulesHarness, options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; timeoutMs?: number }): Promise<ProbeEntry>
export declare const RULES_USAGE: string
export declare function runRulesCommand(argv: string[]): Promise<number>
