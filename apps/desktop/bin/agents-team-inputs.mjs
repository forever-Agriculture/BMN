// MODULE: agents-team-inputs.mjs - Epic 72: what the asker hands a teammate: the question and whole text files, each read, bounded and scanned for credentials, the project it works in, and the credential mask for what comes back
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

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
  picturePixels: 7680 * 4320
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
const CREDENTIAL_PATTERNS = Object.freeze([
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
const SYNTHETIC_WORDS = /(synthetic|planted|sentinel|example|made-?up|placeholder|redacted|sample|fixture|0123456789|abcdefghij)/iu

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

/** What stands in the record for a credential's value. */
const MASK = (name) => `[credential masked by BMN: ${name}]`
/** BMN's own mark in a text it masked, with the pattern's name. */
const MASKED_MARK = /\[credential masked by BMN: ([^\]\n]{1,80})\]/gu

/** The names of the patterns BMN already masked in a text, in the patterns' order. */
export function maskedNames(text) {
  const found = new Set([...text.matchAll(MASKED_MARK)].map((match) => match[1]))
  return CREDENTIAL_PATTERNS.map(([name]) => name).filter((name) => found.has(name))
}

/** One string with every credential value that is not made up masked; the names of the patterns masked go into `found`. */
function maskText(text, found) {
  const real = (value) => !SYNTHETIC_WORDS.test(value)
  let masked = text.replace(KEY_BLOCK[1], (whole) => {
    if (!real(whole)) return whole
    found.add(KEY_BLOCK[0])
    return `${MASK(KEY_BLOCK[0])}\n`
  })
  masked = masked.split('\n').map((line) => {
    if (line.length < 16) return line
    let kept = line
    for (const [name, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern === KEY_BLOCK[1]) continue
      kept = kept.replace(pattern, (...args) => {
        const whole = args[0]
        const groups = args.at(-1)
        const value = typeof groups === 'object' && groups !== null && typeof groups.value === 'string' ? groups.value : whole
        if (!real(value)) return whole
        found.add(name)
        return value === whole ? MASK(name) : whole.replace(value, MASK(name))
      })
    }
    return kept
  }).join('\n')
  return masked
}

/**
 * A teammate's answer or raw output with every credential masked, as R72-NFR5 asks of what comes
 * back: the text, and the names of the patterns masked (never a value). A JSON line is masked inside
 * its strings and written again, so an escaped key block is found and the line stays JSON.
 */
export function maskCredentials(text, { jsonLines = false } = {}) {
  const found = new Set()
  if (!jsonLines) {
    const masked = maskText(text, found)
    return { text: masked, masked: CREDENTIAL_PATTERNS.map(([name]) => name).filter((name) => found.has(name)) }
  }
  const walk = (value) => {
    if (typeof value === 'string') return maskText(value, found)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
    return value
  }
  const lines = text.split('\n').map((line) => {
    if (line.trim() === '') return line
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return maskText(line, found)
    }
    const before = found.size
    const masked = walk(event)
    return found.size === before && JSON.stringify(masked) === JSON.stringify(event) ? line : JSON.stringify(masked)
  })
  return { text: lines.join('\n'), masked: CREDENTIAL_PATTERNS.map(([name]) => name).filter((name) => found.has(name)) }
}

/** File names that are key stores or sign-in files whatever they hold. */
const SECRET_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.git-credentials', '.netrc', '.pgpass', '.credentials.json'])
const SECRET_SUFFIXES = ['.p12', '.pfx', '.jks', '.keystore']
function secretName(path) {
  const name = basename(path)
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** The folders of the home that hold credentials or an app's configuration: never an input, never a project. */
function credentialLocations(home = homedir()) {
  return ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.codex', '.claude', '.claude.json', '.config/opencode', '.local/share/opencode', '.local/state/opencode',
    '.config/bmn', '.config/gh', '.config/gcloud', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.cursor', '.gemini'].map((entry) => join(home, entry))
}

const within = (path, folder) => path === folder || path.startsWith(`${folder}${sep}`)

/** Why a real path is a credential or configuration location, or null. */
function credentialLocation(real, home = homedir()) {
  const location = credentialLocations(home).find((folder) => within(real, folder))
  if (location !== undefined) return `${location} holds credentials or an app's configuration`
  if (secretName(real)) return `${basename(real)} is a key store or sign-in file`
  return null
}

// ---------------------------------------------------------------------------------------------
// Text, files and pictures

/** Whether bytes are UTF-8 text: valid UTF-8 and no NUL. */
function isText(bytes) {
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
function workingTreeRoot(folder) {
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
function notAProject(real, home = homedir()) {
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
