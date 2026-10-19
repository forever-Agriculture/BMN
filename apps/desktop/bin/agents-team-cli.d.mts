// MODULE: agents-team-cli.d.mts - types for `bmn team ask` and `bmn team asks` (Epic 72)
export declare function askJson(folder: string): Record<string, unknown>
/** `bmn team asks show` in words, from what askJson returns. */
export declare function showWords(shown: Record<string, unknown>): string
export type TeamAsker = { kind: 'shell' } | { kind: 'owner' } | { kind: 'session'; session: string; app?: string } | { kind: 'forged' | 'unproven'; reason: string }
export type SessionProof = { session: string } | { invalid: true } | { unreachable: string }
export declare function teamAsker(environment: NodeJS.ProcessEnv | Record<string, string | undefined>, options?: { verify?: (socketPath: string, token: string) => Promise<SessionProof> }): Promise<TeamAsker>
/** One way an app runs an ask: its form's name and what that form can read, or null where none is offered. */
export interface AskFeatureForm { form: string | null; reads: string }
export interface AskFeatures {
  version: 2; platform: string; scope: { ok: boolean; reason?: string }
  apps: Array<{
    app: string; installed: boolean; version: string | null; form_checked_on: { version: string; on: string }
    forms: Record<'project' | 'no-project' | 'public', AskFeatureForm>; pictures: string; usage_while_running: boolean
  }>
}
export declare function askFeatures(environment?: NodeJS.ProcessEnv | Record<string, string>): AskFeatures
export declare function runTeamAsk(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; now?: () => Date }): Promise<number>
export declare function runTeamAsks(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string }): Promise<number>
