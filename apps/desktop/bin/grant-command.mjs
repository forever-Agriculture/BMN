// MODULE: grant-command.mjs - Story 103.3: what `bmn grant ask` refuses of a `command` term, read with the command guard's parser, and the hash of a file a card pins
//
// Run in BMN when a card is asked, never when a stored card is read: a guard that holds more tomorrow must not make today's
// record unreadable. It reads the words only and runs nothing. A runner's own file (a Makefile, a package.json) is pinned like a
// script; what that file then runs is the limit docs/agent-control.md names.
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { heldCommand, simpleCommandWords, subcommand } from './command-guard.mjs'
import { namesSecretFile } from './secret-list.mjs'

/** Programs that take a script as their first argument. */
const INTERPRETERS = /^((ba|da|z|k)?sh|python[\d.]*|node|ruby|perl|php|lua|deno|bun|tsx|ts-node)$/
/** An option of those that runs the code it is given. */
const INLINE_CODE = /^-(c|e|p|-eval|-print|-command)$/
const PIN_LIMIT_BYTES = 16 * 1024 * 1024
/** Options of a tool that take the next word as their value, before its verb. */
const GLOBAL_OPTIONS = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'],
  docker: ['-c', '--context', '-H', '--host', '--config', '-l', '--log-level'],
  podman: ['-c', '--connection', '--url', '--root', '--runroot']
}
/** A runner's own file decides what it runs, so a writable one is pinned like a script (D7; the epic pre-review). */
const RUNNER_FILES = { make: ['GNUmakefile', 'makefile', 'Makefile'], just: ['justfile', 'Justfile', '.justfile'], npm: ['package.json'], pnpm: ['package.json'], yarn: ['package.json'] }
const RUNNER_FILE_OPTIONS = ['-f', '--file', '--makefile', '--justfile']
const RUNNER_FOLDER_OPTIONS = ['-C', '--directory', '--dir', '--prefix', '--cwd']

/** A project's own secrets, beyond his machine's list: `.env` and `.env.production`, not the examples checked in beside them. */
const PROJECT_SECRET = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/
const namesSecret = (word) => namesSecretFile(word) || PROJECT_SECRET.test(word)

const nameOf = (word) => word.slice(word.lastIndexOf('/') + 1)

/** A path as the shell would read it in `folder`; `~` is his home folder. */
function resolved(path, folder) {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(folder, path)
}

/** Which of GRANT_NEVER_ON_A_CARD this command is, beyond what the guard holds; null when it is none. */
function neverOnACard(words) {
  const [program] = words
  const name = nameOf(program)
  // `git -C x clean`, `docker --context y rm`: the verb comes after the tool's own options (the guard's own reading).
  const args = name in GLOBAL_OPTIONS ? subcommand(words, GLOBAL_OPTIONS[name]) : words.slice(1)
  const has = (...flags) => args.some((word) => flags.includes(word))
  const [first, second] = args
  if (/^(rm|rmdir|unlink|shred|truncate|wipefs|dd)$/.test(name) || /^mkfs(\.|$)/.test(name)) return 'a deletion'
  if (name === 'find' && has('-delete')) return 'a deletion'
  if (name === 'git') {
    if (first === 'branch' && args.some((word) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(word))) return 'a deletion'
    if (first === 'tag' && args.length > 1 && !has('-l', '--list')) return 'a release tag'
    if ((first === 'worktree' && (second === 'remove' || second === 'prune')) || first === 'clean') return 'a deletion'
    if (first === 'update-ref' && has('-d', '--delete')) return 'a deletion'
    if (first === 'reset' && has('--hard', '--merge', '--keep')) return 'a deletion of uncommitted work'
    if (first === 'restore' || (first === 'checkout' && has('--', '-f', '--force'))) return 'a deletion of uncommitted work'
    if (first === 'stash' && (second === 'drop' || second === 'clear')) return 'a deletion'
  }
  if (name === 'gh') {
    if (first === 'release') return 'a release'
    if (first === 'auth' && ['token', 'login', 'refresh', 'setup-git'].includes(second)) return 'a credential'
    if (first === 'pr' && has('--delete-branch', '-d')) return 'a deletion'
  }
  // A request's own method: `gh api -X DELETE`, `curl --request=delete`, `curl -XDELETE`.
  if ((name === 'gh' && first === 'api') || name === 'curl' || name === 'wget') {
    const deleting = args.some((word, index) => /^(-X|--request|--method)=?delete$/i.test(word) || (/^(-X|--request|--method)$/.test(word) && /^delete$/i.test(args[index + 1] ?? '')) || /^-Xdelete$/i.test(word))
    if (deleting) return 'a deletion'
  }
  if ((name === 'docker' || name === 'podman') && ['rm', 'rmi', 'push'].includes(first)) return first === 'push' ? 'a publish' : 'a deletion'
  if ((name === 'cargo' || name === 'poetry' || name === 'vsce') && first === 'publish') return 'a publish'
  if ((name === 'twine' && first === 'upload') || (name === 'gem' && first === 'push')) return 'a publish'
  if (['npm', 'pnpm', 'yarn'].includes(name) && has('unpublish', 'publish')) return 'a publish'
  if (/^(kill|pkill|killall|skill)$/.test(name)) return 'stopping a process, which can be BMN'
  if (name === 'printenv') return 'a credential'
  if (name === 'bmn') return 'BMN\'s own commands, which an agent runs by its own rules, plans and acceptance included'
  if (words.some((word) => namesSecret(word))) return 'a credential'
  return null
}

