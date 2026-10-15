// MODULE: agents-team-cli.d.mts - types for `bmn team ask` and `bmn team asks` (Epic 72)
export declare const TEAM_ASK_USAGE: string
export declare function readAskOptions(argv: string[]): Record<string, string | boolean | string[]> & { file: string[] }
export declare function askJson(folder: string): Record<string, unknown>
export declare const BUSY_EXIT: number
export type TeamAsker = { kind: 'shell' } | { kind: 'owner' } | { kind: 'session'; session: string; app?: string } | { kind: 'forged' | 'unproven'; reason: string }
export type SessionProof = { session: string } | { invalid: true } | { unreachable: string }
export declare function verifySessionToken(socketPath: string, token: string, options?: { timeoutMs?: number }): Promise<SessionProof>
export declare function teamAsker(environment: NodeJS.ProcessEnv | Record<string, string | undefined>, options?: { verify?: (socketPath: string, token: string) => Promise<SessionProof> }): Promise<TeamAsker>
export declare function bmnControlSocket(environment?: NodeJS.ProcessEnv | Record<string, string | undefined>): string
export interface AskFeatures {
  version: 1; platform: string; container: { ok: boolean; reason?: string }
  apps: Array<{ app: string; installed: boolean; version: string | null; measured: string[]; forms: Record<'question' | 'files' | 'project' | 'wide-read', string>; pictures: string; usage_while_running: boolean }>
}
export declare function askFeatures(environment?: NodeJS.ProcessEnv | Record<string, string>): AskFeatures
export declare function runTeamAsk(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; now?: () => Date }): Promise<number>
export declare function runTeamAsks(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string }): Promise<number>
export declare const OUTCOME_EXIT: Readonly<Record<string, number>>
