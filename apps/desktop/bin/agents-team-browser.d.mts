// MODULE: agents-team-browser.d.mts - types for a teammate's browser check of the asker's local app (Story 74.3)
export interface AskBrowser { origin: string; interact: boolean }
export interface BrowserPage { url: string | null; title: string | null }
export interface BrowserScreenshot { name: string; bytes: number; sha256: string }
export interface BrowserRecord { version: 1; origin: string; interact: boolean; tools: string[]; statement: string; calls: number; pages: BrowserPage[]; screenshots: BrowserScreenshot[]; removed: number }
export declare const BROWSER_MCP_PACKAGE: string
export declare const BROWSER_SERVER: string
export declare const BROWSER_ROLE: string
export declare const BROWSER_STATEMENT: string
export declare const LOOK_TOOLS: readonly string[]
export declare const INTERACT_TOOLS: readonly string[]
export declare const BROWSER_LIMITS: Readonly<{ pages: number; url: number; pageTitle: number; screenshots: number; screenshot: number }>
export declare const BROWSER_RELAY: string
export declare const BROWSER_CONFIG: string
export declare const BROWSER_LIMIT_WORDS: string
export declare function browserTemporary(folder: string): string
export declare function browserOrigin(value: string | undefined): { origin: string } | { reason: string }
export declare function browserInstalled(environment: { PATH?: string; HOME?: string }, options?: { timeoutMs?: number }): { reason?: string }
export declare function browserTools(interact: boolean): string[]
export declare function browserServer(browser: AskBrowser, folder: string): { command: string; args: string[] }
export declare function browserPrompt(prompt: string, browser: AskBrowser): string
export declare function sessionCalls(text: string): Array<{ tool: string | null; args: unknown; page: { url: string; title: string | null } | null; shots: string[] }>
export declare function browserRecord(folder: string, browser: AskBrowser, prior?: BrowserRecord | null): { record: BrowserRecord; removed: string[] }
