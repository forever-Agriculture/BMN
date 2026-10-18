// MODULE: quick-look-search.ts - Quick look's contents search: literal text in what Git tracks or the name walk finds, bounded, cancellable, masked, and yielding to the terminals between files; nothing indexed or stored (Story 67.5)
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import {
  QUICK_LOOK_SEARCH_LINE_CHARS,
  QUICK_LOOK_SEARCH_MAX_CHARS,
  QUICK_LOOK_SEARCH_MAX_FILE_BYTES,
  QUICK_LOOK_SEARCH_MAX_FILES,
  QUICK_LOOK_SEARCH_MAX_LINES,
  QUICK_LOOK_SEARCH_MIN_CHARS,
  SECRET_MASK,
  secretRanges,
  type QuickLookContentsFile,
  type QuickLookContentsLine,
  type QuickLookContentsResult,
  type SecretRange
} from '@bmn/protocol'
import { FILE_SEARCH_MAX_DEPTH, GENERATED_DIRECTORIES } from './file-reference-search'
import { gitTopLevel, repositoryGit, repositoryGitError } from './repository-git'

export interface ContentsSearchLimits {
  maxFiles?: number
  maxLines?: number
  maxFileBytes?: number
}

export interface ContentsSearchOptions extends ContentsSearchLimits {
  query: string
  matchCase: boolean
  wholeWord: boolean
  /** Test seam for the work tree's root; Git otherwise. */
  gitRoot?: (folder: string) => Promise<string | null>
  /**
   * Asked inside the masking and matching of a file as well as between files: true stops the search at once. The
   * worker passes one that reads the window's stop flag, so a cancel lands in the middle of a large file.
   */
  stopped?: () => boolean
}

/** Thrown inside a file's masking or matching when the search was stopped; nothing of the file is kept. */
const STOPPED = Symbol('search stopped')

/** Files read at once; each reads asynchronously and every file ends with a turn for the terminals. */
const READERS = 4
/** How many characters of a long line come before its match. */
const LEAD = 80
/** Git lists a large tree in one call; its output is bounded and it may take this long. */
const GIT_LIST_BYTES = 64 * 1024 * 1024
const GIT_LIST_MS = 15_000

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** The search's pattern: the text taken literally, by case or not, and as a whole word when asked. */
export function contentsPattern(query: string, matchCase: boolean, wholeWord: boolean): RegExp {
  const literal = escape(query)
  const source = wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal
  return new RegExp(source, matchCase ? 'gu' : 'giu')
}

/** The query as typed, or why it cannot be searched: 2 to 256 visible characters on one line. */
export function contentsQueryProblem(query: string): string | null {
  if ([...query].length < QUICK_LOOK_SEARCH_MIN_CHARS) return `Type at least ${QUICK_LOOK_SEARCH_MIN_CHARS} characters`
  if ([...query].length > QUICK_LOOK_SEARCH_MAX_CHARS) return `Search text is at most ${QUICK_LOOK_SEARCH_MAX_CHARS} characters`
  if (/[\p{Cc}\p{Cf}]/u.test(query)) return 'Search needs visible text on one line'
  return null
}

/**
 * Line `[from, to)` with each hidden stretch in it read as "[secret hidden]", as the file view would show it.
 * `ranges` are in order and `first` is the first that may reach `from`, so a line costs only the ranges near it.
 */
function maskedText(text: string, ranges: readonly SecretRange[], first: number, from: number, to: number): string {
  let out = ''
  let at = from
  for (let index = first; index < ranges.length && ranges[index]![0] < to; index += 1) {
    const [start, end] = ranges[index]!
    if (end <= from) continue
    out += `${text.slice(at, Math.max(at, start))}${SECRET_MASK}`
    at = Math.max(at, Math.min(end, to))
  }
  return `${out}${text.slice(at, to)}`
}

/** Overlapping hidden stretches joined, in order: what a match may not touch, each looked at once. */
function hiddenStretches(ranges: readonly SecretRange[]): SecretRange[] {
  const joined: SecretRange[] = []
  for (const [start, end] of ranges) {
    const last = joined.at(-1)
    if (last && start < last[1]) last[1] = Math.max(last[1], end)
    else joined.push([start, end])
  }
  return joined
}

