// MODULE: agents-team-inputs.mjs - Epic 72: what a teammate may read, built for one ask: the question, file copies, or a frozen, bounded copy of one project with a self-contained Git history, each hashed, scanned for credentials and bounded
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The numeric limits of the contract (docs/agent-control.md, "Limits"); over one an ask is refused, never cut. */
export const LIMITS = Object.freeze({
  question: 1024 * 1024,
  files: 64,
  file: 1024 * 1024,
  prompt: 2 * 1024 * 1024,
  pictures: 8,
  picture: 5 * 1024 * 1024,
  pictureSide: 8000,
  // Decoded pixels: an 8K screen (7680x4320); a small file may unfold into far more.
  picturePixels: 7680 * 4320,
  projectFiles: 20_000,
  projectBytes: 200 * 1024 * 1024,
  projectFile: 10 * 1024 * 1024,
  historyCommits: 1000,
  historyBytes: 500 * 1024 * 1024
})

export class InputRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (code, message) => {
  throw new InputRefusal(code, message)
}

export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')
const mib = (bytes) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`

// ---------------------------------------------------------------------------------------------
// Credentials (R72-NFR5): every input is scanned before anything is built; a hit names the file and the pattern, never the value.

/** Each pattern by the name a refusal gives; the key block's own pattern spans lines, the rest are read a line at a time. */
const KEY_BLOCK = ['a private key block', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----\r?\n(?:[A-Za-z0-9+/=]{40,}\r?\n){2,}/gu]
export const CREDENTIAL_PATTERNS = Object.freeze([
  KEY_BLOCK,
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/gu],
  ['an OpenAI key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/gu],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/gu],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/gu],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/gu],
  ['a Stripe live key', /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/gu],
  ['a Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/gu],
  ['a signed JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/gu],
  ['an app sign-in file (refresh token)', /"(?:refresh_token|refreshToken)"\s*:\s*"[^"]{20,}"/gu],
  ['an OpenCode sign-in entry', /"type"\s*:\s*"api"\s*,\s*"key"\s*:\s*"[^"]{16,}"/gu],
  // A .env-style assignment of a secret-named variable to a value that looks like one: long, letters and digits.
  // The value is a group of its own: only the value, never the variable's name, may say it is made up.
  ['a secret assigned in .env style', /^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*[ \t]*[=:][ \t]*["']?(?<value>(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{16,})["']?[ \t]*$/gu]
])

/**
 * A value that says it is made up is no credential: tests and documents are full of them. A real
 * key is random, so it spells one of these words only by chance; the words are six letters or more,
 * so that chance stays below one in a hundred thousand for a whole key block (a four-letter word
 * turns up in about one random key block in five hundred). Only the value counts, never a
 * variable's name. Every other match counts.
 */
export const SYNTHETIC_WORDS = /(synthetic|planted|sentinel|example|made-?up|placeholder|redacted|sample|fixture|0123456789|abcdefghij)/iu

/** Each match's value: the pattern's `value` group where it has one, else the whole match. */
function matches(pattern, text) {
  pattern.lastIndex = 0
  const found = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    found.push(match.groups?.value ?? match[0])
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return found
}

/** A long line is read in overlapping pieces, so no pattern is ever left alone with a whole file (as secret-ranges.ts reads). */
function pieces(line, size = 4096, overlap = 256) {
  if (line.length <= size) return [line]
  const parts = []
  for (let at = 0; at < line.length; at += size - overlap) parts.push(line.slice(at, at + size))
  return parts
}

/** The names of the patterns a text holds with a value that is not made up; empty when none. */
export function credentialHits(text) {
  const found = new Set()
  const real = (value) => !SYNTHETIC_WORDS.test(value)
  for (let at = 0; at < text.length; at += 60 * 1024) {
    if (matches(KEY_BLOCK[1], text.slice(at, at + 64 * 1024)).some(real)) found.add(KEY_BLOCK[0])
  }
  for (const line of text.split('\n')) {
    if (line.length < 16) continue
    for (const piece of pieces(line)) {
      for (const [name, pattern] of CREDENTIAL_PATTERNS) {
        if (pattern === KEY_BLOCK[1] || found.has(name)) continue
        if (matches(pattern, piece).some(real)) found.add(name)
      }
    }
  }
  return CREDENTIAL_PATTERNS.map(([name]) => name).filter((name) => found.has(name))
}

/** File names that are key stores or sign-in files whatever they hold. */
const SECRET_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.git-credentials', '.netrc', '.pgpass', '.credentials.json'])
const SECRET_SUFFIXES = ['.p12', '.pfx', '.jks', '.keystore']
export function secretName(path) {
  const name = basename(path)
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** The folders of the home that hold credentials or an app's configuration: never an input, never a project. */
export function credentialLocations(home = homedir()) {
  return ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.codex', '.claude', '.claude.json', '.config/opencode', '.local/share/opencode', '.local/state/opencode',
    '.config/bmn', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.cursor', '.gemini'].map((entry) => join(home, entry))
}

const within = (path, folder) => path === folder || path.startsWith(`${folder}${sep}`)

/** Why a real path is a credential or configuration location, or null. */
export function credentialLocation(real, home = homedir()) {
  const location = credentialLocations(home).find((folder) => within(real, folder))
  if (location !== undefined) return `${location} holds credentials or an app's configuration`
  if (secretName(real)) return `${basename(real)} is a key store or sign-in file`
  return null
}

