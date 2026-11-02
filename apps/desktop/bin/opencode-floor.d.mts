// MODULE: opencode-floor.d.mts - types for OpenCode's refusal rows (Story 102.15)
export declare function parseJsonc(text: string): unknown
export declare function openCodeFloorRows(home: string): { bash: string[]; read: string[] }
export declare function withoutOpenCodeFloor(text: string): string
export declare function withOpenCodeFloor(text: string, home: string): string | null
export declare function openCodeConfigFile(folder: string): string | null
export declare function openCodeRowsHeNamed(text: string, home: string): Array<{ map: string; row: string; word: unknown }>
export declare function openCodeFloorPlan(folder: string, home: string): { hisRows?: Array<{ map: string; row: string; word: unknown }>; file: string | null; text: string | null; next: string | null; state: 'present' | 'missing' | 'unusable' }
