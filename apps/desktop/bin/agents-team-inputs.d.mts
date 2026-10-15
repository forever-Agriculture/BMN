// MODULE: agents-team-inputs.d.mts - types for what a teammate may read in one ask (Epic 72)
export declare const LIMITS: Readonly<{ question: number; files: number; file: number; prompt: number; pictures: number; picture: number; pictureSide: number; picturePixels: number; projectFiles: number; projectBytes: number; projectFile: number; historyCommits: number; historyBytes: number }>
export declare class InputRefusal extends Error { code: string; constructor(code: string, message: string) }
export declare function sha256Of(bytes: Buffer | string): string
export declare const CREDENTIAL_PATTERNS: readonly [string, RegExp][]
export declare const SYNTHETIC_WORDS: RegExp
export declare function credentialHits(text: string): string[]
export declare function secretName(path: string): boolean
export declare function credentialLocations(home?: string): string[]
export declare function credentialLocation(real: string, home?: string): string | null
export declare function isText(bytes: Buffer): boolean
export declare function checkQuestion(text: string): { bytes: number; sha256: string }
export interface InputFile { path: string; real: string; bytes: Buffer }
export declare function readInputFile(path: string, options?: { kind?: 'file' | 'image'; cwd?: string; home?: string; limit?: number }): InputFile
export declare function textFile(path: string, options?: { cwd?: string; home?: string }): InputFile & { sha256: string }
export declare function workingTreeRoot(folder: string): string | null
export declare function notAProject(real: string, home?: string): string | null
export declare function askProject(named: string | undefined, options?: { cwd?: string; home?: string }): string | null
export interface FrozenFile { path: string; kind: 'file' | 'link' | 'deleted'; bytes?: number; sha256?: string; target?: string; changed: 'modified' | 'added' | 'deleted' | 'type-changed' | 'named' | null }
export interface FrozenProject {
  root: string; revision: string; head: string; public_commit: string | null; files: FrozenFile[]
  history: { commits: string[]; shallow: string[]; counts: { commits: number; trees: number; blobs: number }; objects_sha256: string; objects: string; blobs: { name: string; size: number }[] }
}
/** A tracked file's bytes, read through one descriptor whose real path must be `root/path`. */
export declare function readInside(root: string, path: string, limit?: number): Buffer
export declare function freezeProject(root: string, target: string, options?: { extraFiles?: (InputFile & { sha256: string })[]; publicCommit?: string | null; limits?: typeof LIMITS }): FrozenProject
export declare function headBytes(path: string, count?: number): Buffer