// ---------------------------------------------------------------------------------------------
// Text, files and pictures

/** Whether bytes are UTF-8 text: valid UTF-8 and no NUL. */
export function isText(bytes) {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** The question as given: UTF-8, inside its limit, scanned. */
export function checkQuestion(text) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length === 0) refuse('INPUT_INVALID', 'the question is empty')
  if (bytes.length > LIMITS.question) refuse('INPUT_TOO_LARGE', `the question is ${mib(bytes.length)}, over the limit of ${mib(LIMITS.question)}`)
  const hits = credentialHits(text)
  if (hits.length > 0) refuse('CREDENTIAL_FOUND', `the question holds ${hits.join(' and ')}; nothing was sent`)
  return { bytes: bytes.length, sha256: sha256Of(bytes) }
}

/**
 * One `--file` or `--image` as the asker named it: a regular file it can read, not a link, not in a
 * credential or configuration location, inside its limit. Returns `{ path, real, bytes }`.
 */
export function readInputFile(path, { kind = 'file', cwd = process.cwd(), home = homedir(), limit = LIMITS.file } = {}) {
  const named = isAbsolute(path) ? path : resolve(cwd, path)
  let stat
  try {
    stat = lstatSync(named)
  } catch {
    refuse('INPUT_INVALID', `${path} cannot be read`)
  }
  if (stat.isSymbolicLink()) refuse('INPUT_INVALID', `${path} is a link; name the file itself`)
  if (!stat.isFile()) refuse('INPUT_INVALID', `${path} is not a regular file`)
  const real = realpathSync(named)
  const location = credentialLocation(real, home)
  if (location !== null) refuse('INPUT_INVALID', `${path}: ${location}`)
  if (stat.size > limit) refuse('INPUT_TOO_LARGE', `${path} is ${mib(stat.size)}, over the ${kind === 'image' ? 'picture' : 'file'} limit of ${mib(limit)}`)
  let bytes
  try {
    bytes = readFileSync(real)
  } catch {
    refuse('INPUT_INVALID', `${path} cannot be read`)
  }
  return { path: named, real, bytes }
}

/** A `--file` for a file ask or a project ask: UTF-8 text, scanned. */
export function textFile(path, options = {}) {
  const file = readInputFile(path, options)
  if (!isText(file.bytes)) refuse('INPUT_INVALID', `${path} is not UTF-8 text; give a picture with --image`)
  const hits = credentialHits(file.bytes.toString('utf8'))
  if (hits.length > 0) refuse('CREDENTIAL_FOUND', `${path} holds ${hits.join(' and ')}; nothing was sent`)
  return { ...file, sha256: sha256Of(file.bytes) }
}

// ---------------------------------------------------------------------------------------------
// Projects

const git = (cwd, args, options = {}) => execFileSync('git', args, {
  cwd, encoding: options.encoding ?? 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(options.env ?? {}) },
  ...(options.input === undefined ? {} : { input: Buffer.from(options.input), stdio: ['pipe', 'pipe', 'pipe'] })
})

/** The Git working tree a folder belongs to, or null when it is in none. */
export function workingTreeRoot(folder) {
  try {
    const root = git(folder, ['rev-parse', '--show-toplevel']).trim()
    return root === '' ? null : realpathSync(root)
  } catch {
    return null
  }
}

