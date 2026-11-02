// MODULE: grant-command.mjs - Story 103.3: what `bmn grant ask` refuses of a `command` term, read with the command guard's parser, and the hash of a file a card pins
//
// Run in BMN when a card is asked, never when a stored card is read: a guard that holds more tomorrow must not make today's
// record unreadable. It reads the words only and runs nothing. A runner's own file (a Makefile, a package.json) is pinned like a
// script; what that file then runs, and an alias in his own config, are the limits docs/agent-control.md names. Where the words
// do not say for sure which file runs, it refuses rather than guesses (the full review, finding 2).
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DOCKER_VALUES, GH_VALUES, GIT_VALUES, heldCommand, simpleCommandWords, subcommand } from './command-guard.mjs'
import { namesSecretFile } from './secret-list.mjs'

/** Programs that take a script as their first argument. */
const INTERPRETERS = /^((ba|da|z|k)?sh|python[\d.]*|node|ruby|perl|php|lua|deno|bun|tsx|ts-node)$/
/** An option of those that runs the code it is given. */
const INLINE_CODE = /^-(c|e|p|-eval|-print|-command)$/
const VERSION_ONLY = /^(-v|-V|--version|-h|--help)$/
const PIN_LIMIT_BYTES = 16 * 1024 * 1024
/** The guard's own tables: each tool's options that take the next word as their value, before its verb. */
const GLOBAL_OPTIONS = { git: GIT_VALUES, gh: GH_VALUES, docker: DOCKER_VALUES, podman: DOCKER_VALUES }
/**
 * A runner's own file decides what it runs, so a writable one is pinned like a script (D7; the epic pre-review). Each says how
 * it is told which file and which folder, and which options make it pick among several; `above` walks up to find it, as npm and
 * just do; `stop` are short options that take a value, so a later letter in that word is not an option.
 */
const NPM_FAMILY = {
  names: ['package.json'], above: true, fileLong: [], fileShort: '', folderLong: ['--prefix', '--dir', '--cwd'], folderShort: 'C', stop: '',
  several: ['-w', '--workspace', '--workspaces', '-ws', '--filter', '-F', '-r', '--recursive', '-g', '--global', 'workspace', 'workspaces']
}
const RUNNERS = {
  make: { names: ['GNUmakefile', 'makefile', 'Makefile'], above: false, fileLong: ['--file', '--makefile'], fileShort: 'f', folderLong: ['--directory'], folderShort: 'C', stop: 'IjloOW', several: [] },
  just: { names: ['justfile', 'Justfile', '.justfile'], above: true, fileLong: ['--justfile'], fileShort: 'f', folderLong: ['--working-directory'], folderShort: 'd', stop: '', several: [] },
  npm: NPM_FAMILY,
  pnpm: NPM_FAMILY,
  yarn: NPM_FAMILY
}

/** A project's own secrets, beyond his machine's list: `.env` and `.env.production`, not the examples checked in beside them. */
const PROJECT_SECRET = /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/
const namesSecret = (word) => namesSecretFile(word) || PROJECT_SECRET.test(word)
/** A word, and the value of a joined option: `--env-file=.env` names `.env`. */
const secretIn = (word) => namesSecret(word) || (word.startsWith('-') && word.includes('=') && namesSecret(word.slice(word.indexOf('=') + 1)))

const nameOf = (word) => word.slice(word.lastIndexOf('/') + 1)

/** A path as the shell would read it in `folder`; `~` is his home folder. */
function resolved(path, folder) {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(folder, path)
}

const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }

const GIT_DELETING = /^(rm|clean|prune|gc|filter-branch|filter-repo)$/
const DOCKER_DELETING = /^(rm|rmi|remove|prune|down)$/
/** Their subcommands whose later words belong to a program inside a container (the guard's own reading). */
const DOCKER_RUNS = /^(run|exec|create|cp|commit)$/
const PUBLISHERS = /^(cargo|poetry|vsce|ovsx|uv|hatch|flit|deno)$/

