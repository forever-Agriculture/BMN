// MODULE: agents-team-browser.d.mts - types for a teammate's browser ask: its request, its spaces and its record (Story 74.3)
export interface BrowserRequest { serve: string; origin: string; services?: string[]; interact?: boolean; disposable?: boolean }
export interface ReadBrowserRequest { serve: string; origin: string; port: number; services: string[]; interact: boolean }
export interface BrowserPrograms { node: { launcher?: string; path: string; root: string }; mcp: { cli: string; modules: string; version?: string }; chromium: { path: string; folder: string } }
export type BrowserSetup = (BrowserPrograms & { unavailable?: undefined }) | { unavailable: string; node?: undefined; mcp?: undefined; chromium?: undefined }
export interface BrowserIdentity { [part: string]: unknown }
export interface BrowserSpec {
  version?: number; origin: string; port: number; serve: string; services: string[]; interact?: boolean; tools: string[]; project: string; node: string; node_root: string
  mcp: { cli: string; modules: string; version?: string }; chromium: { path: string; folder: string; revision?: string }; identity?: BrowserIdentity; ready_ms?: number
  app_argv?: string[]; browser_argv?: string[]
}
export interface BrowserSpaces { app: { exitCode: number | null; signalCode: NodeJS.Signals | null; pid?: number }; browser: { exitCode: number | null; signalCode: NodeJS.Signals | null; pid?: number } }
export interface BrowserRecord { calls: number; allowed: number; refused: Array<{ tool: string; reason: string; url?: string }>; pages: Array<{ url: string; title: string }>; screenshots: Array<{ name: string; bytes: number }> }
export declare const BROWSER_MCP_VERSION: string
export declare const CHROMIUM_REVISION: string
export declare const BROWSER_LIMITS: Readonly<{ services: number; command: number; readyMs: number; tmpBytes: number; shmBytes: number }>
export declare const BROWSER_STATEMENT: string
export declare const BROWSER_ROLE: string
export declare const BROWSER_FILES: Readonly<{
  script: string; spec: string; folder: string; bridge: string; mcp: string; out: string; calls: string; files: string; appLog: string; browserLog: string; passwd: string; group: string
  spaces: string; record: string; overlay: string; upper: string; work: string
}>
export declare const SPACE_SCRIPT: string
export declare function browserTools(interact: boolean): string[]
export declare function readBrowserRequest(raw: unknown): { request: ReadBrowserRequest } | { usage: string } | { code: string; message: string }
export declare function browserSetup(environment?: NodeJS.ProcessEnv | Record<string, string>): BrowserSetup
export declare function treeState(folder: string): string
export declare function browserIdentity(setup: BrowserPrograms): BrowserIdentity
export declare function browserProgramChange(identity: BrowserIdentity): string | null
export declare function browserContainment(options?: { bwrap?: string }): { ok: boolean; reason?: string }
export declare function appSpaceArgv(folder: string, spec: BrowserSpec): string[]
export declare function browserSpaceArgv(folder: string, spec: BrowserSpec): string[]
export declare function browserSpec(folder: string, request: ReadBrowserRequest, project: string, setup: BrowserPrograms, identity: BrowserIdentity): BrowserSpec
export declare function prepareBrowserFolder(folder: string, spec: BrowserSpec): void
export declare function browserPrompt(prompt: string, request: ReadBrowserRequest): string
export declare function judgedSpec(folder: string, expected: string): BrowserSpec
export declare function startBrowserSpaces(folder: string, spec: BrowserSpec): BrowserSpaces
export declare function browserReady(folder: string, spec: Pick<BrowserSpec, 'origin' | 'port'>, spaces: BrowserSpaces, options?: { until?: number; stopped?: () => boolean; storage?: () => string | null }): Promise<string | null>
export declare function browserLeftovers(folder: string): number[]
export declare function stopBrowserSpaces(folder: string, spaces: BrowserSpaces): Promise<{ app: { code: number | null; signal: string | null }; browser: { code: number | null; signal: string | null }; left: number[]; overlay?: string }>
export declare function removeOverlay(folder: string): void
export declare function browserRecord(folder: string): BrowserRecord
export declare function browserExportFiles(folder: string): string[]