/**
 * For a linked worktree's top folder, the main folder of the repository it belongs to; null for a
 * main working tree, a bare repository, a folder that is not a working tree's top, or no repository.
 * A project choice made for the repository covers its worktrees (73.2 AC1). A folder counts only
 * where the repository itself records that worktree there: a copy of a linked checkout, or a folder
 * whose `.git` file points into another repository, keeps that pointer but not the repository's
 * record of it (epic review).
 */
export function mainWorktree(top) {
  try {
    const [shown, common, own] = git(top, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir']).trim().split('\n')
    if (shown === undefined || common === undefined || own === undefined || realpathSync(shown) !== top || basename(common) !== '.git') return null
    const main = realpathSync(dirname(common))
    if (main === top) return null
    // The repository's record of this worktree (.git/worktrees/<name>/gitdir) names the .git file of this very folder.
    if (realpathSync(dirname(own)) !== join(realpathSync(common), 'worktrees')) return null
    const recorded = readFileSync(join(own, 'gitdir'), 'utf8').trim()
    return isAbsolute(recorded) && realpathSync(dirname(recorded)) === top ? main : null
  } catch {
    return null
  }
}

/** The project a folder belongs to for project choices: its repository's main folder when the repository records it as a linked worktree, else itself (73.2 AC1). */
export function canonicalProject(folder) {
  return mainWorktree(folder) ?? folder
}

/** Why a folder can never be a project: the home folder, `/`, or the apps' and BMN's configuration folders. */
export function notAProject(real, home = homedir()) {
  if (real === '/') return '/ is not a project'
  if (real === realpathSafe(home)) return 'the home folder is not a project'
  const locations = credentialLocations(realpathSafe(home))
  const inside = locations.find((folder) => within(real, folder))
  if (inside !== undefined) return `${real} is inside ${inside}, which holds credentials or an app's configuration`
  const holds = locations.find((folder) => within(folder, real) && existsSync(folder))
  if (holds !== undefined) return `${real} holds ${holds}, which holds credentials or an app's configuration`
  return null
}

function realpathSafe(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The project of an ask: the folder named with `--project`, else the asking session's repository
 * root, else none. A named folder must exist; the home folder, `/` and configuration folders never are one.
 */
export function askProject(named, { cwd = process.cwd(), home = homedir() } = {}) {
  let folder
  if (named === undefined) {
    folder = workingTreeRoot(cwd)
    if (folder === null) return null
  } else {
    try {
      folder = realpathSync(isAbsolute(named) ? named : resolve(cwd, named))
    } catch {
      refuse('PROJECT_INVALID', `${named} is not an existing folder`)
    }
    if (!statSync(folder).isDirectory()) refuse('PROJECT_INVALID', `${named} is not a folder`)
  }
  const why = notAProject(folder, home)
  if (why !== null) refuse('PROJECT_INVALID', why)
  return folder
}

/** The status of each tracked path that differs from the revision: modified, added, deleted or type-changed. */
function changedPaths(root) {
  const text = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'])
  const changed = new Map()
  for (const entry of text.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    changed.set(path, code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('T') ? 'type-changed' : 'modified')
  }
  return changed
}

/**
 * Builds the frozen copy of a project for one run in `target` (an empty folder): the tracked,
 * non-ignored files as they are in the working tree, links kept as links only where they stay in
 * the project, the extra `--file` copies inside the project (Git-ignored or untracked ones the
 * asker named), and a self-contained Git history of the checked-out revision, the newest commits
 * up to the bound, fetched into a new object database: no copied packs, alternates, reflogs,
 * replacement refs, remotes, hooks, configuration or other branch names. `publicCommit` builds the
 * copy from that commit's tree instead of the working tree (a public ask). Returns the manifest.
 */
export function freezeProject(root, target, { extraFiles = [], publicCommit = null, limits = LIMITS } = {}) {
  if (workingTreeRoot(root) !== root) {
    refuse('PROJECT_INVALID', `${root} is not a Git working tree; to give it files, ask with --access files and --file`)
  }
  let head
  try {
    head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  } catch {
    refuse('PROJECT_INVALID', `${root} has no commit yet; to give it files, ask with --access files and --file`)
  }
  const revision = publicCommit ?? head
  const changed = publicCommit === null ? changedPaths(root) : new Map()
  const tracked = (publicCommit === null ? git(root, ['ls-files', '-z', '--cached']) : git(root, ['ls-tree', '-r', '-z', '--name-only', publicCommit])).split('\0').filter(Boolean)
  const unique = [...new Set(tracked)]
  if (unique.length > limits.projectFiles) refuse('INPUT_TOO_LARGE', `${root} tracks ${unique.length} files, over the project limit of ${limits.projectFiles}`)

  // The asker's extra files count against the project's own limits, and none may name the frozen repository's Git folder.
  const extras = extraFiles.filter((extra) => !unique.includes(relative(root, extra.real)))
  for (const extra of extraFiles) {
    const path = relative(root, extra.real)
    if (path.startsWith('..') || isAbsolute(path)) refuse('INPUT_INVALID', `${extra.path} is outside the project ${root}; files from elsewhere go with --access files`)
    if (path.split(sep).some((part) => part.toLowerCase() === '.git')) refuse('INPUT_INVALID', `${extra.path} is inside a Git folder; a project ask never carries Git's own files`)
  }
  if (unique.length + extras.length > limits.projectFiles) refuse('INPUT_TOO_LARGE', `${root} tracks ${unique.length} files and ${extras.length} more were named, over the project limit of ${limits.projectFiles}`)

  mkdirSync(target, { recursive: true, mode: 0o700 })
  // The history first, into an empty repository of the run's own: the newest commits of the revision,
  // at most the bound. A depth counts commits along each line of history, so where lines branch it
  // holds more; the depth is then made smaller until the count is inside the bound.
  let depth = limits.historyCommits
  for (let attempt = 0; ; attempt += 1) {
    rmSync(join(target, '.git'), { recursive: true, force: true })
    git(target, ['init', '-q', '-b', 'ask'])
    try {
      git(target, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--update-head-ok', '--no-recurse-submodules', `--depth=${depth}`, `file://${root}`, `+${revision}:refs/heads/ask`],
        { env: { GIT_ALLOW_PROTOCOL: 'file' } })
    } catch (error) {
      refuse('PROJECT_INVALID', `the history of ${root} could not be copied (${String(error.stderr ?? error.message).trim().split('\n').pop()})`)
    }
    const count = Number(git(target, ['rev-list', '--count', 'refs/heads/ask']).trim())
    if (count <= limits.historyCommits) break
    if (depth === 1 || attempt >= 8) refuse('INPUT_TOO_LARGE', `the newest history of ${root} holds ${count} commits, over the limit of ${limits.historyCommits}`)
    depth = Math.max(1, Math.min(depth - 1, Math.floor((depth * limits.historyCommits) / count)))
  }
  git(target, ['symbolic-ref', 'HEAD', 'refs/heads/ask'])
  for (const path of ['hooks', 'logs', 'FETCH_HEAD', 'description', 'info', 'ORIG_HEAD', 'objects/info/alternates']) rmSync(join(target, '.git', path), { recursive: true, force: true })
  writeFileSync(join(target, '.git/config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n')
  const objectBytes = folderBytes(join(target, '.git/objects'))
  if (objectBytes > limits.historyBytes) refuse('INPUT_TOO_LARGE', `the history of ${root} is ${mib(objectBytes)}, over the limit of ${mib(limits.historyBytes)}`)

  // The files, as they are now (or as the public commit has them).
  const files = []
  let total = 0
  for (const path of unique) {
    const state = changed.get(path) ?? null
    const source = join(root, path)
    const copy = join(target, path)
    if (publicCommit !== null) {
      const mode = git(root, ['ls-tree', '-z', publicCommit, '--', path]).split(' ')[0]
      if (mode === '160000') continue
      const bytes = git(root, ['cat-file', 'blob', `${publicCommit}:${path}`], { encoding: 'buffer' })
      if (mode === '120000') {
        linkInside(root, path, bytes.toString('utf8'))
        mkdirSync(dirname(copy), { recursive: true })
        symlinkSync(bytes.toString('utf8'), copy)
        files.push({ path, kind: 'link', target: bytes.toString('utf8'), changed: null })
        continue
      }
      total += bytes.length
      if (bytes.length > limits.projectFile) refuse('INPUT_TOO_LARGE', `${path} is ${mib(bytes.length)}, over the project file limit of ${mib(limits.projectFile)}`)
      mkdirSync(dirname(copy), { recursive: true })
      writeFileSync(copy, bytes, { mode: mode === '100755' ? 0o755 : 0o644 })
      files.push({ path, kind: 'file', bytes: bytes.length, sha256: sha256Of(bytes), changed: null })
      continue
    }
    let stat
    try {
      stat = lstatSync(source)
    } catch {
      files.push({ path, kind: 'deleted', changed: 'deleted' })
      continue
    }
    if (stat.isDirectory()) continue
    // Its folder must be the project's own: a folder of the path replaced by a link to elsewhere is refused, never followed.
    folderInside(root, path)
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(source)
      linkInside(root, path, link)
      mkdirSync(dirname(copy), { recursive: true })
      symlinkSync(link, copy)
      files.push({ path, kind: 'link', target: link, changed: state })
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size > limits.projectFile) refuse('INPUT_TOO_LARGE', `${path} is ${mib(stat.size)}, over the project file limit of ${mib(limits.projectFile)}`)
    if (secretName(path)) refuse('CREDENTIAL_FOUND', `${path} is a key store or sign-in file; nothing was sent`)
    const bytes = readInside(root, path, limits.projectFile)
    total += bytes.length
    if (total > limits.projectBytes) refuse('INPUT_TOO_LARGE', `${root}'s tracked files are over the project limit of ${mib(limits.projectBytes)}`)
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, bytes, { mode: stat.mode & 0o111 ? 0o755 : 0o644 })
    files.push({ path, kind: 'file', bytes: bytes.length, sha256: sha256Of(bytes), changed: state })
  }
  // The asker's own extra files, inside the project only (checked above), counted with the tracked ones.
  for (const extra of extras) {
    const path = relative(root, extra.real)
    if (files.some((file) => file.path === path)) continue
    total += extra.bytes.length
    const copy = join(target, path)
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, extra.bytes, { mode: 0o644 })
    files.push({ path, kind: 'file', bytes: extra.bytes.length, sha256: extra.sha256, changed: 'named' })
  }
  if (total > limits.projectBytes) refuse('INPUT_TOO_LARGE', `${root}'s tracked files${extras.length > 0 ? ' and the named ones' : ''} are over the project limit of ${mib(limits.projectBytes)}`)
  // The index is the revision's, so the working tree's changes show as uncommitted. Git here runs
  // outside the container: no repository setting may start a program.
  git(target, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'read-tree', 'HEAD'])
  try {
    git(target, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'update-index', '-q', '--refresh'])
  } catch {
    // Differences are what update-index reports; the index itself is written.
  }
  const history = historyManifest(target)
  scanProject(target, files, history)
  return { root, revision, head, public_commit: publicCommit, files, history }
}

