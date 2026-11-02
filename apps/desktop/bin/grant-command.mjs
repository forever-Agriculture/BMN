// MODULE: grant-command.mjs - Story 103.3: what `bmn grant ask` refuses of a `command` term, read with the command guard's parser, and the hash of a file a card pins
//
// Run in BMN when a card is asked, never when a stored card is read: a guard that holds more tomorrow must not make today's
// record unreadable. It reads the words only and runs nothing. A runner's own file (a Makefile, a package.json) is pinned like a
// script; what that file then runs, and an alias in his own config, are the limits docs/agent-control.md names. Where the words
// do not say for sure which file runs, it refuses rather than guesses: a runner is read by a short grammar and any other option
// refuses, and Docker is not read as words at all (the epic's consultant, after a table of options failed twice). A refusal costs
// little: the agent puts the step in a script the card pins, or it waits for the morning.
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GH_VALUES, GIT_VALUES, heldCommand, simpleCommandWords, subcommand } from './command-guard.mjs'
import { namesSecretFile } from './secret-list.mjs'

/** Programs that take a script as their first argument. */
const INTERPRETERS = /^((ba|da|z|k)?sh|python[\d.]*|node|ruby|perl|php|lua|deno|bun|tsx|ts-node)$/
/** An option of those that runs the code it is given. */
const INLINE_CODE = /^-(c|e|p|-eval|-print|-command)$/
const VERSION_ONLY = /^(-v|-V|--version|-h|--help)$/
const PIN_LIMIT_BYTES = 16 * 1024 * 1024
/** The guard's own tables: each tool's options that take the next word as their value, before its verb. */
const GLOBAL_OPTIONS = { git: GIT_VALUES, gh: GH_VALUES }
/** Those a card may use: anything else before the verb can change what runs, or hide the verb behind an option's value. */
const GIT_OWN = { values: ['-C'], flags: ['-P', '--no-pager'] }
const GH_OWN = { values: ['-R', '--repo'], flags: [] }
/**
 * A runner's own file decides what it runs, so a writable one is pinned like a script (D7; the epic pre-review). What make and
 * just read: how each is told its file and folder, flags that take no value; `above` walks up to find it, as just does.
 */
const FILE_RUNNERS = {
  make: { names: ['GNUmakefile', 'makefile', 'Makefile'], above: false, fileLong: ['--file', '--makefile'], fileShort: 'f', folderLong: ['--directory'], folderShort: 'C', flags: 'sknBw', longFlags: ['--silent', '--keep-going', '--dry-run', '--always-make'], jobs: true },
  just: { names: ['justfile', 'Justfile', '.justfile'], above: true, fileLong: ['--justfile'], fileShort: 'f', folderLong: ['--working-directory'], folderShort: 'd', flags: '', longFlags: [], jobs: false }
}
/** The one folder option each package manager is read with, exactly; `run SCRIPT` is all else, with arguments after `--`. */
const PACKAGE_FOLDER = { npm: ['--prefix'], pnpm: ['-C', '--dir'], yarn: ['--cwd'] }

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
const PUBLISHERS = /^(cargo|poetry|vsce|ovsx|uv|hatch|flit|deno)$/

/** What git's own words delete or discard, whatever option comes first. */
function gitNever(args, has, folder) {
  const [first] = args
  if (GIT_DELETING.test(first ?? '')) return 'a deletion'
  if (first === 'credential') return 'a credential'
  if (first === 'branch' && args.some((word) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(word))) return 'a deletion'
  if (first === 'tag' && args.length > 1 && !has('-l', '--list')) return 'a release tag'
  if (first === 'worktree' && has('remove', 'prune')) return 'a deletion'
  if (first === 'reflog' && has('expire', 'delete')) return 'a deletion'
  if (first === 'remote' && has('remove', 'rm')) return 'a deletion'
  if ((first === 'update-ref' || first === 'symbolic-ref') && has('-d', '--delete')) return 'a deletion'
  if (first === 'reset' && has('--hard', '--merge', '--keep')) return 'a deletion of uncommitted work'
  if (first === 'restore') return 'a deletion of uncommitted work'
  if (first === 'switch' && has('-f', '--force', '--discard-changes')) return 'a deletion of uncommitted work'
  if (first === 'checkout') {
    // `git checkout NAME` moves to a branch, unless NAME is a file here: then it throws that file's changes away.
    if (has('--', '.', '-f', '--force')) return 'a deletion of uncommitted work'
    if (args.slice(1).some((word) => !word.startsWith('-') && isFile(resolved(word, folder)))) return 'a deletion of uncommitted work'
  }
  if (first === 'stash' && has('drop', 'clear')) return 'a deletion'
  return null
}

