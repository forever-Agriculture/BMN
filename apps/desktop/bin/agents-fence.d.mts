// MODULE: agents-fence.d.mts - types for agents-fence.mjs (Story 63.3)
import type { FenceTestEntry } from './agents-check.mjs'
import type { RosterAgent, RosterData } from './agents-roster.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>

/** Where a marker is planted, in the words the result uses. */
export declare const FENCE_MARKERS: Record<string, string>
export declare const FENCE_USAGE: string
export declare function fenceDirectory(): string
/** Which planted markers a text holds, plainly or inside base64. */
export declare function markersIn(text: string, markers: Record<string, string>): string[]
/** The approved, active agents on Codex, one per model: what a fence test covers. */
export declare function fenceSubjects(data: Pick<RosterData, 'agents'>): RosterAgent[]

export interface FenceTestOptions {
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
  argvOf?: (agent: RosterAgent, options: { environment: Environment; run: { folder: string; codex?: string } }) => string[]
  record?: boolean
  limitMs?: number
}
export declare function runFenceTest(options?: FenceTestOptions): Promise<FenceTestEntry>
export declare function providerModelList(options?: { environment?: Environment; limitMs?: number }): Promise<{ ok: true; models: unknown[] } | { ok: false; reason: string }>
export declare function compareUnderProviderList(options: {
  agent: RosterAgent; environment?: Environment; now?: Date; tests?: FenceTestEntry[]
  modelList?: typeof providerModelList; test?: typeof runFenceTest
}): Promise<{ ok: boolean; reason?: string; compared?: boolean; closed?: boolean }>
export declare function runFenceCommand(argv: string[]): Promise<number>
