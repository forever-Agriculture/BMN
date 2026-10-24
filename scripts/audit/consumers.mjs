#!/usr/bin/env node
// MODULE: consumers.mjs - Story 91.5: every place that may still use a name or a file, before anything is called dead
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = `Usage: node scripts/audit/consumers.mjs [--json] [--root DIR]... [--exclude PATH]... TERM...
Prints every hit of each TERM (a name, or a file's path) in BMN's code, docs and skills, dev-auto and the installed
skills, with names built from strings, what electron-builder.yml packages, and the Git history of the term. A hit in
an --exclude path (the candidate's own files) is left out. Exit 0 when no TERM has a hit, 1 when one does.`

/** The places BMN's code, docs and skills are read from by default: this checkout with its plan, dev-auto, the installed skills. */
export function defaultRoots(repo) {
  return [repo, join(homedir(), 'code/dev-auto'), join(homedir(), '.local/share/bmn/skills')].filter((root) => existsSync(root))
}

/** The registries a name can be reached through without an import (Story 91.5's starting points). */
export const REGISTRIES = [
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/utility/control-server.ts', 'apps/desktop/bin/bmn-commands.mjs',
  'apps/desktop/bin/bmn-hooks.mjs', 'apps/desktop/src/utility/store-schema.ts'
]
const PACKAGING = 'apps/desktop/electron-builder.yml'
const SKIP = new Set(['node_modules', '.git', 'out', 'release', '.dev-auto', '.claude', 'dist'])

/** A root's text files: Git's tracked files where it is a checkout (with its own plan/ checkout inside), else every file. */
export function filesOf(root) {
  const listed = (folder) => {
    try {
      return execFileSync('git', ['-C', folder, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
    } catch {
      return null
    }
  }
  const walk = (folder, prefix = '') => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return []
    const path = join(folder, entry.name)
    const isFolder = entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return statSync(path).isDirectory() } catch { return false } })())
    return isFolder ? walk(path, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  })
  const tracked = listed(root)
  if (tracked === null) return walk(root)
  // BMN's planning is a Git checkout of its own, ignored by the product's.
  const plan = existsSync(join(root, 'plan')) ? listed(join(root, 'plan')) : null
  return [...tracked, ...(plan ?? []).map((file) => `plan/${file}`)]
}

function kindOf(file) {
  if (file === PACKAGING) return 'packaged'
  if (REGISTRIES.includes(file)) return 'registry'
  if (/(^|\/)skills\//u.test(file) || file.endsWith('SKILL.md')) return 'skill'
  if (/\.(md|txt)$/u.test(file)) return 'doc'
  if (/\.test\.(ts|tsx|mjs|js)$/u.test(file)) return 'test'
  return 'code'
}

/** A file's path, as against a name (a channel, a command, a package such as @codemirror/search): it has an extension. */
export const isPath = (term) => extname(term) !== '' && !term.startsWith('@')

/** The words a term is matched by: itself, and for a path its file name with and without its extension. */
export function spellings(term) {
  if (!isPath(term)) return [term]
  const name = basename(term)
  return [...new Set([term, name, name.slice(0, name.length - extname(name).length)])].filter((word) => word.length >= 3)
}

/**
 * A line that builds the term from strings: its last part beside a join of a template, a concatenation or a
 * `.join(`, with another of its parts on the same line (`aiterm:${area}:snapshot`, 'aiterm:' + 'rules' + ':snapshot').
 */
export function builtFrom(term, line) {
  // A path is found by its file name instead.
  if (isPath(term)) return false
  const parts = term.split(/[:._/-]/u).filter((part) => part.length >= 3)
  if (parts.length < 2 || line.includes(term)) return false
  const last = parts.at(-1)
  return line.includes(last) && /\$\{|['"`]\s*\+|\+\s*['"`]|\.join\(/u.test(line) && parts.slice(0, -1).some((part) => line.includes(part))
}

/** Every hit of the term in the roots, outside the excluded paths. */
export function hitsOf(term, { roots, exclude = [] }) {
  const words = spellings(term)
  const hits = []
  for (const root of roots) {
    const real = realpathSync(root)
    for (const file of filesOf(root)) {
      const absolute = join(root, file)
      if (exclude.some((path) => absolute === path || absolute.startsWith(`${path}/`))) continue
      let text
      try {
        if (statSync(absolute).size > 2 * 1024 * 1024) continue
        text = readFileSync(absolute, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\0')) continue
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        const word = words.find((one) => new RegExp(`(^|[^\\w-])${one.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^\\w-])`, 'u').test(line))
        const how = word !== undefined ? kindOf(file) : builtFrom(term, line) ? 'built' : null
        if (how !== null) hits.push({ root: real, file, line: index + 1, kind: how, text: line.trim().slice(0, 200) })
      })
    }
  }
  return hits
}

/** The term's Git history in a checkout: how many commits added or removed it, and the newest. */
export function historyOf(term, repo) {
  try {
    const log = execFileSync('git', ['-C', repo, 'log', '--format=%h %ad %s', '--date=short', `-S${term}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean)
    return { commits: log.length, newest: log[0] ?? null, oldest: log.at(-1) ?? null }
  } catch {
    return { commits: null, newest: null, oldest: null }
  }
}

function main(argv) {
  if (argv.includes('--help') || argv.length === 0) { console.log(USAGE); return argv.length === 0 ? 2 : 0 }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const take = (name) => argv.flatMap((part, index) => (argv[index - 1] === name ? [part] : []))
  const roots = take('--root').length > 0 ? take('--root').map((root) => resolve(root)) : defaultRoots(repo)
  const exclude = take('--exclude').map((path) => resolve(path))
  const terms = argv.filter((part, index) => !part.startsWith('--') && !['--root', '--exclude'].includes(argv[index - 1]))
  const report = terms.map((term) => ({ term, hits: hitsOf(term, { roots, exclude }), history: historyOf(term, repo) }))
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    for (const { term, hits, history } of report) {
      console.log(`${term}: ${hits.length} hit${hits.length === 1 ? '' : 's'}; history ${history.commits ?? '?'} commits${history.newest ? `, newest ${history.newest}` : ''}`)
      for (const hit of hits) console.log(`  ${hit.kind.padEnd(8)} ${relative(repo, join(hit.root, hit.file)) || hit.file}:${hit.line}  ${hit.text}`)
    }
  }
  return report.some(({ hits }) => hits.length > 0) ? 1 : 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