/** What git's own words delete or discard, whatever option comes first. */
function gitNever(args, has, folder) {
  const [first, second] = args
  if (GIT_DELETING.test(first ?? '')) return 'a deletion'
  if (first === 'credential') return 'a credential'
  if (first === 'branch' && args.some((word) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(word))) return 'a deletion'
  if (first === 'tag' && args.length > 1 && !has('-l', '--list')) return 'a release tag'
  if (first === 'worktree' && (second === 'remove' || second === 'prune')) return 'a deletion'
  if (first === 'reflog' && (second === 'expire' || second === 'delete')) return 'a deletion'
  if (first === 'remote' && (second === 'remove' || second === 'rm')) return 'a deletion'
  if ((first === 'update-ref' || first === 'symbolic-ref') && has('-d', '--delete')) return 'a deletion'
  if (first === 'reset' && has('--hard', '--merge', '--keep')) return 'a deletion of uncommitted work'
  if (first === 'restore') return 'a deletion of uncommitted work'
  if (first === 'switch' && has('-f', '--force', '--discard-changes')) return 'a deletion of uncommitted work'
  if (first === 'checkout') {
    // `git checkout NAME` moves to a branch, unless NAME is a file here: then it throws that file's changes away.
    if (has('--', '.', '-f', '--force')) return 'a deletion of uncommitted work'
    if (args.slice(1).some((word) => !word.startsWith('-') && isFile(resolved(word, folder)))) return 'a deletion of uncommitted work'
  }
  if (first === 'stash' && (second === 'drop' || second === 'clear')) return 'a deletion'
  return null
}

/** Which of GRANT_NEVER_ON_A_CARD this command is, beyond what the guard holds; null when it is none. */
function neverOnACard(words, folder) {
  const [program] = words
  const name = nameOf(program)
  // `git -C x clean`, `docker --context y rm`: the verb comes after the tool's own options (the guard's own reading).
  const args = Object.hasOwn(GLOBAL_OPTIONS, name) ? subcommand(words, GLOBAL_OPTIONS[name]) : words.slice(1)
  const has = (...flags) => args.some((word) => flags.includes(word))
  const [first, second] = args
  if (/^(rm|rmdir|unlink|shred|truncate|wipefs|dd|trash|trash-put)$/.test(name) || /^mkfs(\.|$)/.test(name)) return 'a deletion'
  if (name === 'gio' && (first === 'trash' || first === 'remove')) return 'a deletion'
  if (name === 'find' && has('-delete')) return 'a deletion'
  if (name === 'find' && has('-exec', '-execdir', '-ok', '-okdir')) return 'starting another program'
  if (name === 'rsync' && args.some((word) => /^--(delete|remove-source-files)/.test(word))) return 'a deletion'
  if (name === 'git') {
    const never = gitNever(args, has, folder)
    if (never !== null) return never
    // One command's own config can name what runs: an alias, an ssh command, a pager. Read past, it would be any program.
    const own = words.slice(1, words.length - args.length)
    if (own.some((word) => /^(-c$|--config-env(=|$)|--exec-path=)/.test(word))) return 'a config setting for one command, which can change what runs,'
  }
  if (name === 'gh') {
    if (first === 'release') return 'a release'
    if (first === 'auth' && (['token', 'login', 'refresh', 'setup-git'].includes(second) || has('--show-token', '-t'))) return 'a credential'
    if (first === 'pr' && has('--delete-branch', '-d')) return 'a deletion'
    if (first !== 'api' && second === 'delete') return 'a deletion'
  }
  // A request's own method: `gh api -X DELETE`, `curl --request=delete`, `curl -XDELETE`, `curl -sX DELETE`.
  if ((name === 'gh' && first === 'api') || name === 'curl' || name === 'wget') {
    const deleting = args.some((word, index) => /^(-[a-zA-Z]*X|--request|--method)=?delete$/i.test(word) || (/^(-[a-zA-Z]*X|--request|--method)$/.test(word) && /^delete$/i.test(args[index + 1] ?? '')))
    if (deleting) return 'a deletion'
  }
  if (name === 'docker' || name === 'podman' || name === 'docker-compose') {
    // Any spelling (`docker rm`, `docker container remove`, an option whose value it cannot tell): its words before a program inside a container.
    const at = args.findIndex((word) => DOCKER_RUNS.test(word))
    const verbs = (at < 0 ? args : args.slice(0, at)).filter((word) => !word.startsWith('-'))
    if (verbs.some((word) => DOCKER_DELETING.test(word))) return 'a deletion'
    if (verbs.includes('push') || (at < 0 && has('--push'))) return 'a publish'
  }
  if (PUBLISHERS.test(name) && has('publish')) return 'a publish'
  if ((name === 'twine' && has('upload')) || (name === 'gem' && has('push')) || (name === 'nuget' && has('push')) || (name === 'dotnet' && has('nuget') && has('push'))) return 'a publish'
  if (['npm', 'pnpm', 'yarn'].includes(name) && has('unpublish', 'publish')) return 'a publish'
  if (/^(kill|pkill|killall|skill)$/.test(name)) return 'stopping a process, which can be BMN'
  if (name === 'printenv') return 'a credential'
  if (name === 'bmn') return 'BMN\'s own commands, which an agent runs by its own rules, plans and acceptance included'
  if (words.some(secretIn)) return 'a credential'
  return null
}

