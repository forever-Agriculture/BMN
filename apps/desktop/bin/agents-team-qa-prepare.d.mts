// MODULE: agents-team-qa-prepare.d.mts - typed main-only QA preparation
import type { QaLaunchRequest } from '@bmn/protocol'
export declare function prepareQaPane(request: QaLaunchRequest, environment?: NodeJS.ProcessEnv, cliScript?: string): { executable: string; argv: string[] }
