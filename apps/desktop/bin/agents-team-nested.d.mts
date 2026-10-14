// MODULE: agents-team-nested.d.mts - types for telling a process inside a teammate's ask (Epic 72)
export declare function defaultRunsDirectory(): string
export declare function namespaceIndex(runs?: string): string
export declare function namespaceNumber(link: string | null | undefined): string | null
export declare function childNamespace(pid: number): string | null
export declare function nameNamespace(runs: string, link: string, id: string): string | null
export declare function forgetNamespace(runs: string, link: string): void
export declare function nestedAsk(runs?: string, self?: string): string | null
export declare function nestedWords(id: string): string
