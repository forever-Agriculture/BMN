// MODULE: agents-team-qa-prepare.d.mts - typed main-only QA preparation
import type { QaLaunchRequest } from '@bmn/protocol'
export declare function prepareQaPane(request: QaLaunchRequest, environment?: NodeJS.ProcessEnv, cliScript?: string): { executable: string; argv: string[] }
export declare function qaRelayCommand(bin: string, folder: string): { command: string; args: string[] }
export declare function claudeQaTools(brief: { accounts?: unknown[] }): string[]
