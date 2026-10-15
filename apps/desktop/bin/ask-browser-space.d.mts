// MODULE: ask-browser-space.d.mts - types for BMN's script of a browser ask's spaces and its filter of the browser's tools (Story 74.3)
import type { Readable, Writable } from 'node:stream'
export declare const LOOK_TOOLS: readonly string[]
export declare const INTERACT_TOOLS: readonly string[]
export declare const NEVER_TOOLS: Readonly<Record<string, string>>
export declare function offOrigin(address: unknown, origin: string): string | null
export declare function judgeCall(name: unknown, args: unknown, options: { tools: readonly string[]; origin: string }): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string }
export declare function resultSummary(result: unknown): { page: string | null; title: string | null; images: number; error: boolean; text: string }
export declare function filterMcp(client: Readable & Writable, toServer: Writable, fromServer: Readable, options: { tools: readonly string[]; origin: string; log: (entry: Record<string, unknown>) => void }): void