/** Whether a tool's own words before its verb are only what a card may use. */
function ownOptionsRead(own, { values, flags }) {
  for (let index = 0; index < own.length; index += 1) {
    if (values.includes(own[index])) index += 1
    else if (!flags.includes(own[index]) && !values.some((option) => option.startsWith('--') && own[index].startsWith(`${option}=`))) return false
  }
  return true
}

/** Which of GRANT_NEVER_ON_A_CARD this command is, beyond what the guard holds; null when it is none. */
function neverOnACard(words, folder) {
  const [program] = words
  const name = nameOf(program)
  // `git -C x clean`, `docker --context y rm`: the verb comes after the tool's own options (the guard's own reading).
  const args = Object.hasOwn(GLOBAL_OPTIONS, name) ? subcommand(words, GLOBAL_OPTIONS[name]) : words.slice(1)
  const has = (...flags) => args.some((word) => flags.includes(word))
  const [first, second] = args
  const own = words.slice(1, words.length - args.length)
  if (/^(rm|rmdir|unlink|shred|truncate|wipefs|dd|trash|trash-put)$/.test(name) || /^mkfs(\.|$)/.test(name)) return 'a deletion'
  if (name === 'gio' && (first === 'trash' || first === 'remove')) return 'a deletion'
  if (name === 'find' && has('-delete')) return 'a deletion'
  if (name === 'find' && has('-exec', '-execdir', '-ok', '-okdir')) return 'starting another program'
  if (name === 'rsync' && args.some((word) => /^--(delete|remove-source-files)/.test(word))) return 'a deletion'
  if (name === 'git') {
    const never = gitNever(args, has, folder)
    if (never !== null) return never
    // One command's own config can name what runs: an alias, an ssh command, a pager. Past it, an option's value can hide the verb.
    if (!ownOptionsRead(own, GIT_OWN)) return 'a git config or option before its verb, which can change what runs,'
  }
  if (name === 'gh') {
    if (first === 'release') return 'a release'
    if (first === 'auth' && (['token', 'login', 'refresh', 'setup-git'].includes(second) || has('--show-token', '-t'))) return 'a credential'
    if (first === 'pr' && has('--delete-branch', '-d')) return 'a deletion'
    if (first !== 'api' && has('delete')) return 'a deletion'
    if (!ownOptionsRead(own, GH_OWN)) return 'an option before gh\'s verb, which can hide it,'
  }
  // A request's own method: `gh api -X DELETE`, `curl --request=delete`, `curl -XDELETE`, `curl -sX DELETE`.
  if ((name === 'gh' && first === 'api') || name === 'curl' || name === 'wget') {
    const deleting = args.some((word, index) => /^(-[a-zA-Z]*X|--request|--method)=?delete$/i.test(word) || (/^(-[a-zA-Z]*X|--request|--method)$/.test(word) && /^delete$/i.test(args[index + 1] ?? '')))
    if (deleting) return 'a deletion'
  }
  // Not read as words: a publish needs no such verb (`docker buildx build --output=type=registry`), and an option's value can be
  // any word. A step of theirs goes in a script the card pins, whose whole text is then the agent's to show.
  if (/^(docker|podman|docker-compose)$/.test(name)) return `${name}, whose words can hide a deletion or a publish, goes in a script the card pins; as words it`
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

/** What make or just is told, or why BMN cannot read it for sure: only the runner's known options, no variable, no path to a recipe. */
function fileRunnerOptions(rest, runner, name) {
  const found = { files: [], folders: [] }
  const unsure = (word) => ({ problem: `${word} is not what BMN reads for sure on ${name}; put the step in a script the card pins` })
  let options = true
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]
    if (word === '--' && options) { options = false; continue }
    if (!options || !word.startsWith('-')) {
      // `make SHELL=./x`, `just A=1`, `just sub/recipe`: each changes what runs.
      if (word.includes('=') || (name === 'just' && word.includes('/'))) return unsure(word)
      continue
    }
    if (runner.longFlags.includes(word)) continue
    if (word.startsWith('--')) {
      const long = (list, into) => {
        if (list.includes(word)) { into.push(rest[index += 1]); return true }
        const joined = list.find((option) => word.startsWith(`${option}=`))
        if (joined === undefined) return false
        into.push(word.slice(joined.length + 1))
        return true
      }
      if (long(runner.fileLong, found.files) || long(runner.folderLong, found.folders)) continue
      return unsure(word)
    }
    for (let at = 1; at < word.length; at += 1) {
      const letter = word[at]
      if (runner.flags.includes(letter)) continue
      if (runner.jobs && letter === 'j' && /^\d+$/.test(word.slice(at + 1))) break
      const into = runner.fileShort === letter ? found.files : runner.folderShort === letter ? found.folders : null
      if (into === null) return unsure(word)
      into.push(at + 1 < word.length ? word.slice(at + 1) : rest[index += 1])
      break
    }
  }
  return found
}

