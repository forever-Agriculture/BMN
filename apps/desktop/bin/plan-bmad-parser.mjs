// MODULE: plan-bmad-parser.mjs - strict proof for the two prepared repository-local BMAD generators
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PlanError } from './plan-board.mjs'

export const BMAD_PARSER_PATHS = Object.freeze(['.claude', '.agents'].map(client => `${client}/skills/bmad-sprint-planning/scripts/sprint_plan.py`))
export const BMAD_PARSER_ORIGINAL = '4c30f62c261599fc1da3fd319ea6ce5092aa0332221cedee1763a1040627e6bc'
export const BMAD_PARSER_PREPARED = '11cb8db0764ce66380ebef38c3eea7267b93793451fb60e2d26e203e32a129d2'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function parserFiles(repo) {
  const root = realpathSync(repo)
  return BMAD_PARSER_PATHS.map(path => {
    const full = join(root, path)
    if (!existsSync(full)) return { path, sha256: null }
    if (!lstatSync(full).isFile() || realpathSync(full) !== resolve(full)) throw new PlanError('BMAD_PREPARATION_REQUIRED', `${path} must be a repository-local regular file without linked parents`)
    return { path, sha256: hash(readFileSync(full)) }
  })
}
export function verifyParserProof(repo, proof) {
  const files = parserFiles(repo)
  if (files.every(file => file.sha256 === null) && !proof) return []
  if (proof?.version !== 1 || proof.original_sha256 !== BMAD_PARSER_ORIGINAL || proof.prepared_sha256 !== BMAD_PARSER_PREPARED || JSON.stringify(proof.paths) !== JSON.stringify(BMAD_PARSER_PATHS) || files.some(file => file.sha256 !== BMAD_PARSER_PREPARED)) throw new PlanError('BMAD_PREPARATION_REQUIRED', 'both BMAD clients must finish the rehearsed compatibility preparation before copied-plan writes or publication')
  return [...BMAD_PARSER_PATHS]
}
