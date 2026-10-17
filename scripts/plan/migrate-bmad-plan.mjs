#!/usr/bin/env node
// MODULE: migrate-bmad-plan.mjs - Story 77.6: move a BMAD plan (epics.md, sprint-status.yaml, references) into BMN's plan/ format in a staging folder, with a manifest of every file and text span, a verified archive, a span check and a rehearsed rollback; the originals are never touched
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The move, as Story 77.6 has it: nothing is lost. Every file under `_bmad-output/`, `_bmad/` and the apps'
 * `bmad-*` skill folders is listed with its hash and mapped to its new place or to the archive only; every text
 * span of `epics.md` and the board is mapped to the file that holds it. Epic text moves verbatim beneath a legacy
 * marker; the only change permitted is a link destination, each one recorded so the span check can reverse it.
 * Text several epics share (the front matter, an extension before more than one epic) moves verbatim to
 * `shared/`, linked from each epic it precedes. The board becomes `status.yaml` by an explicit status table.
 */
export const STATUS_TABLE = { done: 'done', backlog: 'backlog', 'ready-for-dev': 'backlog', drafted: 'backlog', contexted: 'backlog', 'in-progress': 'in-progress', review: 'review' }
export const NOTE_LIMIT = 160
export const MARKER = (contracts) => `<!-- bmn-plan: bmad-legacy${contracts.length ? `; contracts: ${contracts.join(', ')}` : ''} -->`
const PARKED = /\bpark(?:ed|s)?\b/iu

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'epic'
const pad = (number) => String(number).padStart(3, '0')

/** Every file under a folder, without following links; a link is listed as a link. */
export function filesUnder(root, base = root) {
  const out = []
  if (!existsSync(root)) return out
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) out.push(...filesUnder(path, base))
    else out.push({ path: relative(base, path), link: stat.isSymbolicLink() ? readlinkSync(path) : null, bytes: stat.isSymbolicLink() ? 0 : stat.size })
  }
  return out
}

/** The sources: `_bmad-output/`, `_bmad/` and every app's `bmad-*` skill folder, as repository-relative paths. */
export function sources(repo) {
  const roots = ['_bmad-output', '_bmad']
  for (const app of readdirSync(repo).filter((name) => name.startsWith('.') && existsSync(join(repo, name, 'skills')))) {
    for (const skill of readdirSync(join(repo, app, 'skills')).filter((name) => name.startsWith('bmad-'))) roots.push(`${app}/skills/${skill}`)
  }
  const files = []
  for (const root of roots) {
    const full = join(repo, root)
    if (!existsSync(full)) continue
    if (!lstatSync(full).isDirectory()) { files.push({ path: root, link: lstatSync(full).isSymbolicLink() ? readlinkSync(full) : null, bytes: lstatSync(full).size }); continue }
    for (const file of filesUnder(full)) files.push({ ...file, path: `${root}/${file.path}` })
  }
  for (const file of files) file.sha256 = file.link !== null ? sha256(`link:${file.link}`) : sha256(readFileSync(join(repo, file.path)))
  return { roots, files }
}

/**
 * epics.md as segments: the front matter (everything before the first extension or epic), then each
 * `## Extension…` and `## Epic N: Title` section in order, with their line ranges (1-based, inclusive).
 */
