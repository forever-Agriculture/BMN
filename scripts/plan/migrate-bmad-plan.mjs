#!/usr/bin/env node
// MODULE: migrate-bmad-plan.mjs - Story 77.6: move a BMAD plan (epics.md, sprint-status.yaml, references) into BMN's plan/ format in a staging folder, with a manifest of every file and text span, a verified archive, a span check and a rehearsed rollback; the originals are never touched
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROW, rowToken, suggestedLeadHint, withLeadHint } from '../../apps/desktop/bin/plan-board.mjs'
import { FROM_BMAD as STATUS_TABLE } from '../../apps/desktop/bin/plan-statuses.mjs'

/**
 * The move, as Story 77.6 has it: nothing is lost. Every file under `_bmad-output/`, `_bmad/` and the apps'
 * `bmad-*` skill folders is listed with its hash and mapped to its new place or to the archive only; every text
 * span of `epics.md` and the board is mapped to the file that holds it. Epic text moves verbatim beneath a legacy
 * marker; the only change permitted is a link destination, each one recorded so the span check can reverse it.
 * Text several epics share (the front matter, an extension before more than one epic) moves verbatim to
 * `shared/`, linked from each epic it precedes. The board becomes `status.yaml` by an explicit status table.
 */
const NOTE_LIMIT = 160
const MARKER = (contracts) => `<!-- bmn-plan: bmad-legacy${contracts.length ? `; contracts: ${contracts.join(', ')}` : ''} -->`
const PARKED = /\bpark(?:ed|s)?\b/iu

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'epic'
const pad3 = (number) => String(number).padStart(3, '0')
const rowEpic = (key) => Number(/^(?:epic-)?(\d+)(?:[-.]|$)/u.exec(key)?.[1])

/** Every file under a folder, without following links; a link is listed as a link. */
function filesUnder(root, base = root) {
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
  // Platform contracts live outside _bmad-output; copy only epic documents, never product sources.
  for (const file of filesUnder(join(repo, 'docs/platform')).filter((file) => /^epic-\d+[-.].*\.md$/u.test(basename(file.path)))) files.push({ ...file, path: `docs/platform/${file.path}` })
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

/** The headings of a Markdown text outside code fences, in order. */
function headingsOf(text) {
  const out = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/u.test(line)) { fence = !fence; continue }
    if (fence) continue
    const heading = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line)
    if (heading) out.push(heading[1])
  }
  return out
}

/** The anchor GitHub gives a heading, numbered after an earlier heading of the same text (`counter` per file). */
function headingAnchor(heading, counter) {
  const base = heading.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /gu, '-')
  const seen = counter.get(base) ?? 0
  counter.set(base, seen + 1)
  return seen === 0 ? base : `${base}-${seen}`
}

/** Every anchor a Markdown text's headings give. */
function anchorsOf(text) {
  const counter = new Map()
  return new Set(headingsOf(text).map((heading) => headingAnchor(heading, counter)))
}