/** The script this command runs, as it names it, or null: a path as the program, or an interpreter's file. */
function scriptOf(words, folder) {
  const [program, ...args] = words
  const candidate = program.includes('/') ? program : INTERPRETERS.test(nameOf(program)) ? args.find((word, index) => !word.startsWith('-') && !(index === 0 && word === 'run')) : undefined
  if (candidate === undefined) return null
  const path = resolved(candidate, folder)
  try { return statSync(path).isFile() ? path : program.includes('/') ? undefined : null } catch { return program.includes('/') ? undefined : null }
}

/** A word's value after an option, as `-f x`, `--file x` or `--file=x`, or undefined. */
function optionValue(words, options) {
  for (const [index, word] of words.entries()) {
    if (options.includes(word)) return words[index + 1]
    const joined = options.find((option) => option.startsWith('--') && word.startsWith(`${option}=`))
    if (joined !== undefined) return word.slice(joined.length + 1)
  }
  return undefined
}

/** The file that decides what this runner runs, when it is there, or null: `make` a Makefile, `pnpm run` a package.json. */
function runnerFileOf(words, folder) {
  const names = RUNNER_FILES[nameOf(words[0])]
  const rest = words.slice(1)
  if (names === undefined || rest.includes('--version') || rest.includes('-v')) return null
  const base = resolved(optionValue(rest, RUNNER_FOLDER_OPTIONS) ?? '.', folder)
  const named = optionValue(rest, RUNNER_FILE_OPTIONS)
  for (const path of (named !== undefined ? [resolved(named, base)] : names.map((name) => join(base, name)))) {
    try { if (statSync(path).isFile()) return path } catch { /* the next one */ }
  }
  return null
}

const isWritable = (path) => {
  for (const target of [path, dirname(path)]) {
    try { accessSync(target, constants.W_OK); return true } catch { /* the next one */ }
  }
  return false
}

/** The SHA-256 of a file a card pins, or null when it cannot be read (too large included). Sync: it is one small file. */
export function pinnedFileSha(pin, folder) {
  try {
    const path = resolved(pin.path, folder)
    if (!statSync(path).isFile() || statSync(path).size > PIN_LIMIT_BYTES) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** Why `grant ask` refuses this command term, or null (R103-NFR2, D7). It names the reason in words the agent can act on. */
export function grantCommandProblem(term) {
  const simple = simpleCommandWords(term.command)
  if ('problem' in simple) return `${simple.problem} (one simple command, exactly as it will run)`
  const { words } = simple
  const name = nameOf(words[0])
  if (INTERPRETERS.test(name) && words.slice(1).some((word) => INLINE_CODE.test(word))) return `${name} is given code to run; name a script file and pin it`
  const held = heldCommand(term.command, 0, false, term.folder)
  if (held !== null) return `BMN's command guard holds it for the owner: ${held}`
  const never = neverOnACard(words)
  if (never !== null) return `${never} is never on a card`
  try {
    if (!statSync(term.folder).isDirectory()) return `${term.folder} is not a folder`
  } catch {
    return `${term.folder} is not a folder`
  }
  const named = scriptOf(words, term.folder)
  const script = named === null ? runnerFileOf(words, term.folder) : named
  if (script === undefined) return `${words[0]} does not exist yet, so it cannot be pinned`
  const pin = term.script ?? null
  if (pin !== null) {
    if (namesSecret(pin.path)) return 'a credential is never on a card'
    if (pinnedFileSha(pin, term.folder) !== pin.sha256) return `${pin.path} does not have the SHA-256 the card names, or cannot be read`
    if (script !== null) {
      const same = (() => { try { return realpathSync(script) === realpathSync(resolved(pin.path, term.folder)) } catch { return false } })()
      if (!same) return `it runs ${script}, so that is the file to pin`
    }
    return null
  }
  if (script !== null && isWritable(script)) return `it runs ${script}, which can change; name that script on the card with its SHA-256`
  return null
}