/** Moves an index off the second half of a surrogate pair, so a cut never splits a character. */
const whole = (text: string, index: number): number => {
  const code = text.charCodeAt(index)
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

/**
 * The matching lines of one file's text: the first match on each line that no hidden value touches, the line
 * masked by the rule of Story 67.3 for this path and cut to 240 characters around its match.
 */
export function matchingLines(path: string, text: string, pattern: RegExp, maxLines: number, stopped: () => boolean = () => false): QuickLookContentsLine[] {
  const check = (): void => {
    if (stopped()) throw STOPPED
  }
  pattern.lastIndex = 0
  if (!pattern.test(text)) return []
  const ranges = [...secretRanges(path, text, { check })].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  // Two cursors, both only moving forward as matches do: `first` to mask a whole line from its start, `stretch` to
  // tell whether a match touches a hidden value, so a line of many hidden values costs each of them once.
  let first = 0
  const advance = (to: number): void => {
    while (first < ranges.length && ranges[first]![1] <= to) first += 1
  }
  const stretches = hiddenStretches(ranges)
  let stretch = 0
  const found: QuickLookContentsLine[] = []
  // The line a match is on, found by walking forward once: each line break is looked for once, however long the line.
  let lineNumber = 1
  let lineStart = 0
  let nextBreak = text.indexOf('\n')
  const lineOf = (at: number): void => {
    while (nextBreak !== -1 && nextBreak < at) {
      lineNumber += 1
      lineStart = nextBreak + 1
      nextBreak = text.indexOf('\n', lineStart)
    }
  }
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match && found.length < maxLines; match = pattern.exec(text)) {
    check()
    const start = match.index
    const end = start + match[0].length
    if (end === start) {
      pattern.lastIndex = start + 1
      continue
    }
    // A match inside a hidden value is never shown: the search goes on after the whole value.
    while (stretch < stretches.length && stretches[stretch]![1] <= start) stretch += 1
    if (stretch < stretches.length && stretches[stretch]![0] < end) {
      pattern.lastIndex = Math.max(end, stretches[stretch]![1])
      continue
    }
    lineOf(start)
    advance(lineStart)
    const newline = nextBreak !== -1 && nextBreak >= end ? nextBreak : text.indexOf('\n', end)
    const lineBreak = newline === -1 ? text.length : newline
    const lineEnd = lineBreak > lineStart && text[lineBreak - 1] === '\r' ? lineBreak - 1 : lineBreak
    const masked = maskedText(text, ranges, first, lineStart, lineEnd)
    const matchStart = maskedText(text, ranges, first, lineStart, start).length
    const matchEnd = matchStart + (end - start)
    let from = 0
    if (masked.length > QUICK_LOOK_SEARCH_LINE_CHARS) from = whole(masked, Math.max(0, Math.min(matchStart - LEAD, masked.length - QUICK_LOOK_SEARCH_LINE_CHARS)))
    const cut = Math.min(masked.length, from + QUICK_LOOK_SEARCH_LINE_CHARS)
    const to = cut < masked.length ? whole(masked, cut) : cut
    found.push({
      line: lineNumber,
      column: start - lineStart + 1,
      length: end - start,
      text: masked.slice(from, to),
      matchStart: matchStart - from,
      matchEnd: Math.min(matchEnd, to) - from,
      cutBefore: from > 0,
      cutAfter: to < masked.length
    })
    if (newline === -1) break
    pattern.lastIndex = newline + 1
  }
  return found
}

type Listing = { scope: 'git' | 'walk'; paths: string[]; more: boolean } | { unavailable: string }

/** What Git tracks under the root plus untracked files it does not ignore, sorted, at most `max` and whether there were more. */
async function gitFiles(root: string, max: number, signal: AbortSignal): Promise<Listing> {
  try {
    const output = await repositoryGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], GIT_LIST_BYTES, { timeout: GIT_LIST_MS, signal })
    const paths = [...new Set(output.split('\0').filter(Boolean))].sort()
    return { scope: 'git', paths: paths.slice(0, max).map((path) => join(root, path)), more: paths.length > max }
  } catch (error) {
    return { unavailable: signal.aborted ? 'Search stopped' : repositoryGitError(error) }
  }
}

