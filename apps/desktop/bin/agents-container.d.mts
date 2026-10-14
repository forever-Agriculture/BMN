// MODULE: agents-container.d.mts - types for the bubblewrap container of one ask (Epic 72)
export declare const BWRAP: string
export declare const INSIDE: Readonly<{ root: string; home: string; inputs: string; project: string; work: string }>
export interface ContainerSpec {
  app?: string[]; home: string; inputs?: string | null; project?: string | null; binds?: { from: string; to: string; writable: boolean }[]
  environment?: Record<string, string>; cwd?: string; passwd?: string; group?: string; command: string[]
}
export declare function containerArgv(spec: ContainerSpec): string[]
export declare function appPaths(harness: string, environment?: NodeJS.ProcessEnv | Record<string, string>): { launcher: string; payload: string; root: string; paths: string[] } | null
export declare function containerStarts(options?: { bwrap?: string; timeoutMs?: number }): { ok: true; reason?: undefined } | { ok: false; reason: string }
