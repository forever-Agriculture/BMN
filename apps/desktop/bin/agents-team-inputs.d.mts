// MODULE: agents-team-inputs.d.mts - types for what the asker hands a teammate in one ask (Epic 72)
export declare const LIMITS: Readonly<{ question: number; files: number; file: number; prompt: number; pictures: number; picture: number; pictureSide: number; picturePixels: number }>
export declare class InputRefusal extends Error { code: string; constructor(code: string, message: string) }
export declare function sha256Of(bytes: Buffer | string): string
export declare const CREDENTIAL_PATTERNS: readonly [string, RegExp][]
export declare const SYNTHETIC_WORDS: RegExp
export declare function credentialHits(text: string): string[]
export declare function maskCredentials(text: string, options?: { jsonLines?: boolean }): { text: string; masked: string[] }
export declare function secretName(path: string): boolean
export declare function credentialLocations(home?: string): string[]
export declare function credentialLocation(real: string, home?: string): string | null
export declare function isText(bytes: Buffer): boolean
export declare function checkQuestion(text: string): { bytes: number; sha256: string }
export interface InputFile { path: string; real: string; bytes: Buffer }
export declare function readInputFile(path: string, options?: { kind?: 'file' | 'image'; cwd?: string; home?: string; limit?: number }): InputFile
export declare function textFile(path: string, options?: { cwd?: string; home?: string }): InputFile & { sha256: string }
export declare function workingTreeRoot(folder: string): string | null
export declare function mainWorktree(top: string): string | null
export declare function canonicalProject(folder: string): string
export declare function notAProject(real: string, home?: string): string | null
export declare function askProject(named: string | undefined, options?: { cwd?: string; home?: string }): string | null
/** The names of the patterns BMN already masked in a text. */
export declare function maskedNames(text: string): string[]