/** The script an interpreter runs, or why the words do not say for sure: an option before it may name another file or module. */
function interpreterFile(name, words, folder) {
  let args = words.slice(1)
  if (args.length === 0) return { problem: `${name} is given no script, so it reads its program from input; name a script file and pin it` }
  if (INLINE_CODE.test(args[0])) return { problem: `${name} is given code to run; name a script file and pin it` }
  if ((name === 'deno' || name === 'bun') && args[0] === 'run') args = args.slice(1)
  const [script] = args
  if (script === undefined || script.startsWith('-')) return { problem: `${name}'s options before the script can change what runs; put the script first, or name a script that does it` }
  const path = resolved(script, folder)
  return isFile(path) ? { file: path } : { problem: `${script} is not a file BMN can pin; name the script ${name} runs` }
}

/** The value of each option of a runner in these words, in `-f x`, `-fx`, `-sfx`, `--file x` or `--file=x`; words after `--` are the script's. */
function runnerOptions(rest, runner) {
  const words = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  const found = { files: [], folders: [], several: false }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (runner.several.includes(word) || runner.several.some((option) => option.startsWith('--') && word.startsWith(`${option}=`))) found.several = true
    const long = (options, into) => {
      if (options.includes(word)) { into.push(words[index += 1]); return true }
      const joined = options.find((option) => word.startsWith(`${option}=`))
      if (joined === undefined) return false
      into.push(word.slice(joined.length + 1))
      return true
    }
    if (long(runner.fileLong, found.files) || long(runner.folderLong, found.folders)) continue
    if (!/^-[^-]/.test(word)) continue
    for (let at = 1; at < word.length; at += 1) {
      const letter = word[at]
      if (runner.stop.includes(letter)) break
      const into = runner.fileShort === letter ? found.files : runner.folderShort === letter ? found.folders : null
      if (into === null) continue
      into.push(at + 1 < word.length ? word.slice(at + 1) : words[index += 1])
      break
    }
  }
  return found
}

/** The file that decides what this runner runs, when it is there, or why the words do not say which one. */
function runnerFile(words, folder) {
  const runner = RUNNERS[nameOf(words[0])]
  const rest = words.slice(1)
  const { files, folders, several } = runnerOptions(rest, runner)
  if (several || files.length > 1 || folders.length > 1) return { problem: `${words[0]} picks among more than one file here, so no one pin says what runs; run it from the one package or file` }
  if (folders[0] === undefined && folders.length === 1) return { problem: `${words[0]}'s folder option has no value, so it is not a file BMN can pin` }
  const base = resolved(folders[0] ?? '.', folder)
  if (files.length === 1) {
    const path = files[0] === undefined ? null : resolved(files[0], base)
    return path !== null && isFile(path) ? { file: path } : { problem: `${files[0] ?? 'the file it names'} is not a file BMN can pin` }
  }
  for (let at = base; ; at = dirname(at)) {
    const path = runner.names.map((name) => join(at, name)).find(isFile)
    if (path !== undefined) return { file: path }
    if (!runner.above || dirname(at) === at) return { file: null }
  }
}