/** The folder a tracked path lies in must be the project's own folder of that name, not a link out of it. */
function folderInside(root, path) {
  const folder = dirname(join(root, path))
  let real
  try {
    real = realpathSync(folder)
  } catch {
    refuse('INPUT_INVALID', `the folder of ${path} cannot be read`)
  }
  if (real !== folder) refuse('INPUT_INVALID', `the folder of ${path} is a link (to ${real}); a project's files are read only from its own folders, never through a link`)
}

/**
 * A tracked file's bytes, read through one descriptor opened without following a link, whose real
 * path is then checked: a folder of the path replaced by a link while the copy is made reads nothing
 * from outside the project.
 */
export function readInside(root, path, limit = LIMITS.projectFile) {
  const expected = join(root, path)
  let handle
  try {
    handle = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    refuse('INPUT_INVALID', `${path} changed while the project was copied; ask again`)
  }
  try {
    let real = null
    try {
      real = readlinkSync(`/proc/self/fd/${handle}`)
    } catch {
      real = null
    }
    if (real !== expected) refuse('INPUT_INVALID', `${path} is not where the project has it${real === null ? '' : ` (it is ${real})`}; a project's files are read only from its own folders, never through a link`)
    const stat = fstatSync(handle)
    if (!stat.isFile()) refuse('INPUT_INVALID', `${path} changed while the project was copied; ask again`)
    if (stat.size > limit) refuse('INPUT_TOO_LARGE', `${path} is ${mib(stat.size)}, over the project file limit of ${mib(limit)}`)
    const bytes = Buffer.alloc(stat.size)
    let at = 0
    while (at < bytes.length) {
      const read = readSync(handle, bytes, at, bytes.length - at, at)
      if (read === 0) break
      at += read
    }
    return bytes.subarray(0, at)
  } finally {
    closeSync(handle)
  }
}

