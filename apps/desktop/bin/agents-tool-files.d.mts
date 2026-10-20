// MODULE: agents-tool-files.d.mts - types for agents-tool-files.mjs (Story 60.12)
export declare class ToolFileError extends Error {
  code: 'TOOL_FILE_UNREADABLE'
  constructor(message: string)
}
export interface JsonEntry { value: unknown; raw: string }
export interface TomlEntry { value: Record<string, unknown> | null; raw: string; start: number; end: number; unreadable?: string }
export declare function readJsonEntries(text: string, path: string[]): Map<string, JsonEntry>
export declare function readJsonItems(text: string, path?: (string | number)[]): { key: string | number; start: number; value: unknown }[]
export declare function editJsonEntry(text: string, path: string[], id: string, value: unknown, options?: { raw?: string }): string
export declare function readTomlEntries(text: string, root?: string): Map<string, TomlEntry>
export declare function renderTomlEntry(id: string, value: Record<string, unknown>, root?: string): string
export declare function editTomlEntry(text: string, id: string, value: Record<string, unknown> | undefined, root?: string, options?: { raw?: string }): string
