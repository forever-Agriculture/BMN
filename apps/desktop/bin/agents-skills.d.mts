// MODULE: agents-skills.d.mts - types for agents-skills.mjs (Story 60.11)
import type { Generation } from './agents-state.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>
export type SkillsHarness = 'claude' | 'codex' | 'opencode'
export type SkillState = 'unreadable' | 'missing' | 'link' | 'unmanaged' | 'edited-outside' | 'stale' | 'current' | 'read-directly' | 'exposed' | 'excluded'
export type SkillsOutcome = 'pass' | 'fail' | 'inconclusive' | 'unavailable'

export declare class SkillsError extends Error {
  code: string
  constructor(code: string, message: string)
}

/** `list` is the command that names the skills an app sees, or for OpenCode 2 the operation its server answers. */
export declare const SKILL_APPS: Record<SkillsHarness, { command: string; roots: string[]; list: { argv: string[]; input: string } | { server: string } | null; prompt: boolean }>
export declare const SETTLED_STATES: SkillState[]
export declare function rootPath(root: string, environment?: Environment): string
export declare function skillsTestsPath(): string

export interface TreeEntry { path: string; kind: 'file' | 'folder' | 'link' | 'other'; mode?: number; hash?: string; target?: string }
export declare function treeEntries(root: string): TreeEntry[]
export declare function treeHash(root: string): string
export declare function copyTree(from: string, to: string): void
export type SkillEntry = { kind: 'missing'; directory: string } | { kind: 'link'; target: string; directory: string } | { kind: 'tree'; hash: string; folder: boolean; directory: string }
export declare function entryOf(path: string): SkillEntry

export declare function skillsSource(data: { skills_source?: string } | null, environment?: Environment): string
export declare function skillDescription(text: string): string
export interface SourceSkill { name: string; path: string; readable: boolean; description?: string; hash?: string; detail?: string }
export declare function sourceSkills(source: string): { path: string; readable: boolean; detail?: string; skills: SourceSkill[] }
export declare function eligible(mark: { public?: true; only?: string[] } | undefined, harness: string, kind: 'full' | 'public'): boolean

export interface SkillsRoot { root: string; folder: boolean; link: boolean }
export interface SkillsTestEntry {
  harness: string
  /** `capability`: where the app reads skills. `listing`: the app lists a skill placed there. `loading`: a run with a prompt (an older record of this kind without `basis: 'prompt'` is a listing). */
  kind: 'capability' | 'listing' | 'loading'
  at: string
  version: string | null
  outcome: SkillsOutcome
  detail: string
  roots?: SkillsRoot[]
  route?: string
  discovery?: string
  skills_hash?: string
  /** What a loading result rests on: `prompt` is a run with one prompt; `listing` marks an older record that sent none. */
  basis?: 'listing' | 'prompt'
  /** `bmn`: a folders test BMN ran by itself after an app update (`bmn skills test <app> --auto`). */
  by?: 'bmn'
}
export declare function skillsTests(): SkillsTestEntry[]
export declare function lastSkillsTest(harness: string, kind: SkillsTestEntry['kind'], tests?: SkillsTestEntry[]): SkillsTestEntry | null

export interface AppSkills {
  harness: SkillsHarness
  version: string | null
  supported: boolean
  /** Why skills are not supported yet in this app, when they are not. */
  reason?: string
  /** The folder BMN installs into, or null when the app only reads the skills folder itself. */
  location: string | null
  format: 'link' | 'copy' | null
  reads_source: boolean
  roots: string[]
}
export declare function appSkills(harness: string, options: { environment?: Environment; version: string | null | undefined; tests?: SkillsTestEntry[]; source: string }): AppSkills

export interface SkillRow { name: string; state: SkillState; path?: string; link_target?: string; detail?: string; direct?: boolean; removed?: boolean; managed?: boolean }
export interface SkillsCheck {
  source: { path: string; readable: boolean; detail?: string }
  skills: { name: string; readable: boolean; hash?: string; detail?: string; description?: string; public: boolean; only: SkillsHarness[] | null }[]
  /** Skills the team file marks that the folder does not hold. */
  marked_missing: string[]
  apps: (AppSkills & { kind: 'full' | 'public'; kind_reason: string; skills: SkillRow[] })[]
}
export type SkillsVersions = Partial<Record<SkillsHarness, string | null>>
export declare function checkSkills(options?: { environment?: Environment; tests?: SkillsTestEntry[]; versions?: SkillsVersions; generation?: Generation | null; descriptions?: boolean }): SkillsCheck
export declare function pendingCounts(result: SkillsCheck): { pending: number; exposed: number }
export declare function checkExit(result: SkillsCheck): 0 | 1
export declare function appStateWord(app: SkillsCheck['apps'][number], sourceReadable?: boolean): 'Not supported yet' | 'Differs' | 'Exposed' | 'Missing' | 'Reads the source' | 'Copied' | 'Linked'
export declare function withHeader(text: string, name: string, sourceHash: string): string

