// MODULE: qa-claude-fence.d.mts - typed per-run Claude Code QA fence
export declare const QA_FENCE_POLICY: number
export declare const QA_RELAY_SERVER: string
export interface QaFenceReceipt {
  version: 1; binding: Record<string, unknown>; pass: boolean; exit: number | string; offered: string[]; extra: string[]
  refusals: Array<{ name: string; completed: boolean; refused: boolean; text: string | null }>; usable: Array<{ name: string; ok: boolean }>
  intact: boolean; fetched: number; initTools: string[] | null; initToolsSha256: string | null; initMcpServers: unknown; realModelCalled: false; stderrTail: string
}
export declare function fenceBinding(launch: Record<string, unknown>): Record<string, unknown>
export declare function qualifyClaudeQa(folder: string, options?: { timeoutMs?: number }): Promise<QaFenceReceipt>
export declare function checkQaInit(folder: string, event: unknown, agent: { pid: number; ticks: string }): { version: 1; ok: boolean; toolsSha256: string | null; servers: string[] | null; agent: { pid: number; ticks: string } }
export declare function qualifiedQaRun(folder: string, agent: { pid: number; ticks: string } | null | undefined): boolean
