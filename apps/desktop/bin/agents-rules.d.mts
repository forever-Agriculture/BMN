// MODULE: agents-rules.d.mts - types for the Epic 60.4 rules module so the main process and tests can import it
import type { RetiredApp, RosterData, RosterProvider, RosterRoute } from './agents-roster.mjs'
import type { Generation } from './agents-state.mjs'
import type { PathState } from './safe-config-write.mjs'
export type RulesHarness = 'claude' | 'codex' | 'opencode'
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
export interface TeamUpdateTarget { harness: RulesHarness; path: string; resolved_path: string; kind: RenderingKind; diff: string; binding: string }
export interface TeamUpdateResult extends InstallResult { skipped: RulesHarness[] }
export interface ProbeEntry { harness: RulesHarness; at: string; outcome: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; detail: string; version: string | null; host?: string | null; route: string; rendered_hash: string; master_hash: string; by?: 'bmn' }
export declare const TEAM_LIMIT_BYTES: number
export declare function masterPath(): string
export declare function targetPath(harness: RulesHarness, environment?: NodeJS.ProcessEnv): string
export declare function parseMaster(text: string): { parts: Master['parts']; errors: MasterIssue[] }
export declare function readMaster(path?: string): Master
export declare function teamPhrase(generation: RosterView | null): TeamPhrase
export declare function routeFor(harness: RulesHarness, generation: RosterView | null): { kind: RenderingKind; reason: string; route: RosterRoute | null; provider: RosterProvider | null }
export declare function render(master: Master, harness: RulesHarness, generation: RosterView | null, options?: { kind?: RenderingKind | null; team?: TeamPhrase | null }): Rendering
export declare function publicRendering(harness: RulesHarness): string
export declare function planTeamUpdate(nextData: RosterData, options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<{ targets: TeamUpdateTarget[] }>
export declare function applyTeamUpdate(shown: Pick<TeamUpdateTarget, 'harness' | 'binding'>[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; beforeTarget?: (harness: RulesHarness, index: number) => void }): Promise<TeamUpdateResult>
export declare function checkTargets(environment?: NodeJS.ProcessEnv | Record<string, string>): TargetCheck[]
export declare function rulesRecord(path: string): string | null
export declare function changeRulesRecord(path: string, expected: string | null, next: string | null): void
export declare function rememberSetupMaster(path: string, hash: string, reason: string, now?: Date): ReturnType<typeof masterHistory>[number]
export declare function installRules(harnesses: RulesHarness[], options?: { yes?: boolean; asJson?: boolean; environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; afterConfirm?: () => void; beforeTarget?: (harness: RulesHarness, index: number) => void; expectedPlanHash?: string }): Promise<InstallResult>
declare function planInstall(harnesses: RulesHarness[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<{ code: string; message?: string; planHash: string | null; plans: unknown[] }>
export declare function planView(result: Awaited<ReturnType<typeof planInstall>>): { code: string; message?: string; plan_hash: string | null; targets: { harness: RulesHarness; path: string; resolved_path: string; kind: string; change: string; rendering: RenderingKind; reason: string; team_form: string; link_target?: string; diff: string; fold: string[] }[] }
/** One app's file as a save or an install plans it. */
export interface TargetPlan { harness: RulesHarness; path: string; resolved: string; prior: PathState; rendering: Rendering; kind: string; change: string; diff: string; fold: string[] }
/** Story 75.9: what saving a text writes, the master and each app's file, bound by one hash. */
export interface SavePlan {
  code: string; message?: string; errors?: MasterIssue[]; master?: Master; prior?: PathState; priorHash?: string | null; changesMaster?: boolean; diff?: string
  plans: TargetPlan[]; blocked: { harness: RulesHarness; reason: string }[]; planHash: string | null
}
export declare function planSave(text: string, options?: { environment?: NodeJS.ProcessEnv | Record<string, string> }): Promise<SavePlan>
export interface SaveResult extends InstallResult {
  failed: { harness: RulesHarness; path: string; code: string; message: string }[]
  blocked: { harness: RulesHarness; reason: string }[]
  errors?: MasterIssue[]
  /** Whether the master changed; a save of the same text only writes the apps' files. */
  master?: boolean
}
export declare function saveRules(text: string, options: {
  expectedHash: string | null; expectedLink?: string | null; expectedDirectory?: string | null; expectedPlanHash?: string
  environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; beforeTarget?: (harness: RulesHarness, index: number) => void
}): Promise<SaveResult>
/** An old transaction may name an app BMN retired (Epic 71); it is listed as it was saved. `master` marks a save's (Story 75.9). */
export declare function listTransactions(): { id: string; valid: boolean; created_at?: string; state?: string; reason?: string; targets?: (RulesHarness | RetiredApp)[]; master?: true }[]
export declare function restoreTransaction(id: string, options?: { yes?: boolean; asJson?: boolean; planOnly?: boolean; expectedPlanHash?: string }): Promise<{
  code: string; restored?: RulesHarness[]; message?: string; plan_hash?: string; targets?: { harness: RulesHarness; path: string; resolved_path: string; becomes: string; diff: string }[]
  left?: { harness: RetiredApp; path: string; reason: string }[]; master?: true | { path: string; becomes: string; diff: string }
}>
export declare function masterHistory(): { revision: number; hash: string; bytes: number; at: string; reason: string; intact: boolean }[]
export declare function writeMaster(expected: PathState, text: string, reason: string, options?: { now?: Date }): PathState
export declare function importedMaster(sourceText: string, opencodeText: string | null): { text: string; changes: string[] }
export type ProbeInspector = (harness: RulesHarness) => { version: string | null; host: string | null }
export declare function probeInspector(environment?: NodeJS.ProcessEnv | Record<string, string>): Promise<ProbeInspector>
export declare function lastProbes(options?: { inspect?: ProbeInspector }): (Partial<ProbeEntry> & { harness: RulesHarness; outcome: ProbeEntry['outcome'] | null; stale?: boolean })[]
export declare function probe(harness: RulesHarness, options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; now?: Date; timeoutMs?: number; by?: 'bmn' }): Promise<ProbeEntry>
/** One app BMN gives the loading test by itself now (Story 75.8); `key` is the rendering it tests. */
export interface ProbeAutoPlanEntry { harness: RulesHarness; version: string; key: string; reason: 'untested' | 'retry' }
export declare function probeAutoPlan(options?: { versions?: Partial<Record<RulesHarness, string | null>>; environment?: NodeJS.ProcessEnv | Record<string, string> }): ProbeAutoPlanEntry[]
export declare function runRulesCommand(argv: string[]): Promise<number>
export declare function confirm(question: string, details: string, options: { yes: boolean; asJson: boolean }): Promise<boolean>
export declare function writePrivate(path: string, text: string, options?: { guard?: () => void }): void
export declare function newTransaction(now: Date): { id: string; folder: string }
export declare function routeStillMatches(harness: string, decision: { kind: RenderingKind; route: { provider: string } | null }, environment: NodeJS.ProcessEnv | Record<string, string>): Promise<{ ok: boolean; reason?: string; remedy?: string; inspected?: unknown }>
export declare function findRollout(root: string, cwd: string, since: number): string | null
