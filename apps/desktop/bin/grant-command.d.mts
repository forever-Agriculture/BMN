// MODULE: grant-command.d.mts - types for what `bmn grant ask` refuses of a command term and the hash of a pinned file
import type { GrantCommandTerm, GrantPinnedFile } from '@bmn/protocol'

export function pinnedFileSha(pin: GrantPinnedFile, folder: string): string | null
export function commandPinSha(term: Pick<GrantCommandTerm, 'command' | 'folder' | 'script'>): string | null
export function grantCommandProblem(term: GrantCommandTerm): string | null
