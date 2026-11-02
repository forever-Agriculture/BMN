// MODULE: command-guard.mjs - Story 83.4: the deny-only guard that holds the clearly critical shell commands for the owner
//
// It decides from the command text alone, inside the hook process: no socket, no file, no state, so it needs nothing of a
// running BMN. Its only outputs are nothing, Claude Code's `ask` (Claude's own permission prompt, measured in Story 83.1 to show in
// default and auto mode, for an allow-listed command too, and to leave a deny standing) and Codex's block with a reason that
// tells the agent to ask him. It never allows. The pattern list reads shell commands, not comments, string arguments or
// heredoc data. Expansions, explicit shell code and the listed wrappers and package runners are inspected too. This is not
// a shell interpreter or a sandbox: launchers outside that list, encoded code, arbitrary program languages and scripts read
// from disk are outside it; GitHub's rules are the hard guard there.
import { namesFolderOfSecret, namesSecretFile, underHome } from './secret-list.mjs'

/** The shell tool each app's PreToolUse names, as Story 83.1 measured it (Claude Code 2.1.302, codex-cli 0.162.1). */
export const GUARDED_TOOLS = { claude: 'Bash', codex: 'Bash' }

/**
 * Lex only the shell structure needed by the guard. Keep arguments as words (including quote removal), and collect
 * command/process substitutions separately. Heredocs belong to the command that requested them; their delimiter's
 * quoting controls expansion, and <<- removes leading tabs. Nothing here executes or reads the command's files.
 */
