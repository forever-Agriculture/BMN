// MODULE: grant-command.d.mts - types for what `bmn grant ask` refuses of a command term and the hash of a pinned file
import type { GrantCommandTerm, GrantPinnedFile, PlanAction } from '@bmn/protocol'

export function pinnedFileSha(pin: GrantPinnedFile, folder: string): string | null
export function commandPinSha(term: Pick<GrantCommandTerm, 'command' | 'folder' | 'script'>): string | null
export function grantCommandProblem(term: GrantCommandTerm): string | null

export function grantAccessCommandProblem(command: string): string | null
export function epicCommandTarget(term: Extract<PlanAction, { kind: 'command' }>):
  { remote: string | null; ref: string; script: string | null; program: string } | { problem: string }