export interface SkillsTarget { harness: SkillsHarness; skill: string; path: string; resolved_path: string; action: 'link' | 'copy' | 'remove'; change: string; words: string; detail?: string; link_target?: string }
export interface SkillsExposure { harness: SkillsHarness; skill: string; path?: string; fix: string }
export interface SkillsPlan { code: string; message?: string; source?: string; planHash: string | null; targets: unknown[]; exposed: SkillsExposure[] }
export declare function planSkillsInstall(harnesses?: string[], options?: { environment?: Environment; versions?: SkillsVersions; tests?: SkillsTestEntry[] }): Promise<SkillsPlan>
export declare function skillsPlanView(result: SkillsPlan): { code: string; message?: string; plan_hash: string | null; source: string | null; targets: SkillsTarget[]; exposed: SkillsExposure[] }
export interface SkillsInstallResult {
  code: string
  message?: string
  transaction: string | null
  written: { harness: SkillsHarness; skill: string; path: string; action: 'link' | 'copy' | 'remove' }[]
  exposed: SkillsExposure[]
}
export declare function installSkills(harnesses?: string[], options?: {
  yes?: boolean; asJson?: boolean; environment?: Environment; versions?: SkillsVersions; now?: Date; expectedPlanHash?: string
  afterConfirm?: () => void; beforeTarget?: (target: { harness: string; skill: string; path: string }, index: number) => void
  afterTarget?: (target: { harness: string; skill: string; path: string }, index: number) => void
}): Promise<SkillsInstallResult>
export declare function restoreSkillsTransaction(manifest: unknown, folder: string, options?: { yes?: boolean; asJson?: boolean; planOnly?: boolean; expectedPlanHash?: string; leftWords?: string[] }): Promise<{ code: string; restored?: string[]; message?: string; plan_hash?: string; targets?: { harness: string; path: string; resolved_path: string; becomes: string; diff: string }[] }>

export declare function testSkillsFolders(harness: string, options?: { environment?: Environment; now?: Date; timeoutMs?: number; by?: 'bmn' }): Promise<SkillsTestEntry>
type SkillsTestOptions = { environment?: Environment; now?: Date; timeoutMs?: number; by?: 'bmn' }
type LastSkillsTests = (Partial<SkillsTestEntry> & { harness: SkillsHarness; outcome: SkillsOutcome | null; stale?: boolean })[]
type LastSkillsOptions = { environment?: Environment; tests?: SkillsTestEntry[]; versions?: SkillsVersions; generation?: Generation | null }
export declare function testSkillsListing(harness: string, options?: SkillsTestOptions): Promise<SkillsTestEntry>
export declare function claudeLoadingVerdict(stdout: string, token: string): [SkillsOutcome, string]
export declare function codexLoadingVerdict(rollout: string, token: string): [SkillsOutcome, string]
export declare function testSkillsLoading(harness: string, options?: SkillsTestOptions): Promise<SkillsTestEntry>
export declare function lastLoadingTests(options?: LastSkillsOptions): LastSkillsTests
export declare function lastListingTests(options?: LastSkillsOptions): LastSkillsTests
export declare function testSkills(harness: string, options?: SkillsTestOptions): Promise<{ harness: string; version: string | null; outcome: SkillsOutcome; detail: string; folders: SkillsTestEntry; listing: SkillsTestEntry | null }>
/** One app BMN tests by itself now (Story 75.8): `key` names what else the test is bound to, empty where only the version. */
export interface SkillsAutoPlanEntry { harness: SkillsHarness; version: string; key: string; reason: 'untested' | 'retry' }
export declare function skillsAutoPlan(options?: { versions?: SkillsVersions; tests?: SkillsTestEntry[]; generation?: Generation | null }): SkillsAutoPlanEntry[]
export declare function skillsLoadingAutoPlan(options?: { versions?: SkillsVersions; tests?: SkillsTestEntry[]; environment?: Environment; generation?: Generation | null }): SkillsAutoPlanEntry[]
export declare const SKILLS_USAGE: string
export declare function runSkillsCommand(argv: string[]): Promise<number>
