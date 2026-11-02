// MODULE: risky-allow.mjs - Story 102.14: an allow row that can run any program outside the app's limits, named from a fixed list and only in fixed shapes
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Programs that run whatever they are told; `pnpm run` runs any script of the project. */
const ANY_PROGRAM = ['sed', 'awk', 'find', 'xargs', 'env', 'bash', 'sh', 'python3', 'node', 'perl']
const SYSTEM_FOLDER = /^\/(usr|bin|sbin|lib|lib64|opt|etc)\//
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/
const scriptPath = (word) => !word.startsWith('-') && /[/.]/.test(word) && word !== '.' && !SYSTEM_FOLDER.test(word)

/**
 * The words to name a row by when it can run any program, or null. It is so when the program is followed only by flags or by a
 * script path outside a system folder; a row of literal words passes. Only the program and strict flags are ever said, never a
 * path or any other text of the file (`doctor-results.mjs`: credential-free facts).
 */
export function riskyRowName(words) {
  const program = words[0] === 'pnpm' && words[1] === 'run' ? 'pnpm run' : words[0]
  if (program !== 'pnpm run' && !ANY_PROGRAM.includes(program)) return null
  const after = words.slice(program === 'pnpm run' ? 2 : 1)
  if (!after.every((word) => FLAG.test(word) || scriptPath(word))) return null
  return [program, ...after.filter((word) => FLAG.test(word)), ...(after.some(scriptPath) ? ['<a script>'] : [])].join(' ')
}

/** Codex's allow rows in a rules file's text. */
export function codexAllowRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\s*prefix_rule\(\s*pattern\s*=\s*(\[.*\])\s*,\s*decision\s*=\s*"allow"/.exec(line)
    if (match === null) continue
    try {
      const words = JSON.parse(match[1])
      if (Array.isArray(words) && words.every((word) => typeof word === 'string')) rows.push(words)
    } catch {
      // Not a row of plain literal words: nothing this check can name.
    }
  }
  return rows
}

/** Claude Code's allowed Bash rows, as words: `Bash(sed:*)`, `Bash(sed *)`, `Bash(pnpm run:*)`. */
export function claudeAllowRows(allow) {
  if (!Array.isArray(allow)) return []
  return allow.flatMap((row) => {
    const match = typeof row === 'string' ? /^Bash\((.*)\)$/.exec(row) : null
    return match === null ? [] : [match[1].replace(/:\*$|\s\*$/, '').split(/\s+/).filter((word) => word !== '')]
  })
}

const readText = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }

/** One line per risky row of the two apps' files, each named once. An unreadable file names nothing: this is a note, never a verdict. */
export function riskyAllowLines({ home, codexHome = join(home, '.codex'), claudeConfig = join(home, '.claude') }) {
  const say = (app, rows) => [...new Set(rows.map(riskyRowName).filter((name) => name !== null))]
    .map((name) => `${app} allows \`${name}\` with no prompt: it can run any program. Remove the row if you did not mean it.`)
  let files = []
  try { files = readdirSync(join(codexHome, 'rules')).filter((name) => name.endsWith('.rules')).sort() } catch { /* no rules folder */ }
  let claude = []
  try { claude = JSON.parse(readText(join(claudeConfig, 'settings.json'))).permissions?.allow ?? [] } catch { /* no readable settings */ }
  return [...say('Codex', files.flatMap((name) => codexAllowRows(readText(join(codexHome, 'rules', name))))), ...say('Claude Code', claudeAllowRows(claude))]
}