/** The name search's walk: no links, no `.git`, `node_modules` or generated folders, six folders deep. */
async function walkFiles(root: string, max: number, signal: AbortSignal): Promise<Listing> {
  const paths: string[] = []
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let seen = 0
  for (let index = 0; index < pending.length; index += 1) {
    if (signal.aborted) break
    const folder = pending[index]!
    let handle
    try {
      handle = await opendir(folder.path)
    } catch {
      if (folder.depth === 0) return { unavailable: 'This folder is unavailable' }
      continue
    }
    const entries: Array<{ name: string; folder: boolean }> = []
    try {
      for await (const entry of handle) {
        if (signal.aborted) break
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!GENERATED_DIRECTORIES.has(entry.name) && folder.depth < FILE_SEARCH_MAX_DEPTH) entries.push({ name: entry.name, folder: true })
        } else if (entry.isFile()) entries.push({ name: entry.name, folder: false })
        if (++seen % 256 === 0) await pause()
      }
    } catch {
      // A folder removed during the walk gives what was read of it.
    }
    // By name within each folder, so the same folder gives the same files and the same first lines.
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(folder.path, entry.name)
      if (entry.folder) pending.push({ path, depth: folder.depth + 1 })
      else if (paths.length >= max) return { scope: 'walk', paths, more: true }
      else paths.push(path)
    }
  }
  return { scope: 'walk', paths, more: false }
}

type FileOutcome = { kind: 'read'; lines: QuickLookContentsLine[] } | { kind: 'skipped' } | { kind: 'unreadable' }

/**
 * One file: a regular file and no link, at most the size cap, holding valid UTF-8 text. It is checked on the open
 * handle and read at most one byte past the cap, so a file swapped for a link, a pipe or a larger file between the
 * listing and the read is never followed or read whole; a file with matches is shown only if the handle lies under
 * the root's real folder, so a folder on the path swapped for a link cannot bring in another folder's lines.
 */
