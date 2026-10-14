// MODULE: agents-opencode.mjs - Epic 70: the OpenCode folder BMN keeps for helper runs, its read-only agent, and the one `opencode run` form the check reads
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { sha256 } from './agents-roster.mjs'
import { stateDirectory } from './agents-state.mjs'

/**
 * An OpenCode helper run is checked only in the form Story 70.1 measured on OpenCode 2.0.29
 * (`_bmad-output/planning-artifacts/reference-70-opencode-helpers/RESULT.md`): `env -i` with a home,
 * configuration, data, state and cache folder of BMN's own, the project's own OpenCode configuration
 * switched off, and `opencode run --standalone --format json --agent bmn-helper -m <model#effort>
 * --title <title>` reading its prompt from standard input. BMN's configuration folder holds its own
 * files and nothing else, so no rules file, agent, skill, plugin or MCP server of the owner's is read,
 * and its agent denies every action but reading inside the project.
 */
export const OPENCODE_FORM_TESTED = { version: '2.0.29', on: '2026-10-14' }

/** BMN's read-only agent, as `--agent` names it. */
export const OPENCODE_HELPER_AGENT = 'bmn-helper'

/** An OpenCode session id (`ses_` and 26 characters), the one shape `roster bind` takes for an OpenCode receipt. */
export const OPENCODE_SESSION_ID = /^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/

/**
 * The agent 70.1 measured: every action denied, then reading inside the project allowed. With it
 * OpenCode offers only `read`, `glob` and `grep`, and refuses every other tool, a read outside the
 * project and a question, with and without `--auto`.
 */
const HELPER_AGENT_TEXT = `---
description: BMN read-only helper
mode: primary
permission:
  "*": deny
  read: allow
  glob: allow
  grep: allow
  list: allow
  external_directory: deny
  edit: deny
  bash: deny
  task: deny
  skill: deny
  webfetch: deny
  websearch: deny
  todowrite: deny
  question: deny
  lsp: deny
  doom_loop: deny
---

You are a read-only helper started by BMN. Answer the request; you cannot change anything.
`

/** OpenCode's own settings for the folder: no update, no sharing, no file snapshots. It names no model or provider. */
const CONFIG_TEXT = `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', snapshot: false }, null, 2)}\n`

/** Every file of BMN's OpenCode configuration folder, by its path inside `config/opencode`. */
export const OPENCODE_CONFIG_FILES = Object.freeze({
  'opencode.json': CONFIG_TEXT,
  [`agents/${OPENCODE_HELPER_AGENT}.md`]: HELPER_AGENT_TEXT
})

/** A mark of the agent's text, carried on a receipt. */
export const OPENCODE_HELPER_AGENT_SHA256 = sha256(HELPER_AGENT_TEXT)

/** Where BMN keeps the folder: under its own state, never in the owner's OpenCode folders. */
export function openCodeFolder() {
  return `${stateDirectory()}/opencode`
}

/** The five folders of a run, under `base`. */
export function openCodeFolders(base = openCodeFolder()) {
  return { home: `${base}/home`, config: `${base}/config`, data: `${base}/data`, state: `${base}/state`, cache: `${base}/cache` }
}

/**
 * What a run carries after `env -i`, besides PATH. OPENCODE_DISABLE_PROJECT_CONFIG is part of the
 * form: without it a repository's own opencode.json or .opencode folder replaces BMN's agent and the
 * address requests go to, and runs its own plugin (70.1, case h1). With OPENCODE_DISABLE_MODELS_FETCH
 * the run takes its models from the list built into OpenCode and does not fetch models.opencode.ai
 * first; that list holds OpenCode Go's models (probe of 70.2).
 */
export function openCodeEnvironment(base = openCodeFolder()) {
  const folders = openCodeFolders(base)
  return {
    HOME: folders.home, XDG_CONFIG_HOME: folders.config, XDG_DATA_HOME: folders.data, XDG_STATE_HOME: folders.state, XDG_CACHE_HOME: folders.cache,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1'
  }
}

/** The arguments of the form after `opencode`, model and title left to the lead. */
export const OPENCODE_RUN_ARGV = ['run', '--standalone', '--format', 'json', '--agent', OPENCODE_HELPER_AGENT]

/**
 * What `bmn roster role --json` hands a lead for an OpenCode candidate: the environment and the
 * arguments, then `-m <model>#<effort> --title <title>` and the prompt on standard input.
 */