/**
 * The one file these words run, as far as the words say: a script given as the program, an interpreter's script, a runner's file;
 * `null` for a program with none to name; or why it cannot be read for sure. An interpreter or runner by its path reads as itself.
 */
function selectedFile(words, folder) {
  const [program, ...args] = words
  const name = nameOf(program)
  const named = program.includes('/')
  const path = named ? resolved(program, folder) : null
  if (path !== null && !isFile(path)) return { problem: `${program} does not exist yet, so it cannot be pinned` }
  const writable = path !== null && isWritable(path)
  const reads = INTERPRETERS.test(name) || Object.hasOwn(RUNNERS, name)
  if (args.length === 1 && VERSION_ONLY.test(args[0]) && !writable) return { file: null }
  if (writable && !reads) return { file: path }
  // A writable interpreter or runner and the file it reads would both decide what runs; a pin holds one.
  if (writable) return { problem: `${program} can change and so can what it reads, and a card pins one file; name it without its path` }
  if (INTERPRETERS.test(name)) return interpreterFile(name, words, folder)
  if (Object.hasOwn(RUNNERS, name)) return runnerFile(words, folder)
  return { file: path }
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

/** Whether the pin names the file these words select. */
function samePath(one, other) {
  try { return realpathSync(one) === realpathSync(other) } catch { return false }
}

/**
 * The SHA-256 a use is recorded under, or null: the pin's hash, while this command's words still select that file. A file put
 * in front of it (a GNUmakefile beside the pinned Makefile) changes what runs without changing the pin (the full review, finding 2).
 */
export function commandPinSha(term) {
  if (term.script === null || term.script === undefined) return null
  const simple = simpleCommandWords(term.command)
  if ('problem' in simple) return null
  const selected = selectedFile(simple.words, term.folder)
  if ('problem' in selected || selected.file === null || !samePath(selected.file, resolved(term.script.path, term.folder))) return null
  return pinnedFileSha(term.script, term.folder)
}

/** Why `grant ask` refuses this command term, or null (R103-NFR2, D7). It names the reason in words the agent can act on. */
export function grantCommandProblem(term) {
  const simple = simpleCommandWords(term.command)
  if ('problem' in simple) return `${simple.problem} (one simple command, exactly as it will run)`
  const { words } = simple
  const held = heldCommand(term.command, 0, false, term.folder)
  if (held !== null) return `BMN's command guard holds it for the owner: ${held}`
  const never = neverOnACard(words, term.folder)
  if (never !== null) return `${never} is never on a card`
  try {
    if (!statSync(term.folder).isDirectory()) return `${term.folder} is not a folder`
  } catch {
    return `${term.folder} is not a folder`
  }
  const selected = selectedFile(words, term.folder)
  if ('problem' in selected) return selected.problem
  const pin = term.script ?? null
  if (pin !== null) {
    if (namesSecret(pin.path)) return 'a credential is never on a card'
    if (selected.file === null) return 'it runs no file BMN can name, so a pin would say nothing; name the program by its path, or drop the pin'
    if (pinnedFileSha(pin, term.folder) !== pin.sha256) return `${pin.path} does not have the SHA-256 the card names, or cannot be read`
    if (!samePath(selected.file, resolved(pin.path, term.folder))) return `it runs ${selected.file}, so that is the file to pin`
    return null
  }
  if (selected.file !== null && isWritable(selected.file)) return `it runs ${selected.file}, which can change; name that script on the card with its SHA-256`
  return null
}