export function segmentEpics(text) {
  const lines = text.split('\n')
  const heads = []
  let fence = false
  lines.forEach((line, index) => {
    if (/^\s*```/u.test(line)) fence = !fence
    if (fence) return
    const epic = /^## Epic (\d+):\s*(.*?)\s*$/u.exec(line)
    if (epic) heads.push({ kind: 'epic', line: index, number: Number(epic[1]), title: epic[2] })
    else if (/^## .*\bExtension\b/u.test(line)) heads.push({ kind: 'extension', line: index, title: line.slice(3).trim() })
  })
  const segments = []
  const first = heads[0]?.line ?? lines.length
  segments.push({ kind: 'front', start: 0, end: first, text: lines.slice(0, first).join('\n') })
  heads.forEach((head, index) => {
    const end = heads[index + 1]?.line ?? lines.length
    segments.push({ ...head, start: head.line, end, text: lines.slice(head.line, end).join('\n') })
  })
  // An extension covers the epics after it up to the next extension.
  let current = null
  for (const segment of segments) {
    if (segment.kind === 'extension') { current = segment; segment.covers = [] } else if (segment.kind === 'epic' && current) { current.covers.push(segment.number); segment.extension = current }
  }
  return { lines, segments }
}

/** Markdown link destinations in a text: `](dest)` and `](dest "title")`, with their offsets. */
export function linksIn(text) {
  const links = []
  const pattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu
  for (const match of text.matchAll(pattern)) links.push({ dest: match[1], offset: match.index + 2 })
  return links
}

/**
 * Rewrite the relative link destinations of `text`, which moves from `from` to `to` (repository-relative paths),
 * by `mapPath` (an old repository-relative path to its new one, or null when it does not move). Returns the text
 * and each rewrite as { offset in the new text, original, rewritten }; links that resolve nowhere are listed.
 */
export function rewriteLinks(text, from, to, mapPath, exists) {
  const rewrites = []
  const unresolved = []
  let out = ''
  let last = 0
  for (const link of linksIn(text)) {
    const dest = link.dest
    if (/^[a-z][a-z0-9+.-]*:/iu.test(dest) || dest.startsWith('#') || dest.startsWith('/') || dest.startsWith('<')) continue
    const [pathPart, anchor] = dest.split('#', 2)
    let decoded
    try { decoded = decodeURI(pathPart) } catch { decoded = pathPart }
    const target = posix.normalize(posix.join(posix.dirname(from), decoded))
    const mapped = mapPath(target, anchor ?? null)
    const finalTarget = mapped ?? target
    // A link that resolves nowhere in the source either (a deleted file, a `file.ts:71` line suffix) is kept pointing at the same place.
    if (mapped === null && !exists(target) && !exists(target.replace(/:\d+(?::\d+)?$/u, ''))) unresolved.push({ file: to, dest, broken_in_source: true })
    const targetPath = typeof finalTarget === 'string' ? finalTarget : finalTarget.path
    let next = posix.relative(posix.dirname(to), targetPath)
    if (next === '') next = posix.basename(targetPath)
    const anchorOut = typeof finalTarget === 'string' ? anchor : finalTarget.anchor
    const rewritten = `${encodeURI(next)}${anchorOut ? `#${anchorOut}` : ''}`
    if (rewritten === dest) continue
    out += text.slice(last, link.offset)
    rewrites.push({ offset: out.length, original: dest, rewritten })
    out += rewritten
    last = link.offset + dest.length
  }
  out += text.slice(last)
  return { text: out, rewrites, unresolved }
}

/** The text before its recorded link rewrites, for the span check. */
export function reverseRewrites(text, rewrites) {
  let out = text
  for (const rewrite of [...rewrites].sort((a, b) => b.offset - a.offset)) {
    if (out.slice(rewrite.offset, rewrite.offset + rewrite.rewritten.length) !== rewrite.rewritten) throw new Error(`rewrite at ${rewrite.offset} does not match`)
    out = out.slice(0, rewrite.offset) + rewrite.original + out.slice(rewrite.offset + rewrite.rewritten.length)
  }
  return out
}

/** The board: header lines before `development_status:` and each row with its line, status and comment. */
export function parseBoard(text) {
  const lines = text.split('\n')
  const header = []
  const rows = []
  const other = []
  let section = false
  lines.forEach((line, index) => {
    if (/^development_status:/u.test(line)) { section = true; return }
    if (!section) { header.push({ line: index + 1, text: line }); return }
    const row = /^ {2}([\w.-]+):[ \t]*([\w-]+)[ \t]*(?:#[ \t]?(.*?))?[ \t]*$/u.exec(line)
    if (row) rows.push({ line: index + 1, key: row[1], status: row[2], comment: row[3] ?? '', text: line })
    else other.push({ line: index + 1, text: line })
  })
  return { header, rows, other }
}


/**
 * Build the staged plan. `repo` is the product checkout holding `_bmad-output/`; `stage` an empty folder that
 * becomes `plan/`. Returns the manifest (also written to `<stage>/../migration-manifest.json`).
 */
export function stagePlan({ repo, stage, date = new Date().toISOString().slice(0, 10), docs = null }) {
  if (existsSync(stage) && readdirSync(stage).length > 0) throw new Error(`${stage} is not empty: refusing to stage over it`)
  const planning = '_bmad-output/planning-artifacts'
  const implementation = '_bmad-output/implementation-artifacts'
  const epicsPath = `${planning}/epics.md`
  const boardPath = `${implementation}/sprint-status.yaml`
  const inventory = sources(repo)
  const epicsText = readFileSync(join(repo, epicsPath), 'utf8')
  const boardText = readFileSync(join(repo, boardPath), 'utf8')
  const { segments } = segmentEpics(epicsText)
  const board = parseBoard(boardText)
  const epics = segments.filter((segment) => segment.kind === 'epic')
  const epicFile = new Map(epics.map((epic) => [epic.number, `epics/${pad(epic.number)}-${slugOf(epic.title)}.md`]))
  const sharedNames = new Set()
  const sharedFile = (segment) => {
    let name = segment.kind === 'front' ? 'front-matter.md' : `${slugOf(segment.title.replace(/^Extension:?\s*/iu, ''))}.md`
    while (sharedNames.has(name)) name = name.replace(/\.md$/u, '-2.md')
    sharedNames.add(name)
    return `shared/${name}`
  }
  for (const segment of segments) if (segment.kind === 'front' || (segment.kind === 'extension' && segment.covers.length !== 1)) segment.file = sharedFile(segment)

  // Where each source path goes in the plan (repository-relative → plan-relative), or null for the archive only.
  const placeOf = (path) => {
    if (path === epicsPath) return 'shared/front-matter.md'
    if (path === boardPath) return 'status.yaml'
    if (path.startsWith(`${planning}/`)) return `references/${path.slice(planning.length + 1)}`
    if (path.startsWith(`${implementation}/`)) return `references/implementation-artifacts/${path.slice(implementation.length + 1)}`
    if (path.startsWith('_bmad-output/')) return `references/${path.slice('_bmad-output/'.length)}`
    return null
  }
  const planRoot = 'plan'
  const exists = (target) => existsSync(join(repo, target))
  // A link to epics.md#epic-N… goes to that epic's file; any other link into epics.md to the front matter.
  const mapPath = (target, anchor) => {
    if (target === epicsPath) {
      const number = /^epic-(\d+)\b/u.exec(anchor ?? '')?.[1]
      if (number && epicFile.has(Number(number))) return { path: `${planRoot}/${epicFile.get(Number(number))}`, anchor: '' }
      return { path: `${planRoot}/shared/front-matter.md`, anchor: anchor ?? '' }
    }
    const place = placeOf(target)
    if (place !== null) return `${planRoot}/${place}`
    // A folder link (a reference-* folder) moves with its folder.
    if (target.startsWith(`${planning}/`) && exists(target)) return `${planRoot}/references/${target.slice(planning.length + 1)}`
    return null
  }

  const manifest = { version: 1, date, repo, stage, files: [], spans: [], rewrites: {}, unresolved: [], board: { rows: [], header: [] }, written: {} }
  const write = (path, text, rewrites = []) => {
    const full = join(stage, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
    if (rewrites.length) manifest.rewrites[path] = rewrites
    manifest.written[path] = sha256(text)
  }
  const moveText = (text, fromRepoPath, toPlanPath) => {
    const result = rewriteLinks(text, fromRepoPath, `${planRoot}/${toPlanPath}`, mapPath, exists)
    manifest.unresolved.push(...result.unresolved.map((entry) => ({ ...entry, source: fromRepoPath })))
    return result
  }

  // Board rows: the status table, long comments to the epic's Log, retrospective rows to the archive only.
  const logs = new Map()
  const rows = []
  for (const row of board.rows) {
    const epicNumber = Number(/^(?:epic-)?(\d+)/u.exec(row.key)?.[1])
    const span = { source: boardPath, lines: [row.line, row.line], sha256: sha256(row.text) }
    if (/^epic-\d+-retrospective$/u.test(row.key)) { manifest.board.rows.push({ ...span, key: row.key, to: 'archive-only' }); continue }
    let status = STATUS_TABLE[row.status]
    if (status === undefined) throw new Error(`board row ${row.key}: status ${row.status} has no mapping`)
    if (/^epic-\d+$/u.test(row.key) && status !== 'done' && PARKED.test(row.comment)) status = 'paused'
    let note = row.comment
    if ([...note].length > NOTE_LIMIT) {
      if (!epicFile.has(epicNumber)) throw new Error(`board row ${row.key}: a long comment and no epic ${epicNumber} to keep it`)
      logs.set(epicNumber, [...(logs.get(epicNumber) ?? []), `- ${row.key} (board comment until ${date}): ${row.comment}`])
      note = `${status === 'paused' ? 'parked; ' : ''}board comment moved to the epic's Log ${date}`
    } else if (status === 'paused' && note === '') note = 'parked'
    rows.push({ key: row.key, status, note })
    manifest.board.rows.push({ ...span, key: row.key, to: 'status.yaml', from_status: row.status, status, comment_to: [...row.comment].length > NOTE_LIMIT ? epicFile.get(epicNumber) : 'status.yaml' })
  }
  // Reconcile what BMAD's board allowed and the format does not, each change recorded (Story 77.6, decided by the lead):
  // a deferred story of a done epic is dropped (its words stay in its note or the epic's Log); a story heading with no
  // row gets one; a row with no heading gets a heading stub appended to its legacy epic file.
  manifest.reconciled = []
  const epicStatus = new Map(rows.filter((row) => /^epic-\d+$/u.test(row.key)).map((row) => [Number(row.key.slice(5)), row.status]))
  for (const row of rows) {
    const number = Number(/^(\d+)-\d+/u.exec(row.key)?.[1])
    if (!Number.isFinite(number) || epicStatus.get(number) !== 'done' || row.status === 'done' || row.status === 'dropped') continue
    const before = row.status
    row.status = 'dropped'
    if (row.note === '' || !/defer/iu.test(row.note)) row.note = `deferred when epic ${number} was accepted; not planned`.slice(0, NOTE_LIMIT)
    manifest.reconciled.push({ key: row.key, change: `${before} -> dropped`, reason: 'a story of a done epic that was deferred' })
    const span = manifest.board.rows.find((entry) => entry.key === row.key)
    if (span) span.status = 'dropped'
  }
  const stubs = new Map()
  for (const epic of epics) {
    const headed = new Map([...epic.text.matchAll(/^### Story (\d+)\.(\d+)\b(.*)$/gmu)].map((match) => [`${Number(match[1])}.${Number(match[2])}`, match[3]]))
    for (const [id, rest] of headed) {
      if (Number(id.split('.')[0]) !== epic.number || rows.some((row) => /^(\d+)-(\d+)/u.exec(row.key)?.slice(1, 3).join('.') === id)) continue
      const title = rest.replace(/^:\s*/u, '').replace(/\s*\(dropped\)\s*$/iu, '')
      const key = `${id.replace('.', '-')}-${slugOf(title)}`
      const status = /\(dropped\)/iu.test(rest) ? 'dropped' : epicStatus.get(epic.number) === 'done' ? 'dropped' : 'backlog'
      // Placed after its epic's last row, so the owner's order is kept.
      const after = rows.findLastIndex((other) => Number(/^(?:epic-)?(\d+)/u.exec(other.key)?.[1]) === epic.number)
      rows.splice(after + 1, 0, { key, status, note: status === 'dropped' ? 'no board row before the move; dropped in the epic text' : 'no board row before the move' })
      manifest.reconciled.push({ key, change: `row added as ${status}`, reason: 'a story heading with no board row' })
    }
    for (const row of rows) {
      const match = /^(\d+)-(\d+)-(.*)$/u.exec(row.key)
      if (!match || Number(match[1]) !== epic.number || headed.has(`${Number(match[1])}.${Number(match[2])}`)) continue
      const title = match[3].split('-').join(' ')
      stubs.set(epic.number, [...(stubs.get(epic.number) ?? []), `### Story ${Number(match[1])}.${Number(match[2])}: ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\nRecorded on the board only before the move; its board note and this epic's Log hold what was done.`])
      manifest.reconciled.push({ key: row.key, change: 'heading stub appended to the epic file', reason: 'a board row with no story heading' })
    }
  }
  for (const other of board.other) if (other.text.trim() !== '') manifest.board.rows.push({ source: boardPath, lines: [other.line, other.line], sha256: sha256(other.text), to: 'history.md' })

  // Epic files: marker, links to shared text, the epic's own extension, the epic, then the moved board comments.
  for (const segment of segments) {
    if (segment.kind === 'front' || (segment.kind === 'extension' && segment.covers.length !== 1)) {
      const moved = moveText(segment.text, epicsPath, segment.file)
      write(segment.file, `${moved.text}\n`, moved.rewrites)
      manifest.spans.push({ source: epicsPath, lines: [segment.start + 1, segment.end], sha256: sha256(segment.text), to: segment.file })
    }
  }
  for (const epic of epics) {
    const path = epicFile.get(epic.number)
    const contracts = []
    const delegated = /`(docs\/epic-\d+-[\w.-]+\.md)`/u.exec(epic.text)
    if (delegated && /canonical|contract|delegat/iu.test(epic.text)) contracts.push(delegated[1])
    const shared = ['shared/front-matter.md']
    if (epic.extension && epic.extension.covers.length !== 1) shared.push(epic.extension.file)
    let head = `${MARKER(contracts)}\n<!-- shared text: ${shared.map((file) => `[${basename(file, '.md')}](../${file})`).join(', ')} -->\n\n`
    const parts = []
    if (epic.extension && epic.extension.covers.length === 1) parts.push(epic.extension)
    parts.push(epic)
    let body = ''
    const rewrites = []
    for (const part of parts) {
      const moved = moveText(part.text, epicsPath, path)
      for (const rewrite of moved.rewrites) rewrites.push({ ...rewrite, offset: rewrite.offset + head.length + body.length })
      body += `${moved.text}\n`
      manifest.spans.push({ source: epicsPath, lines: [part.start + 1, part.end], sha256: sha256(part.text), to: path })
    }
    const stub = stubs.get(epic.number)
    if (stub) body += `\n## Stories recorded on the board only (added at the move)\n\n${stub.join('\n\n')}\n`
    const log = logs.get(epic.number)
    if (log) body += `\n## Log\n\n${log.join('\n')}\n`
    write(path, `${head}${body}`, rewrites)
  }
  for (const [number, log] of logs) if (!epicFile.has(number)) throw new Error(`epic ${number}: comments without a file (${log.length})`)

  // Board header and stray lines verbatim in history.md; status.yaml from the table.
  const historyText = `# Board history\n\nThe old board's header, verbatim (moved ${date} from ${boardPath}).\n\n\`\`\`text\n${board.header.map((entry) => entry.text).join('\n')}\n${board.other.map((entry) => entry.text).join('\n')}\n\`\`\`\n`
  write('history.md', historyText)
  for (const entry of board.header) if (entry.text.trim() !== '') manifest.board.header.push({ source: boardPath, lines: [entry.line, entry.line], sha256: sha256(entry.text), to: 'history.md' })
  const statusText = [
    '# The project\'s board (BMN plan format, docs/planning.md). Edit by hand whenever you like; agents change one row with `bmn plan set`.',
    `# Moved from BMAD's sprint-status.yaml on ${date}: header history in history.md, long comments in each epic's Log, retrospective rows archived.`,
    'format: bmn-plan', 'schema_version: 1',
    '# The order of unfinished epics; every ready epic is here.',
    'queue: []',
    'development_status:',
    ...rows.map((row) => `  ${row.key}: ${row.status}${row.note ? ` # ${row.note}` : ''}`), ''
  ].join('\n')
  write('status.yaml', statusText)

  // Every other file under _bmad-output moves to references/ (links rewritten in markdown); _bmad and skills archive only.
  for (const file of inventory.files) {
    const place = placeOf(file.path)
    const entry = { path: file.path, sha256: file.sha256, bytes: file.bytes, link: file.link, to: place === null ? 'archive-only' : place }
    manifest.files.push(entry)
    if (place === null || file.path === epicsPath || file.path === boardPath) continue
    const target = join(stage, place)
    mkdirSync(dirname(target), { recursive: true })
    if (file.link !== null) { cpSync(join(repo, file.path), target, { verbatimSymlinks: true }); continue }
    if (file.path.endsWith('.md')) {
      const text = readFileSync(join(repo, file.path), 'utf8')
      const moved = moveText(text, file.path, place)
      write(place, moved.text, moved.rewrites)
    } else cpSync(join(repo, file.path), target)
  }

  write('PLAN.md', planText({ repo, segments, date, docs }))
  writeFileSync(join(dirname(stage), 'migration-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
  return manifest
}

/** PLAN.md, written from the front matter's overview, the standing rules and the index of docs/. */
export function planText({ repo, segments, date, docs }) {
  const front = segments.find((segment) => segment.kind === 'front').text
  const section = (name) => {
    const match = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mu').exec(front)
    return match ? match[1].trim() : ''
  }
  const overview = section('Overview')
  const shared = section('Shared Context and Completion Rules')
  const docList = docs ?? (existsSync(join(repo, 'docs')) ? readdirSync(join(repo, 'docs')).filter((name) => name.endsWith('.md')).sort().map((name) => `docs/${name}`) : [])
  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit).replace(/\s+\S*$/u, '')} … (whole text in shared/front-matter.md)` : text)
  return `# ${basename(repo)}: the plan

Moved from BMAD on ${date} (Story 77.6). The old front matter is kept whole in [shared/front-matter.md](shared/front-matter.md); every epic before ${date} is a legacy epic in \`epics/\`, its text verbatim. New epics use the format in \`docs/planning.md\`.

## Purpose

${clip(overview || 'See shared/front-matter.md.', 3000)}

## Users

- The owner: one person running many coding agents on his Linux laptop, who reads the board and answers what only he can decide.
- The agents (Claude Code, Codex, OpenCode) working in BMN sessions, which read BMN's brief and use \`bmn\`.

## Goals

- Agents can do the same or more; the owner sees, sets or presses less (Epic 75's test, kept by every epic since).
- Every finished epic is verified on the running build before it is called done.

## Non-goals

- Windows and macOS (Linux only; owner 2026-10-07; Epic 53 parked 2026-10-16).
- A new Preferences page, switch or setting for a feature an agent can use by itself (R75-NFR5).

## Success signals

- The owner's own use, counted read-only from BMN's database (the vault note's usage baseline).
- Delivered epics on \`main\`, installed with \`pnpm run update:desktop\`, with their owner checks passed.

## Standing constraints

${clip(shared || 'See shared/front-matter.md.', 5000)}

- The repository's \`AGENTS.md\` binds every agent; BMN's \`main\` is public, so this plan stays out of it (\`/plan/\` ignored) and keeps its history in its own local Git repository with no remote.

## Decisions

- The architecture and its decisions in force: [docs/architecture.md](../docs/architecture.md).
- Epic-level decisions are in each epic's Decisions or Extension text; the owner's cards and consultations are in \`references/\`.

## Truth documents

${docList.map((doc) => `- [${doc}](../${doc})`).join('\n')}
`
}

/** Check every span and file of the manifest against the staged plan, reversing the recorded link rewrites. */
export function checkSpans({ repo, stage, manifest }) {
  const failures = []
  const textOf = new Map()
  const unrewritten = (path) => {
    if (!textOf.has(path)) {
      const full = join(stage, path)
      textOf.set(path, existsSync(full) ? reverseRewrites(readFileSync(full, 'utf8'), manifest.rewrites[path] ?? []) : null)
    }
    return textOf.get(path)
  }
  const sourceLines = new Map()
  const linesOf = (path) => {
    if (!sourceLines.has(path)) sourceLines.set(path, readFileSync(join(repo, path), 'utf8').split('\n'))
    return sourceLines.get(path)
  }
  for (const span of [...manifest.spans, ...manifest.board.rows, ...manifest.board.header]) {
    const text = linesOf(span.source).slice(span.lines[0] - 1, span.lines[1]).join('\n')
    if (sha256(text) !== span.sha256) { failures.push(`${span.source}:${span.lines.join('-')} changed since the manifest`); continue }
    if (span.to === 'archive-only') continue
    if (span.to === 'status.yaml') {
      const target = span.comment_to
      const comment = /#[ \t]?(.*?)[ \t]*$/u.exec(text)?.[1] ?? ''
      if (target !== 'status.yaml' && !unrewritten(target)?.includes(comment)) failures.push(`${span.source}:${span.lines[0]} comment not found in ${target}`)
      const status = readFileSync(join(stage, 'status.yaml'), 'utf8')
      if (!status.includes(`  ${span.key}: ${span.status}`)) failures.push(`${span.key} not in status.yaml as ${span.status}`)
      continue
    }
    const holder = unrewritten(span.to)
    if (holder === null || !holder.includes(text)) failures.push(`${span.source}:${span.lines.join('-')} not found verbatim in ${span.to}`)
  }
  for (const file of manifest.files) {
    // A source that changed since the manifest was made means staging again (Story 77.7 AC1).
    let source = null
    try { source = lstatSync(join(repo, file.path)).isSymbolicLink() ? sha256(`link:${readlinkSync(join(repo, file.path))}`) : sha256(readFileSync(join(repo, file.path))) } catch { /* gone */ }
    if (source !== file.sha256) failures.push(`${file.path} changed since the manifest`)
    if (file.to === 'archive-only' || file.path.endsWith('epics.md') || file.path.endsWith('sprint-status.yaml')) continue
    const full = join(stage, file.to)
    if (file.link !== null) { if (!lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) failures.push(`${file.to} is not the link it was`); continue }
    const now = file.path.endsWith('.md') ? sha256(unrewritten(file.to) ?? '') : existsSync(full) ? sha256(readFileSync(full)) : null
    if (now !== file.sha256) failures.push(`${file.path} differs at ${file.to}`)
  }
  return failures
}

/** Copy the originals whole into the archive with a hash list, a README and restore steps; then verify it. */
export function archive({ repo, manifest, folder }) {
  if (existsSync(folder) && readdirSync(folder).length > 0) throw new Error(`${folder} is not empty: refusing to archive over it`)
  mkdirSync(join(folder, 'files'), { recursive: true })
  const roots = [...new Set(manifest.files.map((file) => file.path.split('/').slice(0, file.path.startsWith('.') ? 3 : 1).join('/')))]
  for (const root of roots) cpSync(join(repo, root), join(folder, 'files', root), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  writeFileSync(join(folder, 'SHA256SUMS'), manifest.files.map((file) => `${file.sha256}  ${file.path}${file.link !== null ? ` -> ${file.link}` : ''}`).join('\n') + '\n')
  writeFileSync(join(folder, 'README.md'), `# BMN's BMAD planning, archived ${manifest.date}

Byte-identical copies of everything BMN's move to its own plan format (Epic 77, Story 77.6) replaced:
${roots.map((root) => `- \`${root}\``).join('\n')}

\`SHA256SUMS\` lists every file with its hash (a link as \`link:<target>\`). \`migration-manifest.json\` maps each file and text span to its new place under \`plan/\`.

## Restore

From the BMN checkout (${repo}), with BMN's plan moved aside first if it should go:

    cp -a ${join(folder, 'files')}/. ${repo}/
    node ${repo}/scripts/plan/migrate-bmad-plan.mjs verify-archive --archive ${folder} --repo ${repo}

The second line checks every restored file against \`SHA256SUMS\`.
`)
  cpSync(join(dirname(manifest.stage), 'migration-manifest.json'), join(folder, 'migration-manifest.json'))
  return verifyTree({ root: join(folder, 'files'), manifest })
}

/** Every manifest file present under `root` with its hash. */
export function verifyTree({ root, manifest }) {
  const failures = []
  for (const file of manifest.files) {
    const full = join(root, file.path)
    let now = null
    try { now = lstatSync(full).isSymbolicLink() ? sha256(`link:${readlinkSync(full)}`) : sha256(readFileSync(full)) } catch { /* missing */ }
    if (now !== file.sha256) failures.push(`${file.path}: ${now === null ? 'missing' : 'differs'}`)
  }
  return failures
}

/** The rollback, rehearsed on a copy: remove the sources from a copy of the checkout's planning paths, restore from the archive, verify. */
export function rehearseRollback({ manifest, folder, scratch }) {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  execFileSync('cp', ['-a', `${join(folder, 'files')}/.`, `${scratch}/`])
  return verifyTree({ root: scratch, manifest })
}

// ---------------------------------------------------------------------------------------------

function flag(argv, name) { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1] }

async function main(argv) {
  const [action] = argv
  const repo = resolve(flag(argv, '--repo') ?? process.cwd())
  if (action === 'stage') {
    const stage = resolve(flag(argv, '--stage'))
    const manifest = stagePlan({ repo, stage, date: flag(argv, '--date') ?? undefined })
    const failures = checkSpans({ repo, stage, manifest })
    process.stdout.write(`${JSON.stringify({ files: manifest.files.length, archive_only: manifest.files.filter((file) => file.to === 'archive-only').length, spans: manifest.spans.length, board_rows: manifest.board.rows.length, rewrites: Object.values(manifest.rewrites).flat().length, unresolved: manifest.unresolved.length, span_failures: failures }, null, 1)}\n`)
    return failures.length === 0 ? 0 : 1
  }
  if (action === 'check') {
    const stage = resolve(flag(argv, '--stage'))
    const manifest = JSON.parse(readFileSync(join(dirname(stage), 'migration-manifest.json'), 'utf8'))
    const failures = checkSpans({ repo, stage, manifest })
    process.stdout.write(failures.length === 0 ? 'PASS: every file and span is at its mapped place\n' : `${failures.join('\n')}\n`)
    return failures.length === 0 ? 0 : 1
  }
  if (action === 'archive') {
    const stage = resolve(flag(argv, '--stage'))
    const folder = resolve(flag(argv, '--archive'))
    const manifest = JSON.parse(readFileSync(join(dirname(stage), 'migration-manifest.json'), 'utf8'))
    const failures = archive({ repo, manifest, folder })
    process.stdout.write(failures.length === 0 ? `PASS: archive ${folder} holds every file with its hash\n` : `${failures.join('\n')}\n`)
    return failures.length === 0 ? 0 : 1
  }
  if (action === 'verify-archive' || action === 'rehearse') {
    const folder = resolve(flag(argv, '--archive'))
    const manifest = JSON.parse(readFileSync(join(folder, 'migration-manifest.json'), 'utf8'))
    const failures = action === 'rehearse' ? rehearseRollback({ manifest, folder, scratch: resolve(flag(argv, '--scratch')) }) : verifyTree({ root: repo, manifest })
    process.stdout.write(failures.length === 0 ? `PASS: ${action === 'rehearse' ? 'restored copy' : repo} matches the archive's hashes\n` : `${failures.join('\n')}\n`)
    return failures.length === 0 ? 0 : 1
  }
  process.stderr.write('usage: migrate-bmad-plan.mjs stage|check|archive|verify-archive|rehearse --repo R [--stage S] [--archive A] [--scratch C] [--date D]\n')
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
