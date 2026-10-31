// MODULE: qa-browser-relay.d.mts - typed QA relay helpers
export type QaAccountMode = 'test-full' | 'look-only' | 'ordinary-granted'
export declare function qaToolAllowed(mode: QaAccountMode | null, name: string): boolean
export declare const QA_SEAL_TOOL: { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, never> } }
export declare function captureQaScreenshot(folder: string, record: { screenshots: Array<{ name: string; bytes: number; sha256: string }> }, args: Record<string, unknown>, native: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content?: Array<{ type: string; mimeType?: string; data?: string; text?: string }> }>): Promise<unknown>
export declare function runQaBrowser(folder: string): Promise<void>
export declare function replaceStartupPages(context: { newPage(): Promise<unknown>; pages(): unknown[] }): Promise<void>