export function openCodeItems(base = openCodeFolder()) {
  return {
    env: Object.entries(openCodeEnvironment(base)).map(([name, value]) => `${name}=${value}`),
    argv: [...OPENCODE_RUN_ARGV],
    then: ['-m', '<provider>/<model>#<effort>', '--title', '<title>'],
    stdin: 'the prompt file',
    agent_sha256: OPENCODE_HELPER_AGENT_SHA256,
    form_tested_on: OPENCODE_FORM_TESTED.version
  }
}

function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} did not read back`)
}

/**
 * Makes BMN's folder what the form needs, leaving what is already right: the configuration files
 * written whole, anything else in the configuration folder removed, the home folder emptied, the
 * other folders made. OpenCode searches with ripgrep; where it already keeps a copy in the owner's
 * cache, the run's cache links to it, so a run does not fetch ripgrep from the web (70.1, c1n).
 * The sign-in is not touched here.
 */
export function installOpenCodeFolder(base = openCodeFolder(), { ownerCache = `${process.env.XDG_CACHE_HOME || `${homedir()}/.cache`}/opencode` } = {}) {
  const folders = openCodeFolders(base)
  for (const folder of Object.values(folders)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    chmodSync(folder, 0o700)
  }
  const configFolder = `${folders.config}/opencode`
  mkdirSync(configFolder, { recursive: true, mode: 0o700 })
  const wanted = new Set(Object.keys(OPENCODE_CONFIG_FILES))
  for (const entry of listAll(folders.config)) {
    const inside = entry.path.slice(`${configFolder}/`.length)
    const keep = entry.path.startsWith(`${configFolder}/`) && (wanted.has(inside) || (entry.directory && [...wanted].some((file) => file.startsWith(`${inside}/`))))
    if (!keep && entry.path !== configFolder) rmSync(entry.path, { recursive: true, force: true })
  }
  for (const [name, text] of Object.entries(OPENCODE_CONFIG_FILES)) {
    const path = `${configFolder}/${name}`
    let current
    try {
      current = lstatSync(path).isFile() ? readFileSync(path, 'utf8') : null
    } catch {
      current = null
    }
    if (current !== text) {
      rmSync(path, { recursive: true, force: true })
      writeWhole(path, text)
    }
  }
  for (const name of readdirSync(folders.home)) rmSync(`${folders.home}/${name}`, { recursive: true, force: true })
  const ripgrep = `${ownerCache}/bin/rg`
  const link = `${folders.cache}/opencode/bin/rg`
  if (existsSync(ripgrep)) {
    let current
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : ''
    } catch {
      current = null
    }
    if (current !== ripgrep) {
      rmSync(link, { force: true, recursive: true })
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
      symlinkSync(ripgrep, link)
    }
  }
  return { folder: base, ...openCodeItems(base) }
}

function listAll(folder) {
  const found = []
  const walk = (directory) => {
    let names
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const path = `${directory}/${name}`
      const stats = lstatSync(path)
      found.push({ path, directory: stats.isDirectory(), file: stats.isFile(), link: stats.isSymbolicLink() })
      if (stats.isDirectory()) walk(path)
    }
  }
  walk(folder)
  return found
}

/**
 * Why BMN's folder is not the one the form needs, or null: the configuration folder must hold exactly
 * BMN's files, byte for byte, as plain files (no link, nothing else at any depth), and the home folder
 * nothing. OpenCode writes into neither during a run (70.1, b8).
 */
export function openCodeFolderProblem(base = openCodeFolder()) {
  const folders = openCodeFolders(base)
  const configFolder = `${folders.config}/opencode`
  const wanted = Object.keys(OPENCODE_CONFIG_FILES)
  let entries
  try {
    if (!lstatSync(folders.config).isDirectory() || !lstatSync(folders.home).isDirectory()) return `BMN's OpenCode folder ${base} is not there`
    entries = listAll(folders.config)
  } catch {
    return `BMN's OpenCode folder ${base} is not there`
  }
  for (const entry of entries) {
    if (entry.link) return `${entry.path} is a link, and BMN's OpenCode folder holds none`
    if (entry.directory) continue
    const inside = entry.path.startsWith(`${configFolder}/`) ? entry.path.slice(`${configFolder}/`.length) : null
    if (inside === null || !wanted.includes(inside)) return `${entry.path} is not one of BMN's OpenCode files, and OpenCode would read it`
  }
  for (const name of wanted) {
    let text
    try {
      text = readFileSync(`${configFolder}/${name}`, 'utf8')
    } catch {
      return `${configFolder}/${name} is missing`
    }
    if (text !== OPENCODE_CONFIG_FILES[name]) return `${configFolder}/${name} differs from BMN's text`
  }
  if (readdirSync(folders.home).length > 0) return `${folders.home} is not empty, and OpenCode would read what is there`
  return null
}
