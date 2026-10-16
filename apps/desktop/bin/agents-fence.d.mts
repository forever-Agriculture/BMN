// MODULE: agents-fence.d.mts - types for agents-fence.mjs (Stories 63.3 and 70.3)
import type { FenceTestEntry } from './agents-check.mjs'
import type { RosterAgent, RosterData } from './agents-roster.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>

/** Where a marker is planted, in the words the result uses. */
export declare const FENCE_MARKERS: Record<string, string>
/** Where a marker is planted for an OpenCode research run (70.3). */
export declare const OPENCODE_FENCE_MARKERS: Record<string, string>
export declare const FENCE_USAGE: string
export declare function fenceDirectory(): string
/** Which planted markers a text holds, plainly or inside base64. */
export declare function markersIn(text: string, markers: Record<string, string>): string[]
/** The approved, active agents on an app (Codex unless named), one per model: what a fence test covers. */
export declare function fenceSubjects(data: Pick<RosterData, 'agents'>, harness?: 'codex' | 'opencode'): RosterAgent[]
/** One app BMN gives the fence test by itself now (Story 75.8); `key` is the research form and the models. */
export interface FenceAutoPlanEntry { harness: 'codex' | 'opencode'; version: string; key: string; reason: 'untested' | 'retry' }
export declare function fenceAutoPlan(options?: { data?: Pick<RosterData, 'agents'> | null; versions?: Partial<Record<'codex' | 'opencode', string | null>>; tests?: unknown[] }): FenceAutoPlanEntry[]

export interface FenceTestOptions {
  /** The app whose installed version is tested; Codex unless named. */
  harness?: 'codex' | 'opencode'
  agents?: RosterAgent[]
  environment?: Environment
  now?: Date
  /** The provider's own model list, for a comparison under it; without it the app uses the list it was built with. */
  catalog?: { models: unknown[] } | null
  /** The tools an earlier test saw, per model: another list fails the comparison. */
  expected?: Record<string, string[]>
  /** What names each model's entry in `catalog`, kept with the result. */
  entries?: Record<string, string>
  renewal?: boolean
  /** Builds another command than a research run's; such a test counts for nothing. */
  argvOf?: (agent: RosterAgent, options: { environment: Environment; run: { folder: string; codex?: string }; openCodeBase?: string }) => string[]
  record?: boolean
  /** The most one run of the test may take. */
  limitMs?: number
  /** A moment in time that holds for all the runs together: none starts after it, and a test it cut short is not recorded. */
  deadline?: number
  /** Stops the test: every Codex it started is ended and nothing is recorded. */
  signal?: AbortSignal
  /** Writes a run's supervisor into the research lock before the run starts; a run whose supervisor could not be written is not started. */
  register?: (supervisor: { pid: number; start: string }) => void
}
export declare function runFenceTest(options?: FenceTestOptions): Promise<FenceTestEntry>
export declare function providerModelList(options?: { environment?: Environment; limitMs?: number; signal?: AbortSignal; register?: (supervisor: { pid: number; start: string }) => void }): Promise<{ ok: true; models: unknown[] } | { ok: false; reason: string }>
export declare function compareUnderProviderList(options: {
  agent: RosterAgent; environment?: Environment; now?: Date; tests?: FenceTestEntry[]
  modelList?: typeof providerModelList; test?: typeof runFenceTest
  /** The research's own Stop, and what is left of its time. */
  signal?: AbortSignal; limitMs?: number
  /** Writes a run's supervisor into the research lock before the run starts; a run whose supervisor could not be written is not started. */
  register?: (supervisor: { pid: number; start: string }) => void
}): Promise<{ ok: boolean; reason?: string; compared?: boolean; closed?: boolean; stopped?: boolean }>
export declare function runFenceCommand(argv: string[]): Promise<number>
