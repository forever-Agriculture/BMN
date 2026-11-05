// MODULE: plan-bmad-parser.d.mts - repository-local BMAD compatibility proof declarations
export const BMAD_PARSER_PATHS: readonly string[]
export const BMAD_PARSER_ORIGINAL: string
export const BMAD_PARSER_PREPARED: string
export function parserFiles(repo: string): {path: string; sha256: string | null}[]
export function verifyParserProof(repo: string, proof: unknown): string[]
