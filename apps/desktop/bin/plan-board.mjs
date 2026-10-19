// MODULE: plan-board.mjs - Epic 77: one resolver, one streamed board reader and one structural check for a project's plan, in BMN's own format (plan/) or BMAD's, shared by `bmn plan` and the app's dev-auto runs view
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { insideDirectory } from './shared-helpers.mjs'

/**
 * A plan is found the same way by every reader (R77-FR3, FR6): the enclosing product repository first, also
 * from inside `plan/` when the plan keeps its own history there; then BMN's format (`plan/status.yaml` with
 * `format: bmn-plan`) or BMAD's (the board BMAD's config names, or its default path); then the checkout to
 * read it from: an untracked plan lives only in the default checkout, a tracked one in the checkout at hand,
 * as dev-auto's rule has it. Both formats present, an unknown schema or a malformed own plan is an error,
 * never a quiet fall back to BMAD.
 */
export const FORMAT = 'bmn-plan'
const SCHEMA_VERSION = 1
export const NOTE_LIMIT = 160
const PLAN_LIMIT = 20 * 1024
const VISION_LIMIT = 8 * 1024
const EPIC_LIMIT = 60 * 1024
export const STATUSES = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'paused', 'done', 'dropped']
const REASON_STATUSES = ['blocked', 'paused', 'dropped']
const FINISHED = ['done', 'dropped']
export const BMAD_STATUSES = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done', 'optional', 'contexted', 'drafted']
const LEGACY_MARKER = /^<!--\s*bmn-plan:\s*bmad-legacy\b([^>]*)-->\s*$/u
const PLAN_SECTIONS = ['Purpose', 'Users', 'Goals', 'Non-goals', 'Success signals', 'Standing constraints', 'Architecture', 'Decisions', 'Truth documents']
/** The foundation every plan builds on (owner, 2026-10-17): what the project is for and its numbered principles. */
const VISION_SECTIONS = ['Vision', 'Principles']
const EPIC_SECTIONS = ['Outcome', 'Why', 'Boundary and dependencies', 'Truth impact', 'Stories']
const BMAD_DEFAULT = '_bmad-output/implementation-artifacts'
export const EXIT = { ok: 0, findings: 1, unable: 2 }

