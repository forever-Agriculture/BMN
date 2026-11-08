// MODULE: plan-allowances.d.mts - types for plan-allowances.mjs (Stories 110.4, 110.5, 110.8: an epic's allowances file)

export interface AllowanceLimit {
  limit: number | null
  ceiling?: number | null
  per: string | null
  unit?: string
}
/** Historical publication evidence only; this does not authorize work or replace readAllowances. */
export declare function allowanceHistoryAt(plan: import('./plan-board.mjs').ResolvedPlan, epic: number, revision: string): {
  go: string; path: string; text: string; chain: string[]; status: string | null
} | null
export interface AllowancesData {
  schema: number | null
  epic: number | null
  limits: Record<string, AllowanceLimit>
  may: string[]
  stays_out: string[]
  deferrable: Array<{ what?: string; when?: string }>
  messages: Array<{ person?: string; destination?: string; purpose?: string }>
  prepared: Array<{ kind?: string; target?: string; check?: string; checked?: string; because?: string }>
}
/** The file read strictly: its values, each problem with its line, and where each part stands. */
export declare function parseAllowances(text: string, expectedEpic?: number | string | null): {
  data: AllowancesData
  problems: Array<{ line: number; reason: string }>
  where: { top: Record<string, number>; limits: Record<string, number>; items: Record<string, unknown> }
  lines: string[]
}
/** The fields run_needs.py's parse_needs gives for Run needs, plus what only the file says. */
export declare function fieldsFrom(data: AllowancesData): {
  rounds: number
  deferrable: string[]
  money_cap: number | null
  named_actions: string | null
  prepared: Array<{ kind: string | null; target: string | null; check: string | null; checked: string | null; none_because: string | null }>
  messages: Array<{ people: string[]; destination: string | undefined; purpose: string | undefined }>
  limits: Record<string, AllowanceLimit>
  may: string[]
  stays_out: string[]
}
/** Each field's before and after, and what of it D7 leaves to his words, against the last recorded version. */
export declare function compareVersions(before: AllowancesData, after: AllowancesData, uses?: (name: string) => boolean): {
  changes: Array<{ field: string; before: string; after: string }>
  words: string[]
  frozen: string[]
}
/** The ledger ids dev-auto would use for this plan's epic: the canonical one and what the location's alias names. */
export declare function ledgerIds(plan: { planRoot: string }, epic: number | string, folder: string): Set<string>