async function searchFile(path: string, pattern: RegExp, maxBytes: number, maxLines: number, realRoot: string, stopped: () => boolean): Promise<FileOutcome> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A tracked file deleted from the work tree is not there to read; a link or a pipe is not a file to search.
    return code === 'ENOENT' || code === 'ELOOP' || code === 'ENXIO' || code === 'EISDIR' ? { kind: 'skipped' } : { kind: 'unreadable' }
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxBytes) return { kind: 'skipped' }
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (length > maxBytes || bytes.includes(0)) return { kind: 'skipped' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { kind: 'skipped' }
    }
    const lines = matchingLines(path, text, new RegExp(pattern.source, pattern.flags), maxLines, stopped)
    if (lines.length > 0 && !(await realpath(`/proc/self/fd/${handle.fd}`).catch(() => '')).startsWith(realRoot === '/' ? '/' : `${realRoot}/`)) return { kind: 'skipped' }
    return { kind: 'read', lines }
  } catch (error) {
    return error === STOPPED ? { kind: 'skipped' } : { kind: 'unreadable' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Searches the root's files for literal text (Story 67.5). Inside a Git work tree the files are those Git tracks
 * plus untracked ones it does not ignore; elsewhere the name search's walk. Reads are asynchronous, a few at a
 * time, with a turn for the terminals after each file; it stops at 20,000 files or 2,000 matching lines and says
 * which, and stops when `signal` aborts.
 */
export async function searchQuickLookContents(rootPath: string, options: ContentsSearchOptions, signal: AbortSignal): Promise<QuickLookContentsResult> {
  const started = performance.now()
  const root = isAbsolute(rootPath) ? normalize(rootPath) : rootPath
  const result: QuickLookContentsResult = {
    mode: 'contents', root, scope: 'walk', files: [], matchCount: 0, filesRead: 0, unreadable: 0, limit: null, cancelled: false, unavailable: null, elapsedMs: 0
  }
  const stopped = (): boolean => signal.aborted || options.stopped?.() === true
  const done = (): QuickLookContentsResult => ({ ...result, cancelled: stopped(), elapsedMs: Math.round(performance.now() - started) })
  const problem = contentsQueryProblem(options.query)
  if (problem) return { ...done(), unavailable: problem }
  // The root may be reached through a link, as listing allows (a session started in one); below it no link is followed.
  const stats = isAbsolute(root) ? await stat(root).catch(() => null) : null
  const realRoot = stats?.isDirectory() ? await realpath(root).catch(() => null) : null
  if (!realRoot) return { ...done(), unavailable: 'This folder is unavailable' }
  const maxFiles = options.maxFiles ?? QUICK_LOOK_SEARCH_MAX_FILES
  const maxLines = options.maxLines ?? QUICK_LOOK_SEARCH_MAX_LINES
  const maxBytes = options.maxFileBytes ?? QUICK_LOOK_SEARCH_MAX_FILE_BYTES
  const inGit = (await (options.gitRoot ?? gitTopLevel)(root)) !== null
  const listing = inGit ? await gitFiles(root, maxFiles, signal) : await walkFiles(root, maxFiles, signal)
  if ('unavailable' in listing) return { ...done(), scope: inGit ? 'git' : 'walk', unavailable: listing.unavailable }
  result.scope = listing.scope
  if (stopped()) return done()
  const pattern = contentsPattern(options.query, options.matchCase, options.wholeWord)
  const outcomes: Array<FileOutcome | undefined> = new Array(listing.paths.length)
  let next = 0
  let lines = 0
  let full = false
  await Promise.all(Array.from({ length: Math.min(READERS, listing.paths.length) }, async () => {
    while (!full && !stopped() && next < listing.paths.length) {
      const index = next++
      // One line past the limit tells a search that reached it from one that ended exactly at it.
      const outcome = await searchFile(listing.paths[index]!, pattern, maxBytes, maxLines + 1, realRoot, stopped).catch((): FileOutcome => ({ kind: 'unreadable' }))
      outcomes[index] = outcome
      if (outcome.kind === 'read') {
        lines += outcome.lines.length
        if (lines > maxLines) full = true
      }
      await pause()
    }
  }))
  // In the listing's order, so the first 2,000 lines are the same whichever reader finished first: every file
  // before one that was read has been read too.
  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome) continue
    if (outcome.kind === 'unreadable') result.unreadable += 1
    if (outcome.kind !== 'read') continue
    result.filesRead += 1
    if (outcome.lines.length === 0 || result.matchCount >= maxLines) continue
    const kept = outcome.lines.slice(0, maxLines - result.matchCount)
    const file: QuickLookContentsFile = { path: listing.paths[index]!, lines: kept }
    result.files.push(file)
    result.matchCount += kept.length
  }
  if (full) result.limit = 'lines'
  else if (listing.more) result.limit = 'files'
  return done()
}

/** One search per owner (a window): a newer one aborts the older, and a cancel names the search it stops. */
export class QuickLookSearches {
  private readonly active = new Map<string, { requestId: string; controller: AbortController }>()

  async run<T>(ownerId: string, requestId: string, job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.active.get(ownerId)?.controller.abort()
    const controller = new AbortController()
    this.active.set(ownerId, { requestId, controller })
    try {
      return await job(controller.signal)
    } finally {
      if (this.active.get(ownerId)?.requestId === requestId) this.active.delete(ownerId)
    }
  }

  cancel(ownerId: string, requestId: string): void {
    const active = this.active.get(ownerId)
    if (active?.requestId === requestId) active.controller.abort()
  }

  get running(): number {
    return this.active.size
  }

  /**
   * Runs a search that must first be checked (its root, its window's folder): the search is this window's from the
   * moment it is asked, so a cancel or a newer search during the check stops it, and requests keep the order they came in.
   */
  checkedRun<T>(ownerId: string, requestId: string, check: () => Promise<void>, job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.run(ownerId, requestId, async (signal) => {
      await check()
      return job(signal)
    })
  }
}