/** A tracked link may point only inside the project, and at something that is there. */
function linkInside(root, path, link) {
  const resolved = resolve(dirname(join(root, path)), link)
  let real
  try {
    real = realpathSync(resolved)
  } catch {
    refuse('INPUT_INVALID', `${path} is a link to ${link}, which is not there; links are kept only where they stay in the project`)
  }
  if (!within(real, root)) refuse('INPUT_INVALID', `${path} is a link out of the project (to ${link}); it is never followed or copied`)
}

function folderBytes(folder) {
  let total = 0
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) total += folderBytes(path)
    else if (entry.isFile()) total += statSync(path).size
  }
  return total
}

/** The copied history: the included commits newest first, the shallow boundary, and every object by type with a hash over the list. */
function historyManifest(target) {
  const commits = git(target, ['rev-list', 'HEAD']).split('\n').filter(Boolean)
  const shallow = existsSync(join(target, '.git/shallow')) ? readFileSync(join(target, '.git/shallow'), 'utf8').split('\n').filter(Boolean) : []
  const listed = git(target, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname) %(objectsize)']).split('\n').filter(Boolean).map((line) => line.split(' '))
  const objects = { commit: [], tree: [], blob: [], tag: [] }
  for (const [type, name, size] of listed) objects[type]?.push({ name, size: Number(size) })
  const list = listed.map(([type, name]) => `${type} ${name}`).sort().join('\n')
  return {
    commits, shallow, counts: { commits: objects.commit.length, trees: objects.tree.length, blobs: objects.blob.length },
    objects_sha256: sha256Of(Buffer.from(list)), objects: list, blobs: objects.blob
  }
}

