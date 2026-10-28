// MODULE: plan-board.d.mts - types for plan-board.mjs (Epic 77: one resolver, reader and check for a project's plan)
export declare const FORMAT: 'bmn-plan'
export declare const NOTE_LIMIT: number
export declare const STATUSES: string[]
export declare const BMAD_STATUSES: string[]
export declare const EXIT: { ok: 0; findings: 1; unable: 2 }
export declare const ROW: RegExp

export declare class PlanError extends Error {
  code: string
  constructor(code: string, message: string)
}

export interface ResolvedPlan {
  productRoot: string
  defaultCheckout: string
  runCheckout: string
  format: 'bmn-plan' | 'bmad'
  planRoot: string
  boardPath: string
  boardCheckout: string
  tracked: boolean
  history: 'plan-repository' | 'product-repository' | 'none'
}

export interface BoardRow { key: string; status: string; note: string; line: number; epic: number | null; story: string | null; token: string }
export interface Board {
  format: string | null
  schemaVersion: string | null
  queue: number[]
  queueLines: number[]
  rows: BoardRow[]
  malformed: Array<{ line: number; text: string; where: 'queue' | 'development_status' }>
  duplicates: Array<{ key: string; line: number; first: number }>
  headerDuplicates: Array<{ key: string; line: number; first: number }>
  logicalDuplicates: Array<{ id: string; key: string; line: number; first: { key: string; line: number } }>
  totalRows: number
}
export interface EpicFile {
  path: string
  bytes: number
  legacy: boolean
  legacyNote: string | null
  epic: number | null
  suggestedLead: string | null
  sections: string[]
  stories: Array<{ id: string; epic: number; line: number; criteria: Array<{ id: number; line: number }>; verification: boolean }>
}

export declare function rowToken(key: string, status: string, note: string): string
export declare function suggestedLeadHint(text: string): string | null
export declare function epicLeadHint(planRoot: string, key: string): string | null
export declare function withLeadHint(note: string, hint: string, date?: string): { note: string; clipped: boolean }
export declare function resolvePlan(start: string): Promise<ResolvedPlan>
export declare function readBoard(path: string, options?: { epics?: number[] }): Promise<Board>
export declare function readEpicFile(path: string): EpicFile
export declare function boardProblems(board: Board, boardName: string): Array<{ where: string; reason: string }>
export declare function checkPlan(resolved: ResolvedPlan): Promise<{ findings: Array<{ where: string; reason: string }>; board: Board }>
export declare function boardBytes(path: string): number | null
