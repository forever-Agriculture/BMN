// MODULE: secret-list.d.mts - types for his machine's secret list and BMN's own owner keys (Stories 102.3, 137.1)
export declare const SECRET_FILES: string[]
export declare const isSecretFile: (relative: string) => boolean
export declare function underHome(word: string): string | null
export declare const BMN_KEY_NAMES: string[]
export declare function namesBmnKey(word: string): boolean
export declare function namesSecretFile(word: string): boolean
export declare function namesFolderOfSecret(word: string): boolean