/**
 * The credential scan over everything a project ask exposes (R72-NFR5): every current file, every
 * blob of the copied history and every commit message, and the names of every path in that
 * history. A hit refuses the ask, naming where and which pattern.
 */
function scanProject(target, files, history) {
  for (const file of files) {
    if (file.kind !== 'file') continue
    const bytes = readFileSync(join(target, file.path))
    if (!isText(bytes.subarray(0, 8192))) continue
    const hits = credentialHits(bytes.toString('utf8'))
    if (hits.length > 0) refuse('CREDENTIAL_FOUND', `${file.path} holds ${hits.join(' and ')}; nothing was sent`)
  }
  const paths = git(target, ['log', '--format=', '--name-only', '-z', 'HEAD']).split('\0').map((entry) => entry.trim()).filter(Boolean)
  const secret = paths.find((path) => secretName(path))
  if (secret !== undefined) refuse('CREDENTIAL_FOUND', `the history holds ${secret}, a key store or sign-in file; nothing was sent`)
  // Commit messages, then every blob through one cat-file process.
  const messages = git(target, ['log', '--format=%H%x00%B%x00', 'HEAD']).split('\0')
  for (let at = 0; at + 1 < messages.length; at += 2) {
    const hits = credentialHits(messages[at + 1])
    if (hits.length > 0) refuse('CREDENTIAL_FOUND', `the message of commit ${messages[at].trim().slice(0, 12)} holds ${hits.join(' and ')}; nothing was sent`)
  }
  const blobs = history.blobs.filter((blob) => blob.size > 0)
  if (blobs.length === 0) return
  const output = git(target, ['cat-file', '--batch'], { input: `${blobs.map((blob) => blob.name).join('\n')}\n`, encoding: 'buffer' })
  let at = 0
  while (at < output.length) {
    const newline = output.indexOf(10, at)
    const [name, , size] = output.subarray(at, newline).toString('latin1').split(' ')
    const start = newline + 1
    const bytes = output.subarray(start, start + Number(size))
    at = start + Number(size) + 1
    if (!isText(bytes.subarray(0, 8192))) continue
    const hits = credentialHits(bytes.toString('utf8'))
    if (hits.length > 0) {
      const where = historyPathOf(target, name)
      refuse('CREDENTIAL_FOUND', `the history holds ${hits.join(' and ')} in ${where ?? `blob ${name.slice(0, 12)}`}; nothing was sent`)
    }
  }
}

/** A path a blob had somewhere in the copied history, for a refusal's words. */
function historyPathOf(target, blob) {
  const line = git(target, ['rev-list', '--objects', 'HEAD']).split('\n').find((entry) => entry.startsWith(`${blob} `))
  return line === undefined ? null : line.slice(blob.length + 1)
}

/** Reads the first bytes of a file without reading it all. */
export function headBytes(path, count = 8192) {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(count)
    const read = readSync(handle, buffer, 0, count, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(handle)
  }
}

