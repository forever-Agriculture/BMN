// MODULE: agents-team-places.d.mts - types for keys, capacity places, recovery and retention of asks (Epic 72)
export declare const CAPACITY: Readonly<{ default: number; min: number; max: number }>
export declare const KEY_WINDOW_DAYS: number
export declare const RETENTION_DAYS: number
export declare const KEY_PATTERN: RegExp
export declare function keyDay(key: string | null | undefined): number | null
export declare function keyExpired(key: string, now?: Date): boolean
export declare function keyFresh(key: string, now?: Date): boolean
export declare function makeKey(by: string, now?: Date): string
export declare function keyScope(asker: { kind: string; session?: string }): string
export interface HashedRequest {
  role: string; question: string; agent?: string | undefined; effort?: string | undefined; smallWork?: boolean; recheckOf?: string | undefined; project?: string | null | undefined; access?: string | undefined
  files?: Array<{ path: string; sha256: string }>; images?: Array<{ path: string; sha256: string }>; data?: string | undefined; wide?: boolean; timeLimitMinutes: number
  browser?: { serve?: string | null; origin?: string | null; services?: string[]; interact?: boolean; disposable?: boolean } | null | undefined
}
export declare function requestHash(request: HashedRequest): string
export declare function keyPath(runs: string, scope: string, key: string): string
export declare function placePath(runs: string, id: string): string
export declare function askSettings(runs: string): { capacity: number; token_ceiling: number | null }
export declare function recordInterrupted(folder: string, reason: string): void
export declare function mountIdentity(path: string): { device: string, folder: string } | null
export interface Holder { pid: number; start: string | null }
export declare function runHolds(runs: string, id: string, holder: Holder | null | undefined, now?: number): boolean
export declare function releasePlace(runs: string, id: string): void
export interface KeyEntry { version: 1; key: string; scope: string; request_sha256: string; id: string; first_used_at?: string; holder?: Holder; state?: 'gone'; outcome?: string | null; removed_at?: string }
export declare function reserveAsk(runs: string, request: { scope: string; key: string; hash: string; id: string }, options?: { now?: Date; capacity?: number; holder?: Holder }): Promise<{ reserved: string; existing?: undefined; entry?: undefined } | { existing: string; entry: KeyEntry; reserved?: undefined }>
export declare function releaseReservation(runs: string, reservation: { scope: string; key: string; id: string }): Promise<void>
export declare function keyedRun(runs: string, entry: KeyEntry, now?: number): { state: 'preparing' | 'run'; folder: string } | { state: 'interrupted'; reason: string }
export declare function removeRun(runs: string, id: string, now?: Date): boolean
export declare function sweepRuns(runs: string, now?: Date): void