function shellCommands(source, expansionsOnly = false) {
  let index = 0
  const commands = []
  const scan = (end = null, onlyExpansions = false) => {
    let command = { words: [], input: [], reads: [], writes: [] }
    let word = ''
    let started = false
    let quoted = false
    let quote = null
    let ansi = false
    let redirect = null
    const documents = []
    const finishWord = () => {
      if (!started) return
      if (redirect?.document) {
        const document = { ...redirect, delimiter: word, quoted, command }
        documents.push(document)
        if (redirect.fd === 0) command.inputFrom = document
      } else if (redirect?.fd === 0) {
        command.inputFrom = redirect
        command.input = redirect.hereString ? [word] : []
        if (!redirect.hereString) command.reads.push(word)
      }
      else if (redirect?.reading) command.reads.push(word)
      else if (redirect === null) command.words.push(word)
      else if (!redirect.document && !redirect.hereString) command.writes.push(word)
      word = ''; started = false; quoted = false; redirect = null
    }
    const finishCommand = () => {
      finishWord()
      const finished = command
      if (command.words.length > 0) commands.push(command)
      command = { words: [], input: [], reads: [], writes: [] }
      return finished
    }
    const expansion = (processSubstitution) => {
      if (source.startsWith('$(', index) || (processSubstitution && /^[<>]\(/.test(source.slice(index, index + 2)))) {
        index += 2
        scan(')')
        return true
      }
      if (source[index] !== '`') return false
      let body = ''
      index += 1
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && /[`\\$]/.test(source[index + 1] ?? '')) index += 1
        body += source[index++]
      }
      if (source[index] === '`') index += 1
      commands.push(...shellCommands(body))
      return true
    }
    const hereDocuments = () => {
      for (const document of documents.splice(0)) {
        let body = ''
        while (index < source.length) {
          let next = source.indexOf('\n', index)
          if (next < 0) next = source.length
          let line = source.slice(index, next)
          index = Math.min(next + 1, source.length)
          if (document.tabs) line = line.replace(/^\t+/, '')
          if (line === document.delimiter) break
          body += `${line}\n`
        }
        if (document.command.inputFrom === document) document.command.input = [body]
        if (document.quoted) continue
        // Quotes in an expanding heredoc are literal; only backslash and substitutions affect execution.
        commands.push(...shellCommands(body, true))
      }
    }
    while (index < source.length) {
      const char = source[index]
      if (onlyExpansions) {
        if (char === '\\' && /[$`\\\n]/.test(source[index + 1] ?? '')) index += 2
        else if (!expansion(false)) index += 1
      } else if (quote === "'") {
        if (ansi && char === '\\' && index + 1 < source.length) {
          const next = source[++index]
          word += next === "'" || next === '"' ? next : printfEscapes(`\\${next}`)
        } else if (char === "'") { quote = null; ansi = false }
        else word += char
        index += 1
      } else if (char === '\\') {
        const next = source[index + 1]
        if (next === '\n' || (next === '\r' && source[index + 2] === '\n')) index += next === '\n' ? 2 : 3
        else if (next !== undefined && (quote === null || /[$`"\\]/.test(next))) { word += next; started = true; quoted = true; index += 2 }
        else { word += char; started = true; index += 1 }
      } else if ((quote === null || quote === '"') && !redirect?.document && expansion(quote === null)) {
        word += '$()'; started = true
      } else if (quote === '"') {
        if (char === '"') quote = null
        else word += char
        index += 1
      } else if (char === '$' && /['"]/.test(source[index + 1] ?? '')) {
        quote = source[index + 1]; ansi = quote === "'"; quoted = true; started = true; index += 2
      } else if (char === "'" || char === '"') {
        quote = char; quoted = true; started = true; index += 1
      } else if (char === '#' && !started) {
        while (index < source.length && source[index] !== '\n') index += 1
      } else if (char === end) {
        finishCommand(); index += 1; return
      } else if (char === '(') {
        finishCommand(); index += 1; scan(')')
      } else if (/[;|&\n)]/.test(char)) {
        const previous = finishCommand()
        index += 1
        if (char === '|' && source[index] !== '|') {
          command.pipe = previous
          if (source[index] === '&') index += 1
        } else if ((char === '|' || char === '&') && source[index] === char) index += 1
        if (char === '\n') hereDocuments()
      } else if (/\s/.test(char)) {
        finishWord(); index += 1
      } else if (char === '<' || char === '>') {
        const fd = !quoted && /^\d+$/.test(word) ? Number(word) : undefined
        if (fd !== undefined) { word = ''; started = false }
        finishWord()
        const operator = /^(<<<|<<-?|[<>]&|>>?|<>|<)/.exec(source.slice(index))[0]
        redirect = { fd: fd ?? (char === '<' ? 0 : 1), reading: operator === '<' || operator === '<>', document: operator === '<<' || operator === '<<-', tabs: operator === '<<-', hereString: operator === '<<<' }
        index += operator.length
      } else {
        word += char; started = true; index += 1
      }
    }
    finishCommand()
    hereDocuments()
  }
  scan(null, expansionsOnly)
  return commands
}

const nameOf = (word = '') => word.slice(word.lastIndexOf('/') + 1)
const assignments = (word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
const SHELLS = /^(ba|da|z|k)?sh$/
const WRAPPER_VALUES = {
  env: ['-u', '--unset', '-C', '--chdir', '--argv0'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-T', '--command-timeout', '-r', '--role', '-t', '--type'],
  command: [], builtin: [], exec: ['-a'], nohup: [], nice: ['-n', '--adjustment'], setsid: [],
  time: ['-f', '--format', '-o', '--output'], doas: ['-u', '-C'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: ['-n', '--max-args', '-P', '--max-procs', '-L', '--max-lines', '-I', '--replace', '-E', '--eof', '-d', '--delimiter', '-s', '--max-chars', '-a', '--arg-file'],
  stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
  ionice: ['-c', '--class', '-n', '--classdata'],
  'systemd-run': ['-u', '--unit', '-p', '--property', '--description', '--slice', '--service-type', '--uid', '--gid', '--nice',
    '--working-directory', '-E', '--setenv', '-H', '--host', '-M', '--machine', '--on-active', '--on-boot', '--on-startup',
    '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--path-property', '--socket-property', '--timer-property']
}

/** npm, pnpm and yarn options that take a separate value before the subcommand. */
const PACKAGE_VALUES = ['-w', '--workspace', '--prefix', '--registry', '--userconfig', '--filter', '-F', '-C', '--dir']
/** The package runners' options that take a separate value: the subcommand's and the package manager's own. */
const RUNNER_VALUES = [...PACKAGE_VALUES, '-p', '--package', '--resume-from', '--workspace-concurrency', '--allow-build', '--cache',
  '--globalconfig', '--loglevel', '--node-options', '--script-shell', '--tag', '--otp', '--reporter', '--store-dir', '--cwd']
/** Runner options known to take no value; any other option without `=` may take the next word. */
const RUNNER_FLAGS = ['--yes', '-y', '--no', '--quiet', '-q', '--silent', '-s', '--recursive', '-r', '--parallel', '--workspaces',
  '--include-workspace-root', '--offline', '--prefer-offline', '--shell-mode']
/** At most this many places a runner's command may start, and readings of one command, the likeliest first. */
const STARTS = 16
const READINGS = 64

const mayTakeValue = (word) => word !== undefined && word.startsWith('-') && word !== '--' && !word.includes('=') && !RUNNER_FLAGS.includes(word)

/** Words of an `env -S` string as env splits them: blanks and `\_` separate, quotes group, a backslash escapes. */
const splitString = (text) => [...text.replace(/\\_/g, ' ').matchAll(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g)].map(([word]) =>
  word.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (_, single, double, escaped) => single ?? double?.replace(/\\(.)/g, '$1') ?? escaped))

/** env -S's readings: its split words, env's own options included, then the rest; with `\c` (end of string) cut there and not. */
const splitReadings = (value, rest) => (/\\c/.test(value) ? [value.replace(/\\c[\s\S]*$/, ''), value] : [value])
  .flatMap((text) => executables(['env', ...splitString(text), ...rest])).slice(0, READINGS)

/**
 * What npx, `npm exec` (`npm x`), `pnpm exec`, `pnpm dlx`, `yarn exec` and `yarn dlx` run: each reading of their first
 * operand as a program, or with -c, --call or --shell-mode as a shell string; null for any other command. Options before
 * the subcommand count as the runner's, and a word after an option of unknown arity is read both as its value and not.
 */
function packageRunner(list) {
  const name = nameOf(list[0])
  let words
  if (name === 'npx') words = list.slice(1)
  else if (['npm', 'pnpm', 'yarn'].includes(name)) {
    let index = 1
    for (; index < list.length && !/^(exec|dlx|x)$/.test(list[index]); index += 1) {
      if (list[index] === '--' || (!list[index].startsWith('-') && !mayTakeValue(list[index - 1]))) return null
    }
    if (index === list.length) return null
    words = [...list.slice(1, index), ...list.slice(index + 1)]
  } else return null
  // Where the command can start: the first word after the options, and each later word while the word before is an
  // option that may take a value; after `--`, only the next word.
  const starts = []
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '--') { starts.push(index + 1); break }
    if (words[index].startsWith('-')) continue
    if (!RUNNER_VALUES.includes(words[index - 1])) starts.push(index)
    if (!mayTakeValue(words[index - 1])) break
  }
  const options = words.slice(0, starts.length > 0 ? Math.max(...starts) : words.length)
  const call = options.find((word) => word.startsWith('--call='))
  if (call !== undefined) return [['sh', '-c', call.slice('--call='.length)]]
  const shell = options.some((word) => /^(-c|--call|--shell-mode)$/.test(word))
  // The last start (after `--`, or with every option taking a value) and the first (no option taking one) come first.
  const likeliest = [...new Set([starts.at(-1), starts[0], ...starts.slice(1, -1)])].filter((start) => start !== undefined && start < words.length)
  // npm's -c/--call takes the next word as the shell string; pnpm's --shell-mode joins the operands. Read both.
  return likeliest.slice(0, STARTS).flatMap((start) => shell
    ? [['sh', '-c', words.slice(start).join(' ')], ['sh', '-c', words[start]]]
    : [words.slice(start)])
}

/**
 * Every reading of the executable behind ordinary shell wrappers, without interpreting string arguments as commands.
 * There is more than one only where an option's arity is unknown or an `env -S` string ends early; the guard holds a
 * command when any reading holds.
 */
function executables(words) {
  let list = [...words]
  while (list.length > 0) {
    if (assignments(list[0]) || /^(if|then|elif|while|until|do|else|!|\{|\})$/.test(list[0])) { list.shift(); continue }
    if (list[0] === 'function') { list.splice(0, 2); continue }
    const name = nameOf(list[0])
    if (!Object.hasOwn(WRAPPER_VALUES, name)) {
      const runs = packageRunner(list)
      return runs === null || runs.length === 0 ? [list] : runs.flatMap(executables).slice(0, READINGS)
    }
    list.shift()
    while (list[0]?.startsWith('-') && list[0] !== '--') {
      const option = list.shift()
      if (name === 'command' && /^-[pVv]*[Vv][pVv]*$/.test(option)) return [[]]
      if (name === 'env' && /^--split-string(=|$)/.test(option)) return splitReadings(option.includes('=') ? option.slice(option.indexOf('=') + 1) : list.shift() ?? '', list)
      if (name === 'env' && /^-[^-]/.test(option)) {
        // A cluster of env's short options: -u, -C and -a take a value (the rest of the word, else the next word); -S
        // splits its value into arguments.
        const at = option.slice(1).search(/[uCaS]/) + 1
        if (at > 0) {
          const value = at + 1 < option.length ? option.slice(at + 1) : list.shift() ?? ''
          if (option[at] === 'S') return splitReadings(value, list)
        }
        continue
      }
      if (WRAPPER_VALUES[name].includes(option)) list.shift()
    }
    if (list[0] === '--') list.shift()
    if (name === 'timeout') list.shift() // duration
  }
  return [list]
}

const executable = (words) => executables(words)[0]

const printfEscapes = (text) => text.replace(/\\([\\abefnrtv])/g, (_, char) => ({ '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' })[char])

/** Follow only literal shell input producers; this never reads a pipe or a file and never runs printf/echo. */
function pipedInput(entry) {
  if (entry === undefined) return ''
  const [program, ...args] = executable(entry.words)
  const name = nameOf(program)
  if (name === 'cat' && args.length === 0) return entry.inputFrom !== undefined ? entry.input.join('\n') : pipedInput(entry.pipe)
  if (name === 'echo') {
    let escapes = false
    while (/^-[nEe]+$/.test(args[0] ?? '')) { const flags = args.shift(); if (flags.includes('e')) escapes = true; if (flags.includes('E')) escapes = false }
    return escapes ? printfEscapes(args.join(' ')) : args.join(' ')
  }
  if (name !== 'printf' || args[0] === '-v') return ''
  if (args[0] === '--') args.shift()
  const format = printfEscapes(args.shift() ?? '')
  if (/%[^%sb]/.test(format)) return '' // Other format languages are outside literal input inspection.
  let index = 0
  let output = ''
  do {
    output += format.replace(/%([%sb])/g, (_, kind) => {
      if (kind === '%') return '%'
      const value = args[index++] ?? ''
      return kind === 'b' ? printfEscapes(value) : value
    })
  } while (/%[sb]/.test(format) && index < args.length)
  return output
}

/** A shell reads stdin as code only without a script file (or with -s); -n checks syntax without executing it. */
function shellCode(args, input) {
  let stdin = false
  let noexec = false
  let index = 0
  for (; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') { index += 1; break }
    if (option === '--help' || option === '--version') return undefined
    if (option === '--rcfile' || option === '--init-file') { index += 1; continue }
    if (option.startsWith('--')) continue
    if (!/^[-+][A-Za-z]+$/.test(option)) break
    if (option.includes('n')) noexec = option[0] === '-'
    if (option.includes('s')) stdin = option[0] === '-'
    if (option.includes('c') && option[0] === '-') return noexec ? undefined : args[index + 1]
    if (option === '-o' || option === '+o' || option === '-O' || option === '+O') {
      if (args[index + 1] === 'noexec') noexec = option[0] === '-'
      index += 1
    }
  }
  return !noexec && (stdin || index === args.length) ? input.join('\n') : undefined
}

/** Skip options before git/gh's subcommand, including the options with a separate value. */
function subcommand(list, values) {
  let index = 1
  while (list[index]?.startsWith('-')) {
    const option = list[index++]
    if (values.includes(option)) index += 1
    if (option === '--') break
  }
  return list.slice(index)
}

const shortFlags = (word, letters) => /^-[A-Za-z0-9]+$/.test(word) && [...letters].some((letter) => word.slice(1).includes(letter))

/** What a `git ... push` holds, from the words after `push`. */
function pushHold(after) {
  if (after.some((word) => /^--force(-with-lease|-if-includes)?(=|$)/.test(word) || shortFlags(word, 'f') || /^\+./.test(word))) return 'a force push'
  if (after.some((word) => /^--(delete|prune)(=|$)/.test(word) || shortFlags(word, 'd') || /^:./.test(word))) return 'a branch or tag deletion on a remote'
  if (after.some((word) => /^--(mirror|tags|follow-tags)(=|$)/.test(word) || word.includes('refs/tags/'))) return 'a push of tags or a mirror'
  return null
}

const API_PATH = /^\/?repos\/[^/\s]+\/[^/\s?]+(\/?$|\/rulesets(\/|$)|\/branches\/\S+\/protection(\/|$))/

/** A `gh api` call that writes to a repository's own path, its rulesets or its branch protection. */
function apiHold(list) {
  let method = null
  let fields = false
  for (let index = 0; index < list.length; index += 1) {
    const word = list[index]
    const joined = /^(-X|--method)=?(.*)$/.exec(word)
    if (joined) method = (joined[2] || list[index + 1] || '').toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(word)) method = word.slice(2).toUpperCase()
    if (/^-[fF]/.test(word) || /^--(field|raw-field|input)(=|$)/.test(word)) fields = true
  }
  const writes = method === null ? fields : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  return writes && list.some((word) => API_PATH.test(word.split('?')[0])) ? 'a change to a repository, its rulesets or its branch protection' : null
}

/** A `gh pr merge` that bypasses checks, merges later by itself or deletes the branch. */
function mergeHold(list) {
  return list.some((word) => /^--(admin|auto|delete-branch)(=|$)/.test(word) || shortFlags(word, 'd'))
    ? 'a pull request merge with --admin, --auto or --delete-branch' : null
}

/** docker's and podman's options that take a separate value before the subcommand. */
const DOCKER_VALUES = ['-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey',
  '--url', '--identity', '--connection', '--root', '--runroot', '--storage-driver', '--cgroup-manager', '--conmon', '--events-backend',
  '--hooks-dir', '--imagestore', '--network-cmd-path', '--network-config-dir', '--out', '--runtime', '--runtime-flag', '--ssh', '--storage-opt',
  '--tmpdir', '--volumepath', '--cdi-spec-dir', '--db-backend', '--module']
/** Their subcommands whose later words belong to a program inside a container, so a `prune` there is not theirs. */
const DOCKER_RUNS = /^(run|exec|create|cp|commit|build)$/

/** What a `docker`, `podman` or `docker-compose` command holds: a prune in any form, a volume removed, volumes taken down. */
function dockerHold(name, words) {
  const [verb, action, ...after] = subcommand(name === 'docker-compose' ? [words[0], 'compose', ...words.slice(1)] : words, DOCKER_VALUES)
  if (verb === 'volume' && /^(rm|remove)$/.test(action)) return 'removing a Docker volume, which holds real databases'
  if (verb === 'compose') {
    const down = after.indexOf('down')
    const options = action === 'down' ? after : down >= 0 ? after.slice(down + 1) : []
    if (options.some((word) => /^--volumes(=|$)/.test(word) || shortFlags(word, 'v'))) return 'taking Docker volumes down with their containers, which hold real databases'
    return null
  }
  return !DOCKER_RUNS.test(verb ?? '') && [action, ...after].includes('prune') ? 'a Docker or Podman prune' : null
}

/** A forced recursive `rm` of the root, the home folder, or a folder he keeps. */
const KEPT_FOLDERS = ['', 'brain', 'code', 'projects', 'Documents', '.config', '.ssh', '.codex', '.claude', '*']

function removeHold(args) {
  const options = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length).filter((word) => word.startsWith('-'))
  const recursive = options.some((word) => word === '--recursive' || shortFlags(word, 'rR'))
  const forced = options.some((word) => word === '--force' || shortFlags(word, 'f'))
  if (!recursive || !forced) return null
  const targets = args.filter((word) => !word.startsWith('-') || word === '--')
  return targets.some((word) => /^\/+\*?$/.test(word) || KEPT_FOLDERS.includes(underHome(word)))
    ? 'a forced recursive removal of a home or system folder' : null
}

/**
 * A folder where discarding is everyday work: a temporary folder or a run's own worktree (Story 102.2's replay put these commands past
 * its limit of 3 a week per pattern). Told only from a literal absolute path, with its `..` worked out; a symbolic link is not
 * followed, since nothing here reads the disk.
 */
const THROWAWAY = /^(\/tmp|\/var\/tmp|\/run\/user\/\d+)(\/|$)|\/\.claude\/worktrees\/[^/]+(\/|$)/
function isThrowaway(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[$`*?[\]]/.test(path)) return false
  const parts = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return THROWAWAY.test(`/${parts.join('/')}`)
}

/** Wrappers that run the next word where they stand, as plain words: an option, or a change of Git's folder in the environment, may move it. */
const inPlace = (word) => /^(sudo|env|command|nohup|time|timeout|nice)$/.test(nameOf(word)) || /^\d+[smhd]?$/.test(word) || (assignments(word) && !word.startsWith('GIT_'))

/**
 * Whether a command that is a single plain `git`, and nothing else, works in a throwaway folder: the event's, or one absolute `-C`.
 * Any other shape says nothing: a `cd`, a variable, a second `-C`, another Git option or more text on the line is not worked out.
 */
function gitInThrowaway(words, wrappers, cwd) {
  if (!wrappers.every(inPlace)) return false
  const named = words[1] === '-C'
  if (words[named ? 3 : 1]?.startsWith('-')) return false
  return isThrowaway(named ? words[2] : cwd)
}

/**
 * What `git` holds besides pushes: the commands that throw uncommitted work away, outside a throwaway folder. `git reset --hard` and a
 * whole folder's discard are not judged in a command that contains `cd`, `pushd` or `popd`: Story 102.2's replay put them past 3 a week,
 * nearly all of those after a `cd`, and where a `cd` lands is not worked out here. So `cd ~/code/x && git reset --hard` is left to the app.
 */
function discardHold(verb, after, throwaway, movesFolder) {
  // A worktree shares its repository's stash with every other, and no path says a temporary one is its own.
  if (verb === 'stash' && /^(drop|clear)$/.test(after[0] ?? '')) return 'dropping a git stash, which every worktree shares'
  if (throwaway) return null
  if (verb === 'clean' && !after.some((word) => word === '--dry-run' || shortFlags(word, 'n')) && after.some((word) => word === '--force' || shortFlags(word, 'f'))) {
    return 'a git clean, which deletes untracked files'
  }
  if (movesFolder) return null
  if (verb === 'reset' && after.includes('--hard')) return 'a git reset --hard, which discards uncommitted work'
  const onlyStaged = verb === 'restore' && after.some((word) => word === '--staged' || shortFlags(word, 'S')) && !after.some((word) => word === '--worktree' || shortFlags(word, 'W'))
  if (/^(checkout|restore)$/.test(verb ?? '') && !onlyStaged && after.includes('.')) return 'discarding uncommitted changes in the whole folder'
  return null
}

/** Programs that read a file out or send it elsewhere, and of them those that also take a whole folder. */
const READERS = /^(cat|head|tail|less|more|base64|xxd|od|strings|cp|mv|scp|rsync|curl|wget|nc|tar|zip|gpg)$/
const FOLDER_READERS = /^(cp|mv|scp|rsync|tar|zip)$/

/** A command that reads out or sends a file of BMN's secret list, named as an argument or a redirect. */
function secretHold(name, args, reads) {
  if (!READERS.test(name)) return null
  const named = [...args, ...reads].some((word) => namesSecretFile(word) || (FOLDER_READERS.test(name) && namesFolderOfSecret(word)))
  return named ? 'reading or sending a credential file' : null
}

/** Whether an `iommu=soft` this command names, or the text piped or redirected into it, goes into a file: never `echo` or `grep` by themselves. */
function iommuHold({ words, input, pipe, writes }, name, args) {
  const writer = /^(tee|grubby|kernelstub)$/.test(name) || (name === 'sed' && args.some((word) => /^--in-place(=|$)/.test(word) || shortFlags(word, 'i'))) ||
    writes.some((word) => word.startsWith('/etc/') || word.startsWith('/boot/') || /grub/.test(word))
  if (!writer) return null
  const texts = [...words, ...input]
  for (let entry = pipe; entry !== undefined; entry = entry.pipe) texts.push(...entry.words, ...entry.input)
  return texts.some((word) => word.includes('iommu=soft')) ? 'writing iommu=soft, which breaks this laptop\'s graphics' : null
}

/** Destroying infrastructure or deploying to the cloud, from the words after the program. */
function cloudHold(name, args) {
  if (/^(terraform|pulumi|terragrunt)$/.test(name) && (args.includes('destroy') || (args.includes('apply') && args.includes('-destroy')))) {
    return `a ${name} destroy`
  }
  if (name === 'gcloud' && args.some((word, index) => /^(run|app)$/.test(word) && args[index + 1] === 'deploy')) return 'a gcloud deploy'
  return null
}

/**
 * What the guard holds in executable shell text, or null. A process selector can supply BMN's PID to a kill through a
 * pipeline or substitution; mentions in unrelated string arguments do not supply a target.
 */
export function heldCommand(command, depth = 0, inheritedSelector = false, cwd = null) {
  if (typeof command !== 'string' || command === '') return null
  const lexed = shellCommands(command)
  // A listed file read through a redirect, by whatever program: nothing ordinary does that.
  if (lexed.some((entry) => entry.reads.some((word) => namesSecretFile(word)))) return 'reading or sending a credential file'
  const commands = lexed.flatMap((entry) => executables(entry.words).map((words) => ({ ...entry, raw: entry.words, words })))
  const selectsBmn = inheritedSelector || commands.some(({ words }) => /^(pgrep|pidof|ps|grep|rg|awk|cat)$/.test(nameOf(words[0])) && words.slice(1).some((word) => /\bbmn\b/i.test(word)))
  for (const entry of commands) {
    const { words, input, pipe, inputFrom, reads, raw } = entry
    const [program, ...args] = words
    const name = nameOf(program)
    if (/^(kill|pkill|killall)$/.test(name) && (selectsBmn || args.some((word) => /\bbmn\b/i.test(word)))) return 'stopping BMN, which only the owner does'
    if (name === 'git') {
      const [verb, ...after] = subcommand(words, ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
      if (verb === 'push') { const held = pushHold(after); if (held !== null) return held }
      const alone = lexed.length === 1 && commands.length === 1 && depth === 0 && raw.includes(program)
      const held = discardHold(verb, after, alone && gitInThrowaway(words, raw.slice(0, raw.indexOf(program)), cwd), commands.some((other) => /^(cd|pushd|popd)$/.test(nameOf(other.words[0]))))
      if (held !== null) return held
    }
    if (name === 'gh') {
      const [verb, action, ...after] = subcommand(words, ['-R', '--repo', '--hostname'])
      const held = verb === 'api' ? apiHold([action, ...after]) : verb === 'pr' && action === 'merge' ? mergeHold(after) : null
      if (held !== null) return held
      if (verb === 'repo' && /^(delete|edit|rename|archive|transfer)$/.test(action)) return 'a repository change (delete, edit, rename, archive or transfer)'
      if (verb === 'release' && /^(create|edit|delete)$/.test(action)) return 'a release'
      if (/^(secret|variable)$/.test(verb ?? '') && /^(set|delete)$/.test(action ?? '')) return `a change to a repository's ${verb}`
    }
    if (/^(docker|podman|docker-compose)$/.test(name)) { const held = dockerHold(name, words); if (held !== null) return held }
    if (name === 'prime-select' && args.includes('nvidia')) return 'prime-select nvidia, which must stay on-demand on this laptop'
    if (name === 'rm') { const held = removeHold(args); if (held !== null) return held }
    const held = secretHold(name, args, reads) ?? iommuHold(entry, name, args) ?? cloudHold(name, args)
    if (held !== null) return held
    if (['npm', 'pnpm', 'yarn'].includes(name)) {
      const [verb, action] = subcommand(words, PACKAGE_VALUES)
      if (verb === 'publish' || (name === 'yarn' && verb === 'npm' && action === 'publish')) return 'publishing a package'
      if (depth < 16 && name === 'yarn' && (verb === 'workspace' || (verb === 'workspaces' && action === 'foreach'))) {
        const nested = verb === 'workspace' ? args.slice(2) : subcommand(['foreach', ...args.slice(2)], ['--from', '--include', '--exclude', '-j', '--jobs'])
        const held = heldCommand(nested.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' '), depth + 1, selectsBmn)
        if (held !== null) return held
      }
    }
    if (depth < 16 && (name === 'eval' || SHELLS.test(name))) {
      const code = name === 'eval' ? (args[0] === '--' ? args.slice(1) : args).join(' ') : shellCode(args, inputFrom !== undefined ? input : [pipedInput(pipe)])
      const held = heldCommand(code, depth + 1, selectsBmn)
      if (held !== null) return held
    }
  }
  return null
}

