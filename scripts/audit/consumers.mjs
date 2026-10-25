#!/usr/bin/env node
// MODULE: consumers.mjs - Story 91.5: every place that may still use a name or a file, before anything is called dead, with each one's blame
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = `Usage: node scripts/audit/consumers.mjs [--json] [--root DIR]... [--exclude PATH]... TERM...
Prints every hit of each TERM (a name, or a file's path) in BMN's code, docs and skills, dev-auto and the installed
skills, with names built from strings, what electron-builder.yml packages, each hit's blame and the Git history of the
term; for a file, also the computed imports it could be loaded through, to be read. A hit in an --exclude path (the
candidate's own files) is left out. Exit 0 when no TERM has a hit, 1 when one does.`

/**
 * The places BMN's code, docs and skills are read from by default: this checkout with its plan, dev-auto, the installed
 * skills. A worktree has no plan/ of its own, so the default checkout's is read (it sits beside the shared .git).
 */
export function defaultRoots(repo) {
  let plan = []
  if (!existsSync(join(repo, 'plan'))) {
    try {
      const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      plan = [join(dirname(common), 'plan')]
    } catch {
      plan = []
    }
  }
  return [repo, ...plan, join(homedir(), 'code/dev-auto'), join(homedir(), '.local/share/bmn/skills')].filter((root) => existsSync(root))
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

function kindOf(file, root) {
  // BMN's planning: epics, references and review records.
  if (basename(root) === 'plan' || file.startsWith('plan/')) return 'plan'
  if (file === PACKAGING) return 'packaged'
  if (REGISTRIES.includes(file)) return 'registry'
  if (/(^|\/)skills\//u.test(file) || file.endsWith('SKILL.md')) return 'skill'
  if (/\.(md|txt)$/u.test(file)) return 'doc'
  if (/\.test\.(ts|tsx|mjs|js)$/u.test(file)) return 'test'
  return 'code'
}

/** A file's path, as against a name (a channel, a command, a scoped package): it has an extension. */
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

/**
 * An import or require of a variable or a template with a substitution: what file it loads is decided when it runs,
 * so no spelling of a file finds it. A variable defined in the same file comes with its defining line.
 */
export function computedImport(line, lines) {
  const call = /(?:^|[^\w$.])(?:import|require)\(\s*(?!['"]|`[^`$]*`|\))([^)]*)/u.exec(line)
  if (call === null) return null
  const name = /^[A-Za-z_$][\w$]*/u.exec(call[1])?.[0]
  const at = name === undefined ? -1 : lines.findIndex((one) => new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/gu, '\\$')}\\s*=`, 'u').test(one))
  return { specifier: call[1].trim().slice(0, 120), defined: at === -1 ? null : { line: at + 1, text: lines[at].trim().slice(0, 200) } }
}

/** The commit that last changed a line, and its date, from the Git checkout holding the file; null outside one. */
export function blameOf(path, line) {
  try {
    const out = execFileSync('git', ['-C', dirname(path), 'blame', '--porcelain', '-L', `${line},${line}`, '--', basename(path)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const commit = out.slice(0, 40)
    const time = /^author-time (\d+)$/mu.exec(out)?.[1]
    // The date in the author's own zone, as `git log --date=short` gives it.
    const zone = /^author-tz ([+-])(\d\d)(\d\d)$/mu.exec(out)
    const offset = zone === null ? 0 : (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 3600 + Number(zone[3]) * 60)
    if (/^0+$/u.test(commit)) return 'uncommitted'
    return `${commit.slice(0, 8)} ${time === undefined ? '?' : new Date((Number(time) + offset) * 1000).toISOString().slice(0, 10)}`
  } catch {
    return null
  }
}

/**
 * Every hit of each term in the roots, outside the excluded paths, reading each file once: a map from term to hits,
 * and the computed imports in code (`dynamic`).
 */
export function scan(terms, { roots, exclude = [] }) {
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const matchers = terms.map((term) => ({ term, words: spellings(term).map((one) => new RegExp(`(^|[^\\w-])${escape(one)}($|[^\\w-])`, 'u')) }))
  const found = new Map(terms.map((term) => [term, []]))
  const dynamic = []
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
      if (['code', 'test', 'registry'].includes(kindOf(file, root))) {
        lines.forEach((line, index) => {
          const site = computedImport(line, lines)
          if (site !== null) dynamic.push({ root: real, file, line: index + 1, text: line.trim().slice(0, 200), ...site })
        })
      }
      for (const { term, words } of matchers) {
        lines.forEach((line, index) => {
          const how = words.some((word) => word.test(line)) ? kindOf(file, root) : builtFrom(term, line) ? 'built' : null
          if (how !== null) found.get(term).push({ root: real, file, line: index + 1, kind: how, text: line.trim().slice(0, 200), blame: blameOf(absolute, index + 1) })
        })
      }
    }
  }
  return { hits: found, dynamic }
}

/** Every hit of the term in the roots, outside the excluded paths. */
export const hitsOf = (term, options) => scan([term], options).hits.get(term)

/** The term's Git history in a checkout: the commits that changed the file (a path) or added or removed the name, the newest and the first. */
export function historyOf(term, repo) {
  try {
    const which = isPath(term) ? ['--follow', '--', term] : [`-S${term}`]
    const log = execFileSync('git', ['-C', repo, 'log', '--format=%h %ad %s', '--date=short', ...which], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
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
  const { hits: found, dynamic } = scan(terms, { roots, exclude })
  const report = terms.map((term) => ({ term, hits: found.get(term), history: historyOf(term, repo), ...(isPath(term) ? { dynamic } : {}) }))
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    for (const { term, hits, history, dynamic } of report) {
      console.log(`${term}: ${hits.length} hit${hits.length === 1 ? '' : 's'}; history ${history.commits ?? '?'} commits${history.newest ? `, newest ${history.newest}` : ''}`)
      for (const hit of hits) console.log(`  ${hit.kind.padEnd(8)} ${relative(repo, join(hit.root, hit.file)) || hit.file}:${hit.line}  ${hit.text}${hit.blame ? `  (${hit.blame})` : ''}`)
      for (const site of dynamic ?? []) {
        console.log(`  ${'dynamic'.padEnd(8)} ${relative(repo, join(site.root, site.file)) || site.file}:${site.line}  ${site.text}${site.defined ? `  (defined :${site.defined.line} ${site.defined.text})` : ''}`)
      }
    }
  }
  return report.some(({ hits }) => hits.length > 0) ? 1 : 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
