// MODULE: agents-state.d.mts - types for the read-only approved-state module so the main process can import it
import type { RosterData, RosterIssue, RosterSection } from './agents-roster.mjs'
export interface Generation {
  schema: 1
  number: number
  parent: number | null
  created_at: string
  kind: 'approval' | 'restore'
  restored_from?: number
  roster_file_hash: string
  data: RosterData
  hash: string
}
export interface DiffSide { present: boolean; value?: unknown; hash?: string }
export interface DiffEntry {
  scope: 'agent' | 'roles' | 'data-labels' | 'harness-routes'
  id: string
  field: string | null
  kind: 'added' | 'removed' | 'changed'
  free_text?: boolean
  before?: DiffSide
  after?: DiffSide
}
export declare function stateDirectory(): string
export declare function generationsDirectory(): string
export declare function currentPointerPath(): string
export declare function generationPath(number: number): string
export declare function approvalLockPath(): string
export declare function historyLogPath(): string
export declare function generationHash(generation: Omit<Generation, 'hash'> & { hash?: string }): string
export declare function readRosterFile(path?: string): { path: string; text: string; hash: string }
export declare function readValidRoster(path?: string): { path: string; text: string; hash: string; data: RosterData; errors: RosterIssue[]; warnings: RosterIssue[]; sections: RosterSection[] }
export declare function readGeneration(number: number): Generation | null
export declare function generationNumbers(): number[]
export declare function lastGoodGeneration(): number | null
export declare function readApproved(): Generation
export declare function listGenerations(): Record<string, unknown>[]
export declare function machineDiff(approved: RosterData, file: RosterData): DiffEntry[]
export declare function diffLine(entry: DiffEntry): string
export declare function buildGeneration(options: { number: number; parent: number | null; data: RosterData; rosterFileHash: string; kind?: 'approval' | 'restore'; restoredFrom?: number; now?: Date }): Generation
