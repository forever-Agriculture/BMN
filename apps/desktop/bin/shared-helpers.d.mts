// MODULE: shared-helpers.d.mts - types for shared-helpers.mjs (Story 80.15: the small helpers several bin modules use)
import type { BinaryLike } from 'node:crypto'

export declare function isObject(value: unknown): value is Record<string, unknown>
export declare function onlyKeys(value: object, keys: readonly string[]): boolean
export declare function sha256(text: BinaryLike): string
export declare function readJson(path: string): unknown
export declare function readJsonOrNull(path: string): unknown
export declare function pause(ms: number): Promise<void>
export declare function listed(names: readonly string[]): string
export declare function thousands(value: number | string): string
export declare function canonicalRoute(decision: { kind: string; route: { provider: string; basis: string } | null }): string
export declare function home(environment: Record<string, string | undefined>): string
export declare function realOrNull(path: string): string | null
export declare function spellings(folder: string): string[]
export declare function ensurePrivateDirectory(path: string): void
export declare function insideDirectory(root: string, path: string): boolean