/** The file that decides what make or just runs, when it is there, or why the words do not say which one. */
function fileRunnerFile(words, folder) {
  const name = nameOf(words[0])
  const runner = FILE_RUNNERS[name]
  const read = fileRunnerOptions(words.slice(1), runner, name)
  if ('problem' in read) return read
  const { files, folders } = read
  if (files.length > 1 || folders.length > 1) return { problem: `${words[0]} is told more than one file or folder here, so no one pin says what runs` }
  if (folders.length === 1 && folders[0] === undefined) return { problem: `${words[0]}'s folder option has no value, so it is not a file BMN can pin` }
  const base = resolved(folders[0] ?? '.', folder)
  if (files.length === 1) {
    const path = files[0] === undefined ? null : resolved(files[0], base)
    return path !== null && isFile(path) ? { file: path } : { problem: `${files[0] ?? 'the file it names'} is not a file BMN can pin` }
  }
  for (let at = base; ; at = dirname(at)) {
    const path = runner.names.map((one) => join(at, one)).find(isFile)
    if (path !== undefined) return { file: path }
    if (!runner.above || dirname(at) === at) return { file: null }
  }
}

/** A package manager's file: `NAME [one folder option] run SCRIPT [-- ARGS]`, for a script that file has. Bare names can be its built-ins. */
function packageFile(words, folder) {
  const name = nameOf(words[0])
  const rest = words.slice(1)
  const options = PACKAGE_FOLDER[name]
  const joined = options.find((option) => option.startsWith('--') && rest[0]?.startsWith(`${option}=`))
  const given = options.includes(rest[0]) ? rest[1] : joined === undefined ? null : rest[0].slice(joined.length + 1)
  const [verb, script, after] = rest.slice(options.includes(rest[0]) ? 2 : joined === undefined ? 0 : 1)
  if (given === undefined || (verb !== 'run' && verb !== 'run-script') || script === undefined || script.startsWith('-') || (after !== undefined && after !== '--')) {
    return { problem: `${name} reads only as \`${name} run SCRIPT -- ARGS\`, from one folder; anything else goes in a script the card pins` }
  }
  for (let at = resolved(given ?? '.', folder); ; at = dirname(at)) {
    const path = join(at, 'package.json')
    if (isFile(path)) {
      let scripts = null
      try { scripts = JSON.parse(readFileSync(path, 'utf8')).scripts } catch { /* below */ }
      return scripts !== null && typeof scripts === 'object' && Object.hasOwn(scripts, script) ? { file: path } : { problem: `${script} is not a script in ${path}` }
    }
    if (dirname(at) === at) return { problem: `${name} finds no package.json from there, so there is no script to run` }
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
  const reads = INTERPRETERS.test(name) || Object.hasOwn(FILE_RUNNERS, name) || Object.hasOwn(PACKAGE_FOLDER, name)
  if (args.length === 1 && VERSION_ONLY.test(args[0]) && !writable) return { file: null }
  if (writable && !reads) return { file: path }
  // A writable interpreter or runner and the file it reads would both decide what runs; a pin holds one.
  if (writable) return { problem: `${program} can change and so can what it reads, and a card pins one file; name it without its path` }
  if (INTERPRETERS.test(name)) return interpreterFile(name, words, folder)
  if (Object.hasOwn(FILE_RUNNERS, name)) return fileRunnerFile(words, folder)
  if (Object.hasOwn(PACKAGE_FOLDER, name)) return packageFile(words, folder)
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
