// MODULE: agents-team-inputs.d.mts - types for what the asker hands a teammate in one ask (Epic 72)
export declare const LIMITS: Readonly<{ question: number; files: number; file: number; prompt: number; pictures: number; picture: number; pictureSide: number; picturePixels: number }>
export declare class InputRefusal extends Error { code: string; constructor(code: string, message: string) }
export declare function sha256Of(bytes: Buffer | string): string
export declare function credentialHits(text: string): string[]
export declare function maskCredentials(text: string, options?: { jsonLines?: boolean }): { text: string; masked: string[] }
export declare function checkQuestion(text: string): { bytes: number; sha256: string }
export interface InputFile { path: string; real: string; bytes: Buffer }
export declare function readInputFile(path: string, options?: { kind?: 'file' | 'image'; cwd?: string; home?: string; limit?: number }): InputFile
export declare function textFile(path: string, options?: { cwd?: string; home?: string }): InputFile & { sha256: string }
/** A path a question names outside the one folder a teammate reads; `attach` when `--file` would take it. */
export interface OutsidePath { path: string; kind: 'file' | 'folder'; attach: boolean }
export declare function outsidePaths(question: string, options?: { root: string | null; given?: string[]; cwd?: string; home?: string; files?: number; bytes?: number }): OutsidePath[]
export declare function mainWorktree(top: string): string | null
export declare function canonicalProject(folder: string): string
export declare function askProject(named: string | undefined, options?: { cwd?: string; home?: string }): string | null
/** The names of the patterns BMN already masked in a text. */
export declare function maskedNames(text: string): string[]
