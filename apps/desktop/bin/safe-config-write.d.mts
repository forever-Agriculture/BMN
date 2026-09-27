// MODULE: safe-config-write.d.mts - types for the shared config writer so the utility process can import it
export declare class ConfigWriteError extends Error {
  constructor(code: string, message: string)
  readonly code: string
}
export declare function absoluteUncollapsed(path: string): string
export declare function linkTarget(path: string): string
export declare function writeAtomically(path: string, text: string, verify?: (target: string) => void): string
export declare function currentText(path: string): string | null
export declare function writeConfigSafely(
  path: string,
  expectedText: string | null,
  nextText: string,
  options?: { beforeCommit?: () => void; now?: () => Date }
): { target: string; backup: string | null }
export declare function rewrittenNumbers(text: string): string[]
export declare function jsonIndent(text: string): number | '\t'