export class PlanError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/** One row of `development_status:`, BMAD's grammar: two spaces, key, colon, status, optional `# note`. */
export const ROW = /^ {2}([\w.-]+):[ \t]*([\w-]+)[ \t]*(?:#[ \t]?(.*?))?[ \t]*$/u

/** The row token (R77-FR2, 77.2): what `bmn plan set --expect` must still find, covering status and note. */
export function rowToken(key, status, note) {
  return createHash('sha256').update(`${key}\0${status}\0${note}`).digest('hex').slice(0, 16)
}

/** Epic number of a row key: `epic-77`, `77-1-slug`, `epic-77-retrospective`. */
function rowEpic(key) {
  const match = /^(?:epic-)?(\d+)(?:[-.]|$)/u.exec(key)
  return match ? Number(match[1]) : null
}

/** Story number of a row key: `77-1-slug` gives `77.1`; an epic row gives null. */
function rowStory(key) {
  const match = /^(\d+)-(\d+)(?:-|$)/u.exec(key)
  return match ? `${Number(match[1])}.${Number(match[2])}` : null
}

function git(cwd, args) {
  return new Promise((done, fail) => {
    execFile('git', args, {
      cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
    }, (error, stdout) => (error ? fail(error) : done(stdout)))
  })
}

async function toplevel(directory) {
  try { return (await git(directory, ['rev-parse', '--show-toplevel'])).trim() } catch { return null }
}

/** `format: bmn-plan` at the top of a board, read from its first lines only. */
function headerOf(path) {
  let text
  try { text = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 4096) } catch { return null }
  const format = /^format:[ \t]*['"]?([\w-]+)['"]?[ \t]*(?:#.*)?$/mu.exec(text)?.[1] ?? null
  const schema = /^schema_version:[ \t]*['"]?([^\s'"#]+)['"]?[ \t]*(?:#.*)?$/mu.exec(text)?.[1] ?? null
  return { format, schema }
}

/** A directory is a plan root with its own history when it is `plan/` holding our board. */
function isOwnPlanRoot(directory) {
  return directory.split(sep).at(-1) === 'plan' && headerOf(join(directory, 'status.yaml'))?.format === FORMAT
}

async function tracked(root, localPath) {
  const out = await git(root, ['ls-files', '-z', '--', localPath])
  return out.split('\0').includes(localPath.replaceAll(sep, '/'))
}

/**
 * Resolve the plan for a directory. Returns the product root, the default and run checkouts, the plan root,
 * the board path to read, the format and the history mode; throws PlanError with a code a caller can show.
 */
export async function resolvePlan(start) {
  const from = resolve(start)
  if (!existsSync(from)) throw new PlanError('NO_PROJECT', `${from} does not exist`)
  let root = await toplevel(from)
  if (root === null) throw new PlanError('NO_REPOSITORY', `${from} is not inside a Git repository`)
  // From inside plan/ with its own Git history, the product repository encloses it.
  for (let depth = 0; depth < 4 && isOwnPlanRoot(root); depth++) {
    const outer = await toplevel(resolve(root, '..'))
    if (outer === null) break
    root = outer
  }
  let defaultCheckout = root
  try {
    const first = /^worktree (.+)$/mu.exec(await git(root, ['worktree', 'list', '--porcelain']))
    if (first) defaultCheckout = first[1]
  } catch { /* a repository without worktrees: the checkout at hand is the default */ }

  const own = await locate(root, defaultCheckout, 'plan/status.yaml')
  let bmadDirectory = BMAD_DEFAULT
  let configText = null
  for (const base of root === defaultCheckout ? [root] : [root, defaultCheckout]) {
    try { configText = readFileSync(join(base, '_bmad/bmm/config.yaml'), 'utf8'); break } catch { /* absent here */ }
  }
  if (configText !== null) {
    const configured = /^implementation_artifacts:\s*(.+?)\s*$/mu.exec(configText)?.[1]
    if (configured) bmadDirectory = configured.replace(/^(['"])(.*)\1$/u, '$2').replaceAll('{project-root}/', '').replaceAll('{project-root}', '.')
  }
  const bmadLocal = relative(root, resolve(root, bmadDirectory, 'sprint-status.yaml'))
  if (bmadLocal.startsWith('..') || isAbsolute(bmadLocal)) throw new PlanError('OUTSIDE', 'the BMAD config names a board outside the checkout')
  const bmad = await locate(root, defaultCheckout, bmadLocal)

  const base = { productRoot: root, defaultCheckout, runCheckout: root }
  if (own.exists) {
    if (bmad.exists) throw new PlanError('BOTH_PLANS', `both plans are present: ${own.path} and ${bmad.path}; keep one`)
    const header = headerOf(own.path)
    if (header?.format !== FORMAT) throw new PlanError('MALFORMED', `${own.path} does not start with format: ${FORMAT}`)
    if (header.schema !== String(SCHEMA_VERSION)) throw new PlanError('UNKNOWN_SCHEMA', `${own.path} has schema_version ${header.schema ?? '(none)'}; this BMN reads ${SCHEMA_VERSION}`)
    const planRoot = join(own.checkout, 'plan')
    const history = own.tracked ? 'product-repository' : existsSync(join(planRoot, '.git')) ? 'plan-repository' : 'none'
    return { ...base, format: FORMAT, planRoot, boardPath: own.path, boardCheckout: own.checkout, tracked: own.tracked, history }
  }
  if (bmad.exists) {
    return {
      ...base, format: 'bmad', planRoot: join(bmad.checkout, relative(root, resolve(root, bmadDirectory, '..'))), boardPath: bmad.path,
      boardCheckout: bmad.checkout, tracked: bmad.tracked, history: bmad.tracked ? 'product-repository' : 'none'
    }
  }
  throw new PlanError('NO_PLAN', `no plan in ${root}: neither plan/status.yaml nor ${bmadLocal}`)
}

/** Where a board path is read: tracked from the checkout at hand, untracked from the default checkout. */
async function locate(root, defaultCheckout, localPath) {
  let isTracked
  try { isTracked = await tracked(root, localPath) } catch { throw new PlanError('UNREADABLE', 'Git tracking could not be read') }
  const checkout = isTracked ? root : defaultCheckout
  const path = join(checkout, localPath)
  if (!existsSync(path)) return { exists: false, path, checkout, tracked: isTracked }
  let physical
  try { physical = realpathSync(path) } catch { throw new PlanError('UNREADABLE', `${path} cannot be read`) }
  if (!insideDirectory(realpathSync(checkout), physical)) throw new PlanError('OUTSIDE', `${path} resolves outside the checkout`)
  return { exists: true, path, checkout, tracked: isTracked }
}

/**
 * Read a board line by line, with no size limit (R77-FR3: B2Buster's 1.5 MB board fails a whole-file cap).
 * Rows of the selected epics (all when `epics` is empty) come back with their line and token; the header
 * fields and `queue:` are read from the top; lines in `development_status:` that are not rows are kept as
 * malformed for the check.
 */
export async function readBoard(path, { epics = [] } = {}) {
  const result = { format: null, schemaVersion: null, queue: [], queueLines: [], rows: [], malformed: [], duplicates: [], headerDuplicates: [], logicalDuplicates: [], totalRows: 0 }
  const seen = new Map()
  const headers = new Map()
  const logical = new Map()
  let section = null
  let lineNumber = 0
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of lines) {
    lineNumber++
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue
    if (/^\S/u.test(line)) {
      section = null
      const top = /^([\w-]+):[ \t]*(.*?)[ \t]*$/u.exec(line)
      if (!top) continue
      const value = top[2].replace(/[ \t]*#.*$/u, '').replace(/^(['"])(.*)\1$/u, '$2')
      if (headers.has(top[1])) result.headerDuplicates.push({ key: top[1], line: lineNumber, first: headers.get(top[1]) })
      else headers.set(top[1], lineNumber)
      if (top[1] === 'format') result.format = value
      else if (top[1] === 'schema_version') result.schemaVersion = value
      else if (top[1] === 'queue' || top[1] === 'development_status') section = top[1]
      continue
    }
    if (section === 'queue') {
      const item = /^[ \t]*-[ \t]+['"]?(?:epic-)?(\d+)['"]?[ \t]*(?:#.*)?$/u.exec(line)
      if (item) { result.queue.push(Number(item[1])); result.queueLines.push(lineNumber) } else result.malformed.push({ line: lineNumber, text: line.slice(0, 200), where: 'queue' })
      continue
    }
    if (section !== 'development_status') continue
    const row = ROW.exec(line)
    if (!row) { result.malformed.push({ line: lineNumber, text: line.slice(0, 200), where: 'development_status' }); continue }
    result.totalRows++
    const [, key, status, note = ''] = row
    if (seen.has(key)) result.duplicates.push({ key, line: lineNumber, first: seen.get(key) })
    else seen.set(key, lineNumber)
    const epic = rowEpic(key)
    // Two keys for one epic or story (epic-1 and epic-01, 1-1-a and 1-1-b) make the board ambiguous.
    const id = /^epic-\d+$/u.test(key) ? `epic ${epic}` : rowStory(key) !== null ? `story ${rowStory(key)}` : null
    if (id !== null && logical.has(id) && logical.get(id).key !== key) result.logicalDuplicates.push({ id, key, line: lineNumber, first: logical.get(id) })
    else if (id !== null && !logical.has(id)) logical.set(id, { key, line: lineNumber })
    if (epics.length > 0 && !epics.includes(epic)) continue
    result.rows.push({ key, status, note, line: lineNumber, epic, story: rowStory(key), token: rowToken(key, status, note) })
  }
  return result
}

/**
 * What makes a board in BMN's format ambiguous to read, one problem per line: a repeated key, header or
 * logical identifier, a malformed line, or a format or schema version this BMN does not read. `bmn plan check`
 * reports them and `bmn plan status` refuses such a board, so dev-auto stops on it (77.1 AC5, 77.5 AC5).
 */
export function boardProblems(board, boardName) {
  const problems = []
  const add = (line, reason) => problems.push({ where: `${boardName}:${line}`, reason })
  for (const duplicate of board.duplicates) add(duplicate.line, `duplicate key ${duplicate.key} (first at line ${duplicate.first})`)
  for (const bad of board.malformed) add(bad.line, bad.where === 'queue' ? `queue item is not an epic number: ${bad.text.trim()}` : `malformed row: ${bad.text.trim()}`)
  for (const header of board.headerDuplicates) add(header.line, `${header.key} appears twice (first at line ${header.first})`)
  for (const twin of board.logicalDuplicates) add(twin.line, `${twin.key} is ${twin.id} again (first ${twin.first.key} at line ${twin.first.line})`)
  if (board.format !== null && board.format !== FORMAT) add(1, `format is ${board.format}, not ${FORMAT}`)
  if (board.format === FORMAT && board.schemaVersion !== String(SCHEMA_VERSION)) add(1, `schema_version ${board.schemaVersion ?? '(none)'}; this BMN reads ${SCHEMA_VERSION}`)
  return problems
}

/** Epic files: `epics/NNN-slug.md`, read with their headings, stories and criteria. */
export function readEpicFile(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/u)
  const legacy = LEGACY_MARKER.exec(lines.find((line) => line.trim() !== '') ?? '')
  const epicHeading = text.match(/^#{1,2} Epic (\d+)\b/mu)
  const sections = [...text.matchAll(/^## (.+?)\s*$/gmu)].map((match) => match[1])
  const stories = []
  let current = null
  let inCriteria = false
  let fence = false
  lines.forEach((line, index) => {
    if (/^\s*```/u.test(line)) fence = !fence
    if (fence) return
    const story = /^### Story (\d+)\.(\d+)\b/u.exec(line)
    if (story) {
      current = { id: `${Number(story[1])}.${Number(story[2])}`, epic: Number(story[1]), line: index + 1, criteria: [], verification: false }
      stories.push(current)
      inCriteria = false
      return
    }
    if (/^#{1,2} /u.test(line)) { current = null; return }
    if (!current) return
    if (/^\*\*Acceptance criteria:?\*\*/iu.test(line)) { inCriteria = true; return }
    if (/^\*\*Verification:?\*\*/iu.test(line)) { current.verification = true; inCriteria = false; return }
    const criterion = inCriteria ? /^(\d+)\.\s/u.exec(line) : null
    if (criterion) current.criteria.push({ id: Number(criterion[1]), line: index + 1 })
  })
  return { path, bytes: Buffer.byteLength(text), legacy: legacy !== null, legacyNote: legacy?.[1]?.trim() ?? null, epic: epicHeading ? Number(epicHeading[1]) : null, sections, stories }
}

function epicFiles(planRoot) {
  const directory = join(planRoot, 'epics')
  let names
  try { names = readdirSync(directory) } catch { return [] }
  return names.filter((name) => /^\d{3,}-[\w.-]+\.md$/u.test(name)).sort().map((name) => ({ name, number: Number(name.slice(0, name.indexOf('-'))), path: join(directory, name) }))
}

/** Structural check (R77-FR3, 77.1 AC5): one finding per line; whether the plan says the right thing is the readiness method's and review's. */
export async function checkPlan(resolved) {
  const findings = []
  const add = (where, reason) => findings.push({ where, reason })
  const board = await readBoard(resolved.boardPath)
  const boardName = relative(resolved.productRoot, resolved.boardPath) || resolved.boardPath
  if (resolved.format === 'bmad') {
    for (const duplicate of board.duplicates) add(`${boardName}:${duplicate.line}`, `duplicate key ${duplicate.key} (first at line ${duplicate.first})`)
    for (const bad of board.malformed) add(`${boardName}:${bad.line}`, bad.where === 'queue' ? `queue item is not an epic number: ${bad.text.trim()}` : `malformed row: ${bad.text.trim()}`)
    return { findings, board }
  }
  findings.push(...boardProblems(board, boardName))

  for (const row of board.rows) {
    const at = `${boardName}:${row.line}`
    if (!STATUSES.includes(row.status)) add(at, `unknown status ${row.status} for ${row.key} (one of ${STATUSES.join(', ')})`)
    if ([...row.note].length > NOTE_LIMIT) add(at, `note of ${row.key} is ${[...row.note].length} characters, over ${NOTE_LIMIT}`)
    if (REASON_STATUSES.includes(row.status) && row.note.trim() === '') add(at, `${row.key} is ${row.status} without a reason in its note`)
    if (rowEpic(row.key) === null) add(at, `row key ${row.key} names no epic`)
  }
  const epicRows = new Map(board.rows.filter((row) => /^epic-\d+$/u.test(row.key)).map((row) => [row.epic, row]))
  const storyRows = new Map(board.rows.filter((row) => row.story !== null).map((row) => [row.story, row]))

  const seenQueue = new Set()
  board.queue.forEach((epic, index) => {
    const at = `${boardName}:${board.queueLines[index]}`
    if (seenQueue.has(epic)) add(at, `queue names epic ${epic} twice`)
    seenQueue.add(epic)
    const row = epicRows.get(epic)
    if (!row) add(at, `queue names epic ${epic}, which has no epic-${epic} row`)
    else if (FINISHED.includes(row.status)) add(at, `queue names epic ${epic}, which is ${row.status}`)
  })
  for (const row of epicRows.values()) if (row.status === 'ready' && !seenQueue.has(row.epic)) add(`${boardName}:${row.line}`, `epic ${row.epic} is ready but not in queue`)
  for (const row of epicRows.values()) {
    if (row.status !== 'done') continue
    for (const story of board.rows) if (story.story !== null && story.epic === row.epic && !FINISHED.includes(story.status)) add(`${boardName}:${story.line}`, `epic ${row.epic} is done but ${story.key} is ${story.status}`)
  }

  const visionFile = join(resolved.planRoot, 'VISION.md')
  if (!existsSync(visionFile)) add('plan/VISION.md', 'missing')
  else {
    const text = readFileSync(visionFile, 'utf8')
    const headings = [...text.matchAll(/^## (.+?)\s*$/gmu)].map((match) => match[1])
    for (const section of VISION_SECTIONS) if (!headings.includes(section)) add('plan/VISION.md', `missing section ## ${section}`)
    if (Buffer.byteLength(text) > VISION_LIMIT) add('plan/VISION.md', `${Buffer.byteLength(text)} bytes, over the ${VISION_LIMIT}-byte ceiling`)
    // Principles are cited by number (P3), so each number appears once and the list is not empty.
    const lines = text.split(/\r?\n/u)
    const start = lines.findIndex((line) => /^## Principles\s*$/u.test(line))
    if (start >= 0) {
      const seen = new Set()
      for (let index = start + 1; index < lines.length && !/^## /u.test(lines[index]); index += 1) {
        const number = /^(\d+)\. /u.exec(lines[index])?.[1]
        if (number === undefined) continue
        if (seen.has(number)) add(`plan/VISION.md:${index + 1}`, `duplicate principle ${number}`)
        seen.add(number)
      }
      if (seen.size === 0) add(`plan/VISION.md:${start + 1}`, 'no numbered principles under ## Principles')
    }
  }

  const planFile = join(resolved.planRoot, 'PLAN.md')
  if (!existsSync(planFile)) add('plan/PLAN.md', 'missing')
  else {
    const text = readFileSync(planFile, 'utf8')
    const headings = [...text.matchAll(/^## (.+?)\s*$/gmu)].map((match) => match[1])
    for (const section of PLAN_SECTIONS) if (!headings.includes(section)) add('plan/PLAN.md', `missing section ## ${section}`)
    if (Buffer.byteLength(text) > PLAN_LIMIT) add('plan/PLAN.md', `${Buffer.byteLength(text)} bytes, over the ${PLAN_LIMIT}-byte ceiling`)
  }

  const files = epicFiles(resolved.planRoot)
  const epicsSeen = new Map()
  const headingStories = new Set()
  for (const file of files) {
    const at = `plan/epics/${file.name}`
    let epic
    try { epic = readEpicFile(file.path) } catch { add(at, 'unreadable'); continue }
    if (epic.epic === null) { add(at, 'no "# Epic N: Title" heading'); continue }
    if (epic.epic !== file.number) add(at, `file number ${file.number} differs from its heading's Epic ${epic.epic}`)
    if (epicsSeen.has(epic.epic)) add(at, `duplicate epic ${epic.epic} (also ${epicsSeen.get(epic.epic)})`)
    epicsSeen.set(epic.epic, at)
    if (!epicRows.has(epic.epic)) add(at, `epic ${epic.epic} has no epic-${epic.epic} row`)
    if (!epic.legacy) {
      for (const section of EPIC_SECTIONS) if (!epic.sections.includes(section)) add(at, `missing section ## ${section}`)
      if (epic.bytes > EPIC_LIMIT) add(at, `${epic.bytes} bytes, over the ${EPIC_LIMIT}-byte ceiling`)
    }
    const storyIds = new Set()
    for (const story of epic.stories) {
      if (story.epic !== epic.epic) add(`${at}:${story.line}`, `Story ${story.id} belongs to epic ${story.epic}, not ${epic.epic}`)
      if (storyIds.has(story.id)) add(`${at}:${story.line}`, `duplicate story ${story.id}`)
      storyIds.add(story.id)
      headingStories.add(story.id)
      if (!storyRows.has(story.id)) add(`${at}:${story.line}`, `Story ${story.id} has no board row`)
      const criteria = new Set()
      for (const criterion of story.criteria) {
        if (criteria.has(criterion.id)) add(`${at}:${criterion.line}`, `duplicate criterion ${story.id} AC${criterion.id}`)
        criteria.add(criterion.id)
      }
      if (epic.legacy) continue
      if (story.criteria.length === 0) add(`${at}:${story.line}`, `Story ${story.id} has no numbered acceptance criteria`)
      if (!story.verification) add(`${at}:${story.line}`, `Story ${story.id} has no **Verification:**`)
    }
  }
  for (const row of epicRows.values()) if (!epicsSeen.has(row.epic)) add(`${boardName}:${row.line}`, `epic-${row.epic} has no epic file under plan/epics/`)
  for (const row of storyRows.values()) {
    if (epicsSeen.has(row.epic)) { if (!headingStories.has(row.story)) add(`${boardName}:${row.line}`, `${row.key} has no "### Story ${row.story}" heading`) }
    else if (!epicRows.has(row.epic)) add(`${boardName}:${row.line}`, `${row.key} belongs to epic ${row.epic}, which has neither an epic-${row.epic} row nor an epic file`)
  }
  return { findings, board }
}

/** One size check for callers that only stat: a board's size, for the status header. */
export function boardBytes(path) {
  try { return statSync(path).size } catch { return null }
}
