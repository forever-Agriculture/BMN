// MODULE: agents-research.d.mts - types for agents-research.mjs (Story 60.10)
import type { RosterData } from './agents-roster.mjs'

type Environment = NodeJS.ProcessEnv | Record<string, string>

export declare const RESEARCH_APPS: string[]
export declare const RESEARCH_LIMIT_MS: number
export declare const MAX_LISTED: number
export declare const SOURCE_RANKS: string[]
export declare function researchDirectory(): string
export declare function researchResultsPath(): string

export interface ResearchBatch { provider: string; name: string; sites: string[]; models: string[]; listed: number }
export declare function researchSubjects(data: RosterData): Omit<ResearchBatch, 'listed'>[]
export declare function researchBatches(data: RosterData): ResearchBatch[]
export declare function researchPrompt(batch: ResearchBatch): string
export declare function researchEffort(agent: { efforts: string[] }): string
export declare function researchArgv(agent: RosterData['agents'][number], options?: { environment?: Environment; run?: { folder: string } | null; version?: string | null; contextTests?: unknown[] }): string[]

export interface Researcher { id: string; name: string; harness: string; ok: boolean; why?: string; reason?: string }
export declare function researchers(options?: { environment?: Environment; now?: Date }): Researcher[]
export declare function chosenResearcher(): string | null
export declare function chooseResearcher(id: string): void

export interface AnsweredPrice { input: number; output: number; cached_input?: number; source: string; as_of: string }
export interface AnsweredWindow { tokens: number; source: string; as_of: string }
export interface AnsweredModel { id: string; provider: string; listed: boolean; published_name?: string; price: AnsweredPrice | null; context_window: AnsweredWindow | null }
export declare function parseAnswer(text: unknown, batch: ResearchBatch, options?: { now?: Date }): { ok: true; models: AnsweredModel[] } | { ok: false; reason: string }
export declare function answerText(harness: string, stdout: string, run: { folder: string }): { ok: true; text: string } | { ok: false; reason: string }

export type PageRead = { ok: true; text: string } | { ok: false; reason: string }
export declare function isPublicAddress(address: string): boolean
export declare function fetchPublicPage(address: string, options?: {
  timeoutMs?: number; maxBytes?: number; redirects?: number; selfTestPages?: string | null
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>
  transport?: (url: URL, address: { address: string; family: number }, limits: { timeoutMs: number; maxBytes: number }) => Promise<{ status?: number; location?: string | null; type?: string; body?: string; failed?: string; tooLarge?: boolean }>
}): Promise<PageRead>
export declare function pageText(html: string): string
export declare function priceShown(text: string, names: string[], others: string[], price: { input: number; output: number; cached_input?: number }): { shown: boolean; why?: string; cached?: boolean }
export declare function windowShown(text: string, names: string[], others: string[], tokens: number): { shown: boolean; why?: string }
export declare function sourceRank(address: string, sites: string[]): 1 | 2

export interface Checked { rank: 1 | 2; verified: boolean; why?: string }
export interface FoundModel extends Omit<AnsweredModel, 'price' | 'context_window'> { price: (AnsweredPrice & Checked) | null; context_window: (AnsweredWindow & Checked) | null }
export declare function verifyModels(models: AnsweredModel[], sites: string[], options?: { fetchPage?: (address: string) => Promise<PageRead> }): Promise<FoundModel[]>

export interface ResearchRunRecord { id: string; kind: 'research' | 'lookup'; at: string; researcher: string; researcher_name: string; state: 'complete' | 'partial' | 'stopped' | 'failed'; models: number; note?: string }
export interface KeptModel extends FoundModel { provider_id: string; first_seen: string; first_run: string; last_seen: string; last_run: string }
export interface ResearchStore { version: 1; runs: ResearchRunRecord[]; models: KeptModel[] }
export declare function readResearch(): ResearchStore
export declare function mergeResearch(store: ResearchStore, run: ResearchRunRecord, found: (FoundModel & { provider_id: string })[]): ResearchStore
export declare function saveResearch(store: ResearchStore): void

export interface ResearchModelShape {
  id: string; provider: string; providerId: string; publishedName?: string
  price: (AnsweredPrice & Checked) | null; contextWindow: (AnsweredWindow & Checked) | null
  firstSeen: string; lastSeen: string; fresh: boolean; foundLast: boolean
}
export interface ResearchViewShape {
  last: { at: string; researcher: string; state: ResearchRunRecord['state']; models: number; note?: string } | null
  previousAt: string | null
  models: ResearchModelShape[]
}
export declare function researchView(store: ResearchStore): ResearchViewShape

export declare function runResearch(options: {
  researcher: string; only?: { provider: string; model: string } | null; environment?: Environment; now?: () => Date; signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number }) => void; fetchPage?: (address: string) => Promise<PageRead>; limitMs?: number; contextTests?: unknown[]
}): Promise<{ run: ResearchRunRecord; found: (FoundModel & { provider_id: string })[] }>
