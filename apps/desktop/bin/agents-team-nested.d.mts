// MODULE: agents-team-nested.d.mts - types for telling a process inside a teammate's ask (Epic 72)
export declare const ASK_SCOPE_PREFIX: string
export declare function scopeAsk(path: string | null | undefined): string | null
export declare function nestedAsk(self?: string): string | null
export declare function nestedWords(id: string): string
