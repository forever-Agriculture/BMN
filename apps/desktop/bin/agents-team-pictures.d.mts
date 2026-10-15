// MODULE: agents-team-pictures.d.mts - types for a picture made ready to send (Story 72.8)
export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp'
export declare function pictureType(bytes: Buffer): PictureType | 'image/gif' | null
export declare function treatExif(tiff: Buffer, label: string): { tiff: Buffer | null; orientation: number | null; removed: string[] }
export interface TreatedPicture { media_type: PictureType; width: number; height: number; bytes: Buffer; sha256: string; before: { bytes: number; sha256: string }; removed: string[]; kept: string[] }
export declare function treatPicture(bytes: Buffer, label: string): TreatedPicture
export declare function pictureFile(path: string, options?: { cwd?: string; home?: string }): TreatedPicture & { path: string; real: string }
