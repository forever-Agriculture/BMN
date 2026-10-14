// MODULE: agents-team-cli.d.mts - types for `bmn team ask` and `bmn team asks` (Epic 72)
export declare const TEAM_ASK_USAGE: string
export declare function readAskOptions(argv: string[]): Record<string, string | boolean | string[]> & { file: string[] }
export declare function askJson(folder: string): Record<string, unknown>
export declare function runTeamAsk(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string }): Promise<number>
export declare function runTeamAsks(argv: string[], options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; cwd?: string }): Promise<number>
export declare const OUTCOME_EXIT: Readonly<Record<string, number>>
