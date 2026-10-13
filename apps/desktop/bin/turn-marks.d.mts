// MODULE: turn-marks.d.mts - types for the hook's turn marks, so the host and the tests read the same table and shapes
export declare const TURN_MARKS: Record<string, { version: string; promptEvent: string; promptArrives: 'typed' | 'taken' }>
export declare const TURN_MARK_LIMIT_MS: number
export declare const TURN_MARK_CONFIRMED: string[]
export interface TurnFacts {
  conversation?: string
  turn?: string
  nested?: true
}
export type TurnMark =
  | { edge: 'start'; app: string; conversation: string; turn?: string; folder?: string; continued?: true }
  | { edge: 'end'; kind: 'finished' | 'error' | 'interrupted' | 'continues'; app: string; conversation: string; turn?: string }
export declare function turnFacts(agent: string, event: Record<string, unknown>): TurnFacts
export declare function turnMark(agent: string, event: Record<string, unknown>): TurnMark | null
export declare function turnMarksWanted(socketPath: unknown, sessionId: unknown): boolean
export declare function turnSwitchFile(socketFolder: string, sessionId: string): string
export declare function turnStanding(agent: string): string
