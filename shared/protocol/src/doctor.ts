// MODULE: doctor.ts - Read-only Health doctor facts, per-check freshness and automatic retry state
export type DoctorCheck = 'hooks' | 'skills' | 'tools' | 'rules' | 'claude' | 'codex' | 'leftovers'
export type DoctorState = 'passed' | 'problems' | 'partial' | 'failed' | 'timeout' | 'unsupported' | 'unqualified' | 'interrupted'
export interface DoctorProblem { code: string; item: number; count?: number; app?: 'claude' | 'codex' | 'opencode' }
export interface DoctorLocationStat { device: string; inode: string; size: string; modified: string; changed: string; mode: string; type: 'file' | 'directory' | 'link' | 'other' }
export interface DoctorLocationSource {
  root: string; parent: DoctorLocationStat; object: DoctorLocationStat; entry: number
  route?: { device: string; inode: string; entry: number }[]
  target?: DoctorLocationStat | null; wal?: DoctorLocationStat | null; journalAbsent?: true
}
export type DoctorLocator = { status: 'unresolved' }
  | (DoctorLocationSource & { status: 'located' | 'stale'; acquisition: 2; witnesses: DoctorLocationSource[]; line?: number; column?: number; rowid?: number })
  | { status: 'located' | 'stale'; acquisition: 4; root: string; parent: { device: string; inode: string }; object: { device: string; inode: string }; entry: number;
      route?: { device: string; inode: string; entry: number }[]; line?: number; column?: number; rowid?: number }
export interface DoctorLeftover { kind: 'memory' | 'skills' | 'plugins' | 'mcp'; app: 'claude' | 'codex' | 'opencode' | null; reason: string; item: number; identity?: 'withheld'; source?: 'managed'; locator?: DoctorLocator; currentLocator?: DoctorLocator }
export interface DoctorRow {
  check: DoctorCheck
  state: DoctorState
  problems: (DoctorProblem & { reason: string; fix: string })[]
  leftovers: (DoctorLeftover & { reasonText: string; location: string })[]
  checkedAt: number | null
  stale: boolean
}
export interface DoctorView {
  schemaVersion: 1
  locationHelp: string
  running: boolean
  cycleStartedAt: number | null
  attemptStartedAt: number | null
  retryUsed: boolean
  retryAtNextStart: boolean
  error: 'state-unavailable' | 'run-unavailable' | 'profile-changed' | 'profile-unavailable' | null
  rows: DoctorRow[]
  problemCount: number
  allWell: boolean
  exitCode: 0 | 1 | 3
}
