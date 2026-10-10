// MODULE: agents-rules.d.mts - types for the Epic 60.4 rules module so the main process and tests can import it
import type { RosterData, RosterProvider, RosterRoute } from './agents-roster.mjs'
import type { Generation } from './agents-state.mjs'
import type { PathState } from './safe-config-write.mjs'
export type RulesHarness = 'claude' | 'codex' | 'opencode' | 'cursor'
export interface MasterIssue { code: string; line: number; message: string }
export interface Master { path: string; text: string; hash: string; parts: { kind: string; [key: string]: unknown }[] }
export type RenderingKind = 'full' | 'public'
/** Only the approved data decides a rendering, so a preview may pass data that is not approved yet. */
export type RosterView = Pick<Generation, 'data'>
export interface TeamPhrase { form: string; text: string }
export interface Rendering { harness: RulesHarness; text: string; hash: string; kind: RenderingKind; reason: string; team_form: string; bytes: number }
export interface TargetCheck {
  harness: RulesHarness
  path: string
  state: 'unreadable' | 'missing' | 'link' | 'unmanaged' | 'edited-outside' | 'stale' | 'current'
  kind: RenderingKind
  reason: string
  rendered_hash: string
  link_target?: string
  detail?: string
}
export interface InstallResult { code: string; transaction: string | null; written: { harness: RulesHarness; path: string; kind: RenderingKind }[]; message?: string }
export interface TeamUpdateTarget { harness: RulesHarness; path: string; kind: RenderingKind; diff: string; binding: string }
export interface TeamUpdateResult extends InstallResult { skipped: RulesHarness[] }
export interface ProbeEntry { harness: RulesHarness; at: string; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; version: string | null; host?: string | null; route: string; rendered_hash: string; master_hash: string }
export declare const TEAM_LIMIT_BYTES: number
export declare const TEAM_MARKER: string
export declare const KIND_WORDS: Record<RenderingKind, string>
export declare function masterPath(): string
export declare function targetPath(harness: RulesHarness, environment?: NodeJS.ProcessEnv | Record<string, string>): string
export declare function parseMaster(text: string): { parts: Master['parts']; errors: MasterIssue[] }
export declare function readMaster(path?: string): Master
export declare function teamPhrase(generation: RosterView | null): TeamPhrase
export declare function routeFor(harness: RulesHarness, generation: RosterView | null): { kind: RenderingKind; reason: string; route: RosterRoute | null; provider: RosterProvider | null }
export declare function render(master: Master, harness: RulesHarness, generation: RosterView | null, options?: { kind?: RenderingKind | null; team?: TeamPhrase | null }): Rendering
export declare function publicRendering(harness: RulesHarness): string
export declare function planTeamUpdate(nextData: RosterData, options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<{ targets: TeamUpdateTarget[] }>
export declare function applyTeamUpdate(shown: Pick<TeamUpdateTarget, 'harness' | 'binding'>[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; beforeTarget?: (harness: RulesHarness, index: number) => void }): Promise<TeamUpdateResult>
export declare function lastWritten(): Record<string, string>
export declare function checkTargets(environment?: NodeJS.ProcessEnv | Record<string, string>): TargetCheck[]
export declare function installRules(harnesses: RulesHarness[], options?: { yes?: boolean; asJson?: boolean; environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; afterConfirm?: () => void; beforeTarget?: (harness: RulesHarness, index: number) => void; expectedPlanHash?: string }): Promise<InstallResult>
export declare function planInstall(harnesses: RulesHarness[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<{ code: string; message?: string; planHash: string | null; plans: unknown[] }>
export declare function planView(result: Awaited<ReturnType<typeof planInstall>>): { code: string; message?: string; plan_hash: string | null; targets: { harness: RulesHarness; path: string; kind: string; change: string; rendering: RenderingKind; reason: string; team_form: string; link_target?: string; diff: string; fold: string[] }[] }
export declare function listTransactions(): { id: string; valid: boolean; created_at?: string; state?: string; reason?: string; targets?: RulesHarness[] }[]
export declare function restoreTransaction(id: string, options?: { yes?: boolean; asJson?: boolean; planOnly?: boolean; expectedPlanHash?: string }): Promise<{ code: string; restored?: RulesHarness[]; message?: string; plan_hash?: string; targets?: { harness: RulesHarness; path: string; becomes: string; diff: string }[] }>
export declare function masterHistory(): { revision: number; hash: string; bytes: number; at: string; reason: string; intact: boolean }[]
export declare function writeMaster(expected: PathState, text: string, reason: string, options?: { now?: Date }): PathState
export declare function revertMaster(revision: number, options?: { yes?: boolean; asJson?: boolean }): Promise<{ code: string; revision?: number }>
export declare function importedMaster(sourceText: string, opencodeText: string | null): { text: string; changes: string[] }
export type ProbeInspector = (harness: RulesHarness) => { version: string | null; host: string | null }
export declare function probeInspector(environment?: NodeJS.ProcessEnv | Record<string, string>): Promise<ProbeInspector>
export declare function beforeFirstToolCall(rollout: string): string
export declare function lastProbes(options?: { inspect?: ProbeInspector }): (Partial<ProbeEntry> & { harness: RulesHarness; outcome: ProbeEntry['outcome'] | null; stale?: boolean })[]
export declare function probe(harness: RulesHarness, options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; timeoutMs?: number }): Promise<ProbeEntry>
export declare const RULES_USAGE: string
export declare function runRulesCommand(argv: string[]): Promise<number>