/** Markdown link destinations in a text: `](dest)` and `](dest "title")`, with their offsets. */
function linksIn(text) {
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
export function rewriteLinks(text, from, to, mapPath, exists, gone = null, repo = null) {
  const rewrites = []
  const unresolved = []
  let out = ''
  let last = 0
  for (const link of linksIn(text)) {
    const dest = link.dest
    // An absolute destination inside the repository is read like a relative one and keeps its absolute form.
    const inRepo = repo !== null && dest.startsWith(`${repo}/`)
    if (/^[a-z][a-z0-9+.-]*:/iu.test(dest) || (dest.startsWith('/') && !inRepo) || dest.startsWith('<')) continue
    const [pathPart, anchor] = dest.split('#', 2)
    let decoded
    try { decoded = decodeURI(pathPart) } catch { decoded = pathPart }
    // `#anchor` alone points into the text's own source file, which may now be split over several files.
    const target = pathPart === '' ? from : inRepo ? posix.normalize(decoded.slice(repo.length + 1)) : posix.normalize(posix.join(posix.dirname(from), decoded))
    let finalTarget = mapPath(target, anchor ?? null)
    if (finalTarget === null) {
      const present = exists(target) || exists(target.replace(/:\d+(?::\d+)?$/u, ''))
      // A link that resolves nowhere in the source either (a deleted file) goes to the note on targets that are gone, when one is kept.
      if (!present && gone !== null) finalTarget = gone(target, anchor ?? null, from)
      else if (!present) unresolved.push({ file: to, dest, broken_in_source: true })
    }
    finalTarget ??= target
    const targetPath = typeof finalTarget === 'string' ? finalTarget : finalTarget.path
    const anchorOut = typeof finalTarget === 'string' ? anchor : finalTarget.anchor
    let next
    if (typeof finalTarget !== 'string' && finalTarget.absolute) next = targetPath
    else if (inRepo) next = `${repo}/${targetPath}`
    else {
      next = targetPath === to && anchorOut ? '' : posix.relative(posix.dirname(to), targetPath)
      if (next === '' && !(targetPath === to && anchorOut)) next = posix.basename(targetPath)
    }
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
function parseBoard(text) {
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
export function stagePlan({ repo, stage, historyHead: pinnedHistoryHead = null, contextRepo = repo, date = new Date().toISOString().slice(0, 10), docs = null, vision = null, keepBmad = false, copyOwners = {}, archive: archiveFolder = join(homedir(), 'projects', `bmn-archive-${date}`) }) {
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
  const platformFiles = new Set(inventory.files.filter((file) => file.path.startsWith('docs/platform/')).map((file) => file.path))
  for (const number of new Set(board.rows.map((row) => rowEpic(row.key)).filter(Number.isFinite))) {
    if (epics.some((epic) => epic.number === number)) continue
    const candidates = inventory.files.filter((file) => new RegExp(`^epic-0*${number}[-.].*\\.md$`, 'u').test(basename(file.path)) && file.link === null)
      .map((file) => ({ ...file, text: readFileSync(join(repo, file.path), 'utf8') }))
      .sort((one, two) => [...two.text.matchAll(new RegExp(`^#{2,4} Story ${number}\\.`, 'gmu'))].length - [...one.text.matchAll(new RegExp(`^#{2,4} Story ${number}\\.`, 'gmu'))].length || one.path.localeCompare(two.path))
    const row = board.rows.find((row) => row.key === `epic-${number}`)
    const explicit = candidates.filter((file) => row?.comment.includes(file.path))
    if (explicit.length > 1) throw new Error(`epic ${number}: its row names multiple contracts; keep both and settle the canonical one before staging`)
    const established = candidates.filter(file => new RegExp(`^epic-${number}[-.]`, 'u').test(basename(file.path)))
    if (!explicit.length && !established.length && candidates.length > 1) throw new Error(`epic ${number}: multiple padded contracts; keep every input and name its canonical contract in the row before staging`)
    const found = explicit[0] ?? established[0] ?? candidates[0]
    const title = found ? basename(found.path, '.md').replace(new RegExp(`^epic-0*${number}-?`, 'u'), '') || `Epic ${number}` : `Recorded on the board ${number}`
    epics.push({ kind: 'epic', number, title, text: found?.text ?? `# Epic ${number}: ${title}\n\nRecorded on the old board only; its original comments are in history.md.\n`, source: found?.path ?? null, synthetic: !found, start: 0, end: found ? found.text.split('\n').length : 0 })
  }
  const epicFile = new Map(epics.map((epic) => [epic.number, `epics/${pad3(epic.number)}-${slugOf(epic.title)}.md`]))
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
    if (keepBmad && path.startsWith('_bmad-output/')) return null // Kept where it is; the plan links it.
    if (platformFiles.has(path)) return `references/platform/${path.slice('docs/platform/'.length)}`
    if (path === planning) return 'references'
    if (path.startsWith(`${planning}/`)) return `references/${path.slice(planning.length + 1)}`
    if (path.startsWith(`${implementation}/`)) return `references/implementation-artifacts/${path.slice(implementation.length + 1)}`
    if (path.startsWith('_bmad-output/')) return `references/${path.slice('_bmad-output/'.length)}`
    return null
  }
  const planRoot = 'plan'
  const inSource = target => inventory.roots.some(root => target === root || target.startsWith(root + '/')) || /^docs\/platform\/(?:.*\/)?epic-\d+[-.].*\.md$/u.test(target)
  const contextPath = target => existsSync(join(repo, target)) || inSource(target) ? join(repo, target) : join(contextRepo, target)
  const exists = (target) => existsSync(contextPath(target))
  const manifest = { version: 1, date, repo, context_repo: contextRepo, source_roots: inventory.roots, stage, archive: archiveFolder, keep_bmad: keepBmad, moved_from: boardPath, retired: keepBmad ? [] : inventory.roots, files: [], spans: [], rewrites: {}, unresolved: [], gone: [], board: { rows: [], header: [] }, written: {} }
  const retired = (target) => manifest.retired.some((root) => target === root || target.startsWith(`${root}/`))

  // Where each heading of epics.md lands: its anchor in epics.md, and the file and anchor it has after the move.
  const fileOfSegment = (segment) => segment.kind === 'epic' ? epicFile.get(segment.number) : segment.kind === 'extension' && segment.covers.length === 1 ? epicFile.get(segment.covers[0]) : segment.file
  const anchors = new Map()
  const documentCounter = new Map()
  const fileCounters = new Map()
  for (const segment of segments) {
    const file = fileOfSegment(segment)
    if (!fileCounters.has(file)) fileCounters.set(file, new Map())
    for (const heading of headingsOf(segment.text)) {
      const old = headingAnchor(heading, documentCounter)
      const placed = headingAnchor(heading, fileCounters.get(file))
      if (!anchors.has(old)) anchors.set(old, { file, anchor: placed })
    }
  }
  const sourceAnchors = new Map()
  const anchorExists = (target, anchor) => {
    if (!target.endsWith('.md') || !exists(target)) return true
    if (!sourceAnchors.has(target)) sourceAnchors.set(target, anchorsOf(readFileSync(contextPath(target), 'utf8')))
    let plain = anchor
    try { plain = decodeURIComponent(anchor) } catch { /* as written */ }
    return sourceAnchors.get(target).has(anchor) || sourceAnchors.get(target).has(plain)
  }
  // A link into epics.md goes to the file its heading moved to; any other moved file keeps its path under plan/.
  // An anchor that led nowhere before the move either is left out (the link goes to the file) and recorded.
  const mapPath = (named, anchor, from = null) => {
    // `file:120` names a line: the file is what moves; a line of epics.md goes to the file that holds it now.
    const [, target, line = ''] = /^(.*?)(:\d+(?::\d+)?)?$/u.exec(named)
    const dead = (path) => { manifest.gone.push({ kind: 'anchor', target, anchor, from }); return { path, anchor: '' } }
    if (target === epicsPath && line !== '') {
      const number = Number(line.slice(1).split(':')[0])
      const holder = segments.find((segment) => number > segment.start && number <= segment.end)
      return { path: `${planRoot}/${holder ? fileOfSegment(holder) : 'shared/front-matter.md'}`, anchor: anchor ?? '' }
    }
    if (target === epicsPath) {
      const placed = anchor ? anchors.get(anchor) : undefined
      if (placed) return { path: `${planRoot}/${placed.file}`, anchor: placed.anchor }
      const number = /^epic-(\d+)\b/u.exec(anchor ?? '')?.[1]
      if (number && epicFile.has(Number(number))) return { path: `${planRoot}/${epicFile.get(Number(number))}`, anchor: '' }
      return anchor ? dead(`${planRoot}/shared/front-matter.md`) : { path: `${planRoot}/shared/front-matter.md`, anchor: '' }
    }
    // A file that leaves with the retired folders (_bmad/, the apps' bmad-* skills) is linked at its archived copy.
    if (exists(target) && placeOf(target) === null && retired(target)) {
      const path = `${archiveFolder}/files/${target}${line}`
      return { ...(anchor && !anchorExists(target, anchor) ? dead(path) : { path, anchor: anchor ?? '' }), absolute: true }
    }
    // Only what exists moves; a path under _bmad-output that names nothing is a gone target.
    let place = exists(target) ? placeOf(target) : null
    // A folder link (a reference-* folder) moves with its folder.
    if (!keepBmad && place === null && target.startsWith(`${planning}/`) && exists(target)) place = `references/${target.slice(planning.length + 1)}`
    const path = place === null ? target : `${planRoot}/${place}`
    if (anchor && !anchorExists(target, anchor)) return dead(`${path}${line}`)
    return place === null ? null : `${path}${line}`
  }
  // Targets that were gone before the move (a deleted file, a document on another branch) are described in one note.
  const goneTargets = new Map()
  const goneNote = 'references/gone-link-targets.md'
  const gone = (target, anchor, from) => {
    if (!goneTargets.has(target)) goneTargets.set(target, { anchor: headingAnchor(target, new Map()), from: new Set() })
    goneTargets.get(target).from.add(from)
    manifest.gone.push({ kind: 'file', target, anchor, from })
    return { path: `${planRoot}/${goneNote}`, anchor: goneTargets.get(target).anchor }
  }

  const write = (path, text, rewrites = []) => {
    const full = join(stage, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
    if (rewrites.length) manifest.rewrites[path] = rewrites
    manifest.written[path] = sha256(text)
  }
  const moveText = (text, fromRepoPath, toPlanPath) => {
    const result = rewriteLinks(text, fromRepoPath, `${planRoot}/${toPlanPath}`, (target, anchor) => mapPath(target, anchor, fromRepoPath), exists, gone, contextRepo)
    manifest.unresolved.push(...result.unresolved.map((entry) => ({ ...entry, source: fromRepoPath })))
    return result
  }

  // Board rows: the status table, long comments to the epic's Log, retrospective rows to the archive only.
  const logs = new Map()
  const historyComments = []
  const rows = []
  for (const row of board.rows) {
    const epicNumber = rowEpic(row.key)
    const span = { source: boardPath, lines: [row.line, row.line], sha256: sha256(row.text) }
    if (/^epic-\d+-retrospective$/u.test(row.key)) { manifest.board.rows.push({ ...span, key: row.key, to: 'archive-only' }); continue }
    let status = STATUS_TABLE[row.status]
    if (status === undefined) throw new Error(`board row ${row.key}: status ${row.status} has no mapping`)
    if (/^epic-\d+$/u.test(row.key) && status !== 'done' && PARKED.test(row.comment)) status = 'paused'
    let note = row.comment
    let commentTo = 'status.yaml'
    if (status !== row.status) note = `${note}${note ? '; ' : ''}BMAD ${row.status}`
    if (['blocked', 'paused', 'dropped'].includes(status) && !note) note = `moved from BMAD ${row.status}`
    if ([...note].length > NOTE_LIMIT) {
      const orphan = !Number.isFinite(epicNumber) || epics.find((epic) => epic.number === epicNumber)?.synthetic
      commentTo = orphan ? 'history.md' : epicFile.get(epicNumber)
      if (orphan) historyComments.push(`- ${row.key} (original board comment): ${row.comment}`)
      else logs.set(epicNumber, [...(logs.get(epicNumber) ?? []), `- ${row.key} (board comment until ${date}): ${row.comment}`])
      note = `${status === 'paused' ? 'parked; ' : ''}board comment moved to ${orphan ? 'history.md' : "the epic's Log"} ${date}${status !== row.status ? `; BMAD ${row.status}` : ''}`
    } else if (status === 'paused' && note === '') note = 'parked'
    rows.push({ key: row.key, status, note })
    manifest.board.rows.push({ ...span, key: row.key, to: 'status.yaml', from_status: row.status, status, comment: row.comment, comment_to: commentTo })
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
    const span = manifest.board.rows.find((entry) => entry.key === row.key)
    // The owner's words stay: in the note when they fit beside the reason, else whole in the epic's Log.
    const reason = `deferred when epic ${number} was accepted`
    if (row.note === '') row.note = `${reason}; not planned`
    else if (!/defer/iu.test(row.note)) {
      if ([...`${reason}; ${row.note}`].length <= NOTE_LIMIT) row.note = `${reason}; ${row.note}`
      else {
        if (span?.comment_to === 'status.yaml') {
          logs.set(number, [...(logs.get(number) ?? []), `- ${row.key} (board comment until ${date}): ${span.comment}`])
          span.comment_to = epicFile.get(number)
        }
        row.note = `${reason}; board comment moved to the epic's Log ${date}`
      }
    }
    manifest.reconciled.push({ key: row.key, change: `${before} -> dropped`, reason: 'a story of a done epic that was deferred' })
    if (span) span.status = 'dropped'
  }
  const stubs = new Map()
  for (const epic of epics) {
    const headed = new Map([...epic.text.matchAll(/^#{2,4} Story (\d+)\.(\d+)\b(.*)$/gmu)].map((match) => [`${Number(match[1])}.${Number(match[2])}`, match[3]]))
    for (const [id, rest] of headed) {
      if (Number(id.split('.')[0]) !== epic.number || rows.some((row) => /^(\d+)-(\d+)/u.exec(row.key)?.slice(1, 3).join('.') === id)) continue
      const title = rest.replace(/^:\s*/u, '').replace(/\s*\(dropped\)\s*$/iu, '')
      const key = `${id.replace('.', '-')}-${slugOf(title)}`
      const status = /\(dropped\)/iu.test(rest) ? 'dropped' : epicStatus.get(epic.number) === 'done' ? 'dropped' : 'backlog'
      // Placed after its epic's last row, so the owner's order is kept.
      const after = rows.findLastIndex((other) => rowEpic(other.key) === epic.number)
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
  // The note each row ends with, which the span check holds status.yaml to.
  for (const row of rows.filter((row) => /^epic-\d+$/u.test(row.key) && !['done', 'dropped'].includes(row.status))) {
    const number = Number(row.key.slice(5)), epic = epics.find((epic) => epic.number === number)
    const hint = epic && suggestedLeadHint(epic.text)
    if (!hint) continue
    const next = withLeadHint(row.note, hint).note
    if (next !== row.note) {
      const original = manifest.board.rows.find((entry) => entry.key === row.key)
      if (original?.comment && original.comment_to === 'status.yaml') {
        logs.set(number, [...(logs.get(number) ?? []), `- ${row.key} (original board comment): ${original.comment}`])
        original.comment_to = epicFile.get(number)
      }
      row.note = next
    }
  }
  const finalNotes = new Map(rows.map((row) => [row.key, row.note]))
  for (const entry of manifest.board.rows) if (entry.to === 'status.yaml') entry.note = finalNotes.get(entry.key) ?? ''
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
    const contracts = epic.source ? [epic.source] : []
    // Cited as `docs/…` or as a Markdown link to it (Epic 53's form).
    const delegated = /(?:`|\]\((?:\.\.\/)*)(docs\/epic-\d+-[\w.-]+\.md)/u.exec(epic.text)
    if (delegated && /canonical|contract|delegat/iu.test(epic.text)) contracts.push(delegated[1])
    const shared = ['shared/front-matter.md']
    if (epic.extension && epic.extension.covers.length !== 1) shared.push(epic.extension.file)
    let head = `${MARKER(contracts)}\n<!-- shared text: ${shared.map((file) => `[${basename(file, '.md')}](../${file})`).join(', ')} -->\n\n`
    if (!/^#{1,2} Epic \d+\b/mu.test(epic.text)) head += `# Epic ${epic.number}: ${epic.title}\n\n`
    const parts = []
    if (epic.extension && epic.extension.covers.length === 1) parts.push(epic.extension)
    parts.push(epic)
    let body = ''
    const rewrites = []
    for (const part of parts) {
      const moved = moveText(part.text, part.source ?? epicsPath, path)
      for (const rewrite of moved.rewrites) rewrites.push({ ...rewrite, offset: rewrite.offset + head.length + body.length })
      body += `${moved.text}\n`
      if (!part.synthetic) manifest.spans.push({ source: part.source ?? epicsPath, lines: [part.start + 1, part.end], sha256: sha256(part.text), to: path })
    }
    const stub = stubs.get(epic.number)
    if (stub) body += `\n## Stories recorded on the board only (added at the move)\n\n${stub.join('\n\n')}\n`
    const log = logs.get(epic.number)
    if (log) body += `\n## Log\n\n${log.join('\n')}\n`
    write(path, `${head}${body}`, rewrites)
  }
  for (const [number, log] of logs) if (!epicFile.has(number)) throw new Error(`epic ${number}: comments without a file (${log.length})`)

  // Board header and stray lines verbatim in history.md; status.yaml from the table.
  const historyText = `# Board history\n\nThe old board's header, verbatim (moved ${date} from ${boardPath}).\n\n\`\`\`text\n${board.header.map((entry) => entry.text).join('\n')}\n${board.other.map((entry) => entry.text).join('\n')}\n\`\`\`\n\n${historyComments.join('\n')}\n`
  write('history.md', historyText)
  for (const entry of board.header) if (entry.text.trim() !== '') manifest.board.header.push({ source: boardPath, lines: [entry.line, entry.line], sha256: sha256(entry.text), to: 'history.md' })
  // Only explicit original exceptions receive legacy identities. New rows retain strict numeric checks.
  const identities = new Set(), legacyRows = Object.create(null)
  for (const row of rows) {
    const epic = /^epic-(\d+)$/u.exec(row.key), story = /^(\d+)-(\d+)(?:-|$)/u.exec(row.key)
    const identity = epic ? `epic ${Number(epic[1])}` : story ? `story ${Number(story[1])}.${Number(story[2])}` : null
    const opaque = !/^(?:epic-)?\d+(?:[-.]|$)/u.test(row.key)
    if (opaque || (identity !== null && identities.has(identity))) {
      const original = manifest.board.rows.find((entry) => entry.key === row.key)
      if (!original) throw new Error(`legacy row ${row.key} has no original board span`)
      legacyRows[row.key] = { original_key: row.key, source_line: original.lines[0], source_sha256: original.sha256, reason: opaque ? 'opaque original identifier' : 'distinct original row sharing a numeric identifier' }
    } else if (identity !== null) identities.add(identity)
  }
  if (Object.keys(legacyRows).length) write('legacy-rows.json', JSON.stringify({ version: 1, source_board: boardPath, rows: legacyRows }, null, 2) + '\n')
  let historyHead = pinnedHistoryHead
  if (!historyHead) try { historyHead = execFileSync('git', ['-C', contextRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* a stage without history grants no historical approval */ }
  write('migration.json', JSON.stringify({ version: 1, source_board: boardPath, history_head: historyHead, source_board_sha256: sha256(boardText) }, null, 2) + '\n')
  const statusText = [
    '# The project\'s board (BMN plan format, docs/planning.md). Edit by hand whenever you like; agents change one row with `bmn plan set`.',
    `# Moved from BMAD's sprint-status.yaml on ${date}: header history in history.md, long comments in each epic's Log, retrospective rows archived.`,
    'format: bmn-plan', 'schema_version: 1',
    `bmad_board: ${boardPath}`, `moved_from: ${boardPath}`,
    ...(Object.keys(legacyRows).length ? ['legacy_rows: legacy-rows.json'] : []),
    ...(keepBmad ? ['bmad_copy: true'] : []),
    ...['run_needs', 'prepared', 'prepared_items', 'challenges'].map((rule) => `rules_from_${rule}: ${epics.length ? Math.min(...epics.map((epic) => epic.number)) : 1}`),
    '# The order of unfinished epics; every ready epic is here.',
    ...(rows.some((row) => /^epic-\d+$/u.test(row.key) && row.status === 'ready') ? ['queue:', ...rows.filter((row) => /^epic-\d+$/u.test(row.key) && row.status === 'ready').map((row) => `  - ${row.key.slice(5)}`)] : ['queue: []']),
    'development_status:',
    ...rows.map((row) => `  ${row.key}: ${row.status}${row.note ? ` # ${row.note}` : ''}`), ''
  ].join('\n')
  write('status.yaml', statusText)
  if (keepBmad) {
    const attributed = new Map()
    try {
      const blamed = execFileSync('git', ['-C', contextRepo, 'blame', '--line-porcelain', '--contents', '-', '--', boardPath], { input: boardText, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] })
      let commit = null, author = null, line = null
      for (const text of blamed.split('\n')) {
        const head = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/u.exec(text)
        if (head) { commit = head[1]; line = Number(head[2]); author = null }
        else if (text.startsWith('author ')) author = text.slice(7)
        else if (text.startsWith('\t')) attributed.set(line, { author, commit })
      }
    } catch { /* Missing or uncertain attribution parks activation; never infer non-Artem ownership. */ }
    const copy = { version: 1, active: false, source_board: boardPath, rows: Object.create(null), excluded: Object.create(null), unresolved: Object.create(null) }
    if (pinnedHistoryHead) {
      // D10 on a branch cut from upstream: who last changed the target line there, and what that line holds. A row absent there stays in his plan only.
      const target = new Map()
      const git = args => execFileSync('git', ['-C', contextRepo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      let section = false, author = null, commit = null, sourceLine = null
      for (const text of git(['blame', '--line-porcelain', pinnedHistoryHead, '--', boardPath]).split('\n')) {
        const head = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/u.exec(text)
        if (head) { commit = head[1]; sourceLine = Number(head[2]); author = null }
        else if (text.startsWith('author ')) author = text.slice(7)
        else if (text.startsWith('\t')) {
          const line = text.slice(1).replace(/\r$/u, '')
          if (/^\S/u.test(line) && !line.startsWith('#')) section = /^development_status:/u.test(line)
          const row = section && ROW.exec(line)
          if (row) target.set(row[1], { status: row[2], note: row[3] ?? '', author, commit, line: sourceLine, sha256: sha256(line) })
        }
      }
      copy.plan_only = []
      for (const row of rows) {
        const line = target.get(row.key)
        if (!line) { copy.plan_only.push(row.key); continue }
        const provenance = { author: line.author, commit: line.commit, history_head: pinnedHistoryHead, source_line: line.line, row_sha256: line.sha256 }
        if (/\bartem\b/iu.test(line.author ?? '')) copy.excluded[row.key] = provenance
        else copy.rows[row.key] = { last_copied: { status: line.status, note: line.note }, source_token: rowToken(row.key, row.status, row.note), provenance }
      }
    } else
    for (const row of board.rows.filter(row => rows.some(mapped => mapped.key === row.key))) {
      const mapped = rows.find(mapped => mapped.key === row.key), supplied = Object.hasOwn(copyOwners, row.key) ? copyOwners[row.key] : null, original = attributed.get(row.line)
      let provenance = { ...original, repository: contextRepo, history_head: historyHead, source_line: row.line, row_sha256: sha256(row.text) }
      if (supplied) {
        if (supplied.row_sha256 !== provenance.row_sha256 || typeof supplied.author !== 'string' || !supplied.author.trim() || typeof supplied.evidence !== 'string' || !supplied.evidence.trim()) throw new Error(`COPY_PROVENANCE_INVALID: ${row.key} handover does not prove the exact captured row`)
        provenance = { ...provenance, author: supplied.author, evidence: supplied.evidence, commit: null }
      }
      if (!provenance.author || provenance.author === 'Not Committed Yet' || (!provenance.evidence && (!provenance.commit || /^0+$/u.test(provenance.commit)))) copy.unresolved[row.key] = provenance
      else if (/\bartem\b/iu.test(provenance.author)) copy.excluded[row.key] = provenance
      else copy.rows[row.key] = { last_copied: { status: row.status, note: row.comment }, source_token: rowToken(mapped.key, mapped.status, mapped.note), provenance }
    }
    manifest.copy = copy
    write('bmad-copy.json', JSON.stringify(copy, null, 2) + '\n')
  }

  // Every other file under _bmad-output moves to references/ (links rewritten in markdown); _bmad and skills archive only.
  // A project that keeps BMAD keeps those files in place: they are listed and hashed, never copied.
  for (const file of inventory.files) {
    const place = placeOf(file.path)
    const entry = { path: file.path, sha256: file.sha256, bytes: file.bytes, link: file.link, to: place !== null ? place : keepBmad && file.path.startsWith('_bmad-output/') ? 'linked' : 'archive-only' }
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

  if (goneTargets.size > 0 || manifest.gone.length > 0) write(goneNote, goneLinkTargets({ repo: contextRepo, date, targets: goneTargets, anchors: manifest.gone.filter((entry) => entry.kind === 'anchor') }))
  // The foundation every plan builds on (owner 2026-10-17): the owner-approved vision when given, else a draft he approves
  // before the switch (Story 77.7), every principle marked provisional.
  const visionText = vision === null ? visionDraft({ repo: contextRepo, segments, date }) : readFileSync(vision, 'utf8')
  write('VISION.md', visionText)
  write('PLAN.md', planText({ repo: contextRepo, date, docs, vision: visionText, provisional: vision === null, rows, keepBmad }))
  writeFileSync(join(dirname(stage), 'migration-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
  return manifest
}

/** The note the links whose targets were gone before the move point to: each path, where it last was, who linked it. */
function goneLinkTargets({ repo, date, targets, anchors }) {
  const lastSeen = (named) => {
    const path = named.replace(/:\d+(?::\d+)?$/u, '')
    try {
      const commit = execFileSync('git', ['-C', repo, 'log', '--all', '-1', '--format=%h', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (commit === '') return null
      for (const candidate of [commit, `${commit}^`]) {
        try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${candidate}:${path}`], { stdio: 'ignore' }); return candidate } catch { /* not there */ }
      }
    } catch { /* no history */ }
    return null
  }
  const sections = [...targets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => {
    const commit = lastSeen(path)
    const meant = path.startsWith('_bmad-output/') && existsSync(join(repo, path.slice('_bmad-output/'.length).replace(/:\d+(?::\d+)?$/u, ''))) ? ` The repository has \`${path.slice('_bmad-output/'.length)}\`; the link was likely meant for it.` : ''
    return `## ${path}\n\n${commit === null ? 'Not found in this repository\'s history.' : `Last in this repository's history at commit ${commit}: \`git show ${commit}:${path}\`.`}${meant}\n\nLinked from: ${[...entry.from].sort().map((from) => `\`${from}\``).join(', ')}.\n`
  })
  const anchorLines = anchors.map((entry) => `- \`${entry.target}#${entry.anchor}\`, linked from \`${entry.from}\`: no such heading there before the move; the link now opens the file.`)
  return `# Link targets that were gone before the move

The planning text linked these paths, but they already led nowhere before the format move on ${date}: the file had been removed, or it lives on another branch. Each such link now points here; the text around it is unchanged, and the migration manifest records every rewrite so its span check reverses them.

${sections.join('\n')}${anchorLines.length ? `\n## Anchors that were gone\n\n${[...new Set(anchorLines)].join('\n')}\n` : ''}`
}

/** PLAN.md: today's purpose and scope from the vision and the board, the standing rules, and the index of docs/; the old front matter stays history in shared/. */
function planText({ repo, date, docs, vision = '', provisional = false, rows = [], keepBmad = false }) {
  const visionLead = /^## Vision\s*\n+([\s\S]*?)(?:\n\s*\n|\n## |$(?![\s\S]))/mu.exec(vision)?.[1]?.replace(/\s+/gu, ' ').trim() ?? ''
  const epics = rows.filter((row) => /^epic-\d+$/u.test(row.key)).map((row) => ({ number: Number(row.key.slice(5)), status: row.status }))
  const numbers = epics.map((epic) => epic.number)
  const done = epics.filter((epic) => epic.status === 'done' || epic.status === 'dropped').length
  const docList = docs ?? (existsSync(join(repo, 'docs')) ? readdirSync(join(repo, 'docs')).filter((name) => name.endsWith('.md')).sort().map((name) => `docs/${name}`) : [])
  return `# ${basename(repo)}: the plan

Moved from BMAD on ${date}. Every epic before ${date} is a legacy epic in \`epics/\`, its text verbatim; new epics use the format in \`docs/planning.md\`. The old planning's front matter, written for its first epics, is kept whole as history in [shared/front-matter.md](shared/front-matter.md).

## Purpose

${visionLead || 'See VISION.md.'}${provisional ? ' (The vision is a draft until the owner approves it.)' : ''}

${keepBmad ? 'The epic text and board are copied here. Every other planning document stays where it was, in [`_bmad-output/`](../_bmad-output/), and the epics link it there.\n\n' : ''}The principles every epic serves are in [VISION.md](VISION.md). The plan holds ${numbers.length ? `epics ${Math.min(...numbers)}–${Math.max(...numbers)}` : 'no epics yet'}: ${done} finished (done or dropped) and ${epics.length - done} not, each with its row in [status.yaml](status.yaml); the queue says what comes next.

## Users

- The project's users and their requirements remain as recorded in [the original context](shared/front-matter.md) and each epic.
- The owner and agents use this board to coordinate implementation; the format move changes no product role.

## Goals

- Preserve the original goals, requirements and acceptance criteria in the linked legacy contracts.
- Verify each outcome on its affected running path before recording it done.

## Non-goals

- Changing product behavior, architecture or platform support as part of this format move.
- Re-approving an epic or renewing its spent rounds and money by moving it.

## Success signals

- Every original file, board row and text span is accounted for by the move's manifest.
- Outcomes and delivery remain those of the original epics; the format supplies no new acceptance.

## Standing constraints

- The repository's ${existsSync(join(repo, 'AGENTS.md')) ? '[AGENTS.md](../AGENTS.md)' : '`AGENTS.md`'} and original project instructions bind every agent; delivery follows its current BMN repository policy.
- Planning uses the \`plan\` skill and this format: \`bmn plan check\` passes before work starts, and agents change one board row with \`bmn plan set\`.
- Runtime behavior counts as verified only after the affected flow ran on the running build; tests, fixtures and screenshots use synthetic data, never private session content.
- This plan follows the product repository's existing tracking and delivery policy; an ignored plan keeps its own local history.
- The rules the legacy epics were written under stay with them, in [shared/front-matter.md](shared/front-matter.md).

## Architecture

${existsSync(join(repo, 'docs', 'architecture.md'))
    ? 'Project architecture: [docs/architecture.md](../docs/architecture.md). Its contents and verification labels remain authoritative; the format move adds no architectural claims.'
    : 'None recorded at the move: write it with the plan skill\'s architecture method before the next epic.'}

## Decisions

- The architecture's decisions in force are recorded with it (Architecture above).
- Epic-level decisions are in each epic's Decisions or Extension text; the owner's cards and consultations are in \`references/\`.

## Truth documents

${docList.map((doc) => `- [${doc}](../${doc})`).join('\n')}
`
}

/** VISION.md as the move drafts it when no approved vision is given: the overview as the vision, and the goals the plan already holds as provisional principles. */
function visionDraft({ repo, segments, date }) {
  const front = segments.find((segment) => segment.kind === 'front')?.text ?? ''
  const overview = new RegExp('^## Overview\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'mu').exec(front)?.[1].trim() ?? ''
  const first = overview.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? ''
  return `# ${basename(repo)}: vision

*Draft written by the format move on ${date}. The owner approves it, or replaces it, before the switch; until then every principle is provisional.*

## Vision

${first || 'See PLAN.md Purpose.'}

## Principles

1. **Keep the original project contract.** The goals and constraints in [shared/front-matter.md](shared/front-matter.md) and each legacy epic remain unchanged. *provisional* (the format move's preservation goal)

## Log

- ${date}: drafted by the move; waiting for the owner's approval.
`
}

/** Check every span and file of the manifest against the staged plan, reversing the recorded link rewrites. */
export function checkSpans({ repo, stage, manifest }) {
  const failures = []
  let rows = null
  const stagedRows = () => {
    rows ??= new Map(parseBoard(readFileSync(join(stage, 'status.yaml'), 'utf8')).rows.map((row) => [row.key, { status: row.status, note: row.comment }]))
    return rows
  }
  // A source the manifest does not list would be lost at the switch: staging again is the only way on.
  const listed = new Set(manifest.files.map((file) => file.path))
  for (const file of sources(repo).files) if (!listed.has(file.path)) failures.push(`${file.path} is not in the manifest (new since staging): stage again`)
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
      const comment = /^ {2}[\w.-]+:[ \t]*[\w-]+[ \t]*(?:#[ \t]?(.*?))?[ \t]*$/u.exec(text)?.[1] ?? ''
      const row = stagedRows().get(span.key)
      if (row === undefined) { failures.push(`${span.key} is not in status.yaml`); continue }
      if (row.status !== span.status) failures.push(`${span.key} is ${row.status} in status.yaml, not ${span.status}`)
      if (span.note !== undefined && row.note !== span.note) failures.push(`${span.key}'s note in status.yaml is not the one the move wrote`)
      // The owner's comment survives whole: in the row's note, or in the file it moved to.
      const holder = span.comment_to !== 'status.yaml' ? unrewritten(span.comment_to) : null
      if (comment !== '' && !row.note.includes(comment) && !holder?.includes(comment)) failures.push(`${span.source}:${span.lines[0]} comment of ${span.key} is in neither its note nor ${span.comment_to}`)
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
    if (file.to === 'archive-only' || file.to === 'linked' || file.path.endsWith('epics.md') || file.path.endsWith('sprint-status.yaml')) continue
    const full = join(stage, file.to)
    if (file.link !== null) { if (!lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) failures.push(`${file.to} is not the link it was`); continue }
    const now = file.path.endsWith('.md') ? sha256(unrewritten(file.to) ?? '') : existsSync(full) ? sha256(readFileSync(full)) : null
    if (now !== file.sha256) failures.push(`${file.path} differs at ${file.to}`)
  }
  failures.push(...checkLinks({ repo, stage, manifest }))
  return failures
}

/** Every relative link of every Markdown file the move wrote resolves: its file, and its anchor among that file's headings. */
export function checkLinks({ repo, stage, manifest }) {
  const failures = []
  const anchorCache = new Map()
  const archived = `${manifest.archive ?? join(homedir(), 'projects', `bmn-archive-${manifest.date}`)}/files/`
  const roots = manifest.retired ?? ['_bmad-output', '_bmad']
  const listed = new Set(manifest.files.map((file) => file.path))
  const archiveRoot = archived.slice(0, -1)
  const recordedLinks = new Set(manifest.files.filter((file) => file.link !== null).map((file) => file.path))
  // An archive link must name a plain path through no link at all: the manifest's links before archiving, the
  // archive's own after. Following links is not needed for BMAD's files and is where escapes hide (Sol F5).
  const throughLink = (inner) => inner.split('/').some((_, at, parts) => {
    const prefix = parts.slice(0, at + 1).join('/')
    return recordedLinks.has(prefix) || Boolean(existsSync(archiveRoot) && lstatSync(join(archiveRoot, prefix), { throwIfNoEntry: false })?.isSymbolicLink())
  })
  // The layout after the switch: plan/ is the stage, and every retired root is gone even while it still exists.
  const resolveFile = (target) => {
    if (target === 'plan' || target.startsWith('plan/')) return join(stage, target.slice(5))
    const captured = (manifest.source_roots ?? []).some(root => target === root || target.startsWith(root + '/')) || /^docs\/platform\/(?:.*\/)?epic-\d+[-.].*\.md$/u.test(target)
    return existsSync(join(repo, target)) || captured ? join(repo, target) : join(manifest.context_repo ?? repo, target)
  }
  for (const path of Object.keys(manifest.written).filter((name) => name.endsWith('.md'))) {
    const at = `plan/${path}`
    const text = readFileSync(join(stage, path), 'utf8')
    for (const link of linksIn(text)) {
      const dest = link.dest
      const linkRepo = manifest.context_repo ?? repo
      const inRepo = dest.startsWith(`${linkRepo}/`)
      if (dest.startsWith(archived)) {
        // An archived copy: in the verified archive once it exists, else a file the manifest archives.
        const [innerPart, anchor] = dest.slice(archived.length).split('#', 2)
        let inner = innerPart
        try { inner = decodeURI(inner) } catch { /* as written */ }
        inner = inner.replace(/:\d+(?::\d+)?$/u, '')
        if (inner.split('/').some((part) => part === '' || part === '.' || part === '..')) { failures.push(`${at}: link ${dest} is not a plain path into the archive`); continue }
        if (throughLink(inner)) { failures.push(`${at}: link ${dest} passes through a link`); continue }
        const there = existsSync(archiveRoot) ? existsSync(join(archiveRoot, inner)) : listed.has(inner) || [...listed].some((file) => file.startsWith(`${inner}/`))
        if (!there) { failures.push(`${at}: link ${dest} names nothing in the archive`); continue }
        if (!anchor || !inner.endsWith('.md')) continue
        const full = existsSync(archiveRoot) ? join(archiveRoot, inner) : join(repo, inner)
        if (!anchorCache.has(full)) anchorCache.set(full, anchorsOf(readFileSync(full, 'utf8')))
        let plain = anchor
        try { plain = decodeURIComponent(anchor) } catch { /* as written */ }
        if (!anchorCache.get(full).has(anchor) && !anchorCache.get(full).has(plain)) failures.push(`${at}: link ${dest} names no heading of ${inner}`)
        continue
      }
      if (/^[a-z][a-z0-9+.-]*:/iu.test(dest) || (dest.startsWith('/') && !inRepo) || dest.startsWith('<')) continue
      const [pathPart, anchor] = dest.split('#', 2)
      let decoded
      try { decoded = decodeURI(pathPart) } catch { decoded = pathPart }
      const target = pathPart === '' ? at : inRepo ? posix.normalize(decoded.slice(linkRepo.length + 1)) : posix.normalize(posix.join(posix.dirname(at), decoded))
      const gone = roots.find((root) => target === root || target.startsWith(`${root}/`))
      if (gone !== undefined) { failures.push(`${at}: link ${dest} points into ${gone}, which leaves at the switch`); continue }
      let full = resolveFile(target)
      if (!existsSync(full)) full = resolveFile(target.replace(/:\d+(?::\d+)?$/u, ''))
      if (!existsSync(full)) { failures.push(`${at}: link ${dest} leads nowhere`); continue }
      if (!anchor || !full.endsWith('.md')) continue
      if (!anchorCache.has(full)) anchorCache.set(full, anchorsOf(readFileSync(full, 'utf8')))
      let plain = anchor
      try { plain = decodeURIComponent(anchor) } catch { /* as written */ }
      if (!anchorCache.get(full).has(anchor) && !anchorCache.get(full).has(plain)) failures.push(`${at}: link ${dest} names no heading of ${target}`)
    }
  }
  return failures
}

/** Copy the originals whole into the archive with a hash list, a README and restore steps; then verify it. */
export function archive({ repo, manifest, folder }) {
  if (existsSync(folder) && readdirSync(folder).length > 0) throw new Error(`${folder} is not empty: refusing to archive over it`)
  mkdirSync(join(folder, 'files'), { recursive: true })
  const archived = manifest.files.filter((file) => file.to !== 'linked')
  const roots = [...new Set(archived.map((file) => file.path.split('/').slice(0, file.path.startsWith('.') ? 3 : 1).join('/')))]
  for (const file of archived) {
    const target = join(folder, 'files', file.path)
    mkdirSync(dirname(target), { recursive: true })
    const source = join(repo, file.path)
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target)
    else cpSync(source, target, { preserveTimestamps: true })
  }
  writeFileSync(join(folder, 'SHA256SUMS'), archived.map((file) => `${file.sha256}  ${file.path}${file.link !== null ? ` -> ${file.link}` : ''}`).join('\n') + '\n')
  writeFileSync(join(folder, 'README.md'), `# BMAD planning, archived ${manifest.date}

Byte-identical copies of every input to this project's move to BMN's plan format:
${roots.map((root) => `- \`${root}\``).join('\n')}

\`SHA256SUMS\` lists every file with its hash (a link as \`link:<target>\`). \`migration-manifest.json\` maps each file and text span to its new place under \`plan/\`.

## Restore

From the product checkout (${repo}), with BMN's plan moved aside first if it should go:

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
    if (file.to === 'linked') continue // It never left its place.
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

/** A separate normalization edit: retain story bodies and existing instructions; caller supplies missing planning facts. */
export function normalizeEpic({ path, additions = {} }) {
  const before = readFileSync(path, 'utf8')
  if (!/^<!--\s*bmn-plan:\s*bmad-legacy\b/mu.test(before)) throw new Error('epic is already normalized')
  const stories = (text) => [...text.matchAll(/^#{2,4} Story (\d+\.\d+)[^\n]*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/gmu)].map((match) => [match[1], match[2]])
  const originalStories = stories(before)
  let text = before.replace(/^<!--\s*bmn-plan:\s*bmad-legacy[^\n]*\n/mu, '')
    .replace(/^# Epic (\d+)\s*[—–-]\s*/gmu, '# Epic $1: ')
    .replace(/^## \d+\.\s*/gmu, '## ')
    .replace(/^## Boundary and order\s*$/gmu, '## Boundary and dependencies')
    .replace(/^#{2,4} Story /gmu, '### Story ')
  const missing = []
  for (const section of ['Outcome', 'Why', 'Boundary and dependencies', 'Run needs', 'Truth impact', 'Challenges']) {
    if (new RegExp(`^## ${section}\\s*$`, 'mu').test(text)) continue
    if (typeof additions[section] !== 'string' || !additions[section].trim()) throw new Error(`missing normalization content for ${section}`)
    missing.push(`## ${section}\n\n${additions[section].trim()}\n\n`)
  }
  if (!/^## Stories\s*$/mu.test(text)) throw new Error('normalization needs an existing Stories section')
  text = text.replace(/^## Stories\s*\n/mu, missing.join('') + '## Stories\n')
  const needs = /^## Run needs\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(text)
  if (!/\*\*Prepared:/u.test(needs[1])) {
    if (typeof additions.Prepared !== 'string' || !additions.Prepared.trim()) throw new Error('missing normalization content for Prepared')
    text = text.replace(needs[0], needs[0].trimEnd() + `\n- **Prepared:** ${additions.Prepared.trim()}\n\n`)
  }
  if (JSON.stringify(stories(text)) !== JSON.stringify(originalStories)) throw new Error('normalization would change a story body')
  const temporary = `${path}.normalize-${process.pid}.tmp`
  try {
    writeFileSync(temporary, text, { mode: statSync(path).mode & 0o777 })
    if (readFileSync(path, 'utf8') !== before) throw new Error('epic changed during normalization')
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return { before_sha256: sha256(before), after_sha256: sha256(text), story_sha256: sha256(JSON.stringify(originalStories)), story_bytes_unchanged: true }
}

// ---------------------------------------------------------------------------------------------

function flag(argv, name) { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1] }

async function main(argv) {
  const [action] = argv
  const repo = resolve(flag(argv, '--repo') ?? process.cwd())
  if (action === 'cutover' || action === 'rollback') {
    const handoverPath = flag(argv, '--handover')
    if (!handoverPath) throw new Error('--handover FILE is required; an unverified writer inventory cannot switch a plan')
    const handover = JSON.parse(readFileSync(resolve(handoverPath), 'utf8'))
    const tools = await import('./plan-cutover.mjs')
    const result = action === 'rollback' ? await tools.rollbackPlan({ repo, handover }) : await tools.cutoverPlan({ repo, handover, upstream: flag(argv, '--upstream') ?? undefined, keepBmad: argv.includes('--keep-bmad'), vision: flag(argv, '--vision'), date: flag(argv, '--date') ?? undefined })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.outcome === 'parked' ? 1 : 0
  }
  if (action === 'normalize') {
    const path = resolve(flag(argv, '--file')), additions = JSON.parse(readFileSync(resolve(flag(argv, '--spec')), 'utf8'))
    process.stdout.write(JSON.stringify(normalizeEpic({ path, additions }), null, 2) + '\n')
    return 0
  }
  if (action === 'stage') {
    const stage = resolve(flag(argv, '--stage'))
    const manifest = stagePlan({ repo, stage, date: flag(argv, '--date') ?? undefined, vision: flag(argv, '--vision'), keepBmad: argv.includes('--keep-bmad'), ...(flag(argv, '--archive') ? { archive: resolve(flag(argv, '--archive')) } : {}) })
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
  process.stderr.write('usage: migrate-bmad-plan.mjs stage|check|archive|verify-archive|rehearse|cutover|rollback|normalize --repo R [--stage S] [--archive A] [--scratch C] [--handover H] [--upstream REF] [--date D] [--vision V]\n')
  return 2
}

// Finish module initialization before cutover imports this module's staging exports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error); process.exitCode = 1 })
}