/**
 * Story 103.3 (Epic 103, D7): the words of one simple command, exactly as it will run, or why it is not one: no chain, pipe,
 * redirect, substitution, variable, wildcard, wrapper, shell code or assignment. What a card may grant, and nothing the guard
 * would otherwise judge: a command read here still meets `heldCommand` and the app's own rules.
 */
export function simpleCommandWords(source) {
  if (typeof source !== 'string' || source.trim() === '') return { problem: 'it is empty' }
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote === "'") { if (char === "'") quote = null; continue }
    if (char === '\\') { index += 1; continue }
    if (char === '$' || char === '`') return { problem: 'it holds a substitution or a variable, so its text is not what runs' }
    if (quote === '"') { if (char === '"') quote = null; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (/[;|&\n]/.test(char)) return { problem: 'it chains commands; a card grants one simple command' }
    if (/[<>()]/.test(char)) return { problem: 'it holds a redirect or a subshell; a card grants one simple command' }
    if (/[*?[\]{}!#]/.test(char)) return { problem: 'it holds a wildcard or shell syntax, so its text is not what runs' }
  }
  if (quote !== null) return { problem: 'its quotes do not close' }
  const lexed = shellCommands(source)
  if (lexed.length !== 1) return { problem: 'it is not one command' }
  const { words } = lexed[0]
  if (assignments(words[0])) return { problem: 'it sets a variable first, so its text is not all that runs' }
  const name = nameOf(words[0])
  if (name === 'eval' || name === 'source' || name === '.' || name === 'exec') return { problem: `${name} runs other code; a card grants one simple command` }
  if (SHELLS.test(name) && (words.length === 1 || words.slice(1).some((word) => /^-[a-z]*c/.test(word)))) return { problem: 'it runs shell code; a card grants one simple command' }
  const [reading, ...others] = executables(words)
  if (others.length > 0 || reading === undefined || reading.length !== words.length || reading.some((word, index) => word !== words[index])) {
    return { problem: `${name} wraps another program; name the program itself` }
  }
  return { words }
}

/** The guard's answer for one hook event, as printed to the app, or null for nothing: never an allow. */
export function guardAnswer(agent, event) {
  if (event?.hook_event_name !== 'PreToolUse' || GUARDED_TOOLS[agent] === undefined || event.tool_name !== GUARDED_TOOLS[agent]) return null
  const held = heldCommand(event.tool_input?.command, 0, false, typeof event.cwd === 'string' ? event.cwd : null)
  if (held === null) return null
  if (agent === 'claude') {
    const reason = `BMN holds ${held} for the owner (his policy: \`bmn policy\`).`
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })
  }
  const reason = `BMN held this command: ${held}. Only the owner approves it; ask him before running it.`
  return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}
