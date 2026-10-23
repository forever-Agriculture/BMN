// MODULE: command-guard.mjs - Story 83.4: the deny-only guard that holds the clearly critical shell commands for the owner
//
// It decides from the command text alone, inside the hook process: no socket, no file, no state, so it holds while BMN is
// closed. Its only outputs are nothing, Claude Code's `ask` (Claude's own permission prompt, measured in Story 83.1 to show in
// default and auto mode, for an allow-listed command too, and to leave a deny standing) and Codex's block with a reason that
// tells the agent to ask him. It never allows. The pattern list reads shell commands, not comments, string arguments or
// heredoc data. Expansions, explicit shell code and the listed wrappers and package runners are inspected too. This is not
// a shell interpreter or a sandbox: launchers outside that list, encoded code, arbitrary program languages and scripts read
// from disk are outside it; GitHub's rules are the hard guard there.

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
    let command = { words: [], input: [] }
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
      }
      else if (redirect === null) command.words.push(word)
      word = ''; started = false; quoted = false; redirect = null
    }
    const finishCommand = () => {
      finishWord()
      const finished = command
      if (command.words.length > 0) commands.push(command)
      command = { words: [], input: [] }
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
        redirect = { fd: fd ?? (char === '<' ? 0 : 1), document: operator === '<<' || operator === '<<-', tabs: operator === '<<-', hereString: operator === '<<<' }
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
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-r', '--role', '-t', '--type'],
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

/**
 * What the guard holds in executable shell text, or null. A process selector can supply BMN's PID to a kill through a
 * pipeline or substitution; mentions in unrelated string arguments do not supply a target.
 */
export function heldCommand(command, depth = 0, inheritedSelector = false) {
  if (typeof command !== 'string' || command === '') return null
  const commands = shellCommands(command).flatMap((entry) => executables(entry.words).map((words) => ({ ...entry, words })))
  const selectsBmn = inheritedSelector || commands.some(({ words }) => /^(pgrep|pidof|ps|grep|rg|awk|cat)$/.test(nameOf(words[0])) && words.slice(1).some((word) => /\bbmn\b/i.test(word)))
  for (const { words, input, pipe, inputFrom } of commands) {
    const [program, ...args] = words
    const name = nameOf(program)
    if (/^(kill|pkill|killall)$/.test(name) && (selectsBmn || args.some((word) => /\bbmn\b/i.test(word)))) return 'stopping BMN, which only the owner does'
    if (name === 'git') {
      const [verb, ...after] = subcommand(words, ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
      if (verb === 'push') { const held = pushHold(after); if (held !== null) return held }
    }
    if (name === 'gh') {
      const [verb, action, ...after] = subcommand(words, ['-R', '--repo', '--hostname'])
      const held = verb === 'api' ? apiHold([action, ...after]) : verb === 'pr' && action === 'merge' ? mergeHold(after) : null
      if (held !== null) return held
      if (verb === 'repo' && /^(delete|edit|rename|archive|transfer)$/.test(action)) return 'a repository change (delete, edit, rename, archive or transfer)'
      if (verb === 'release' && /^(create|edit|delete)$/.test(action)) return 'a release'
    }
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

/** The guard's answer for one hook event, as printed to the app, or null for nothing: never an allow. */
export function guardAnswer(agent, event) {
  if (event?.hook_event_name !== 'PreToolUse' || GUARDED_TOOLS[agent] === undefined || event.tool_name !== GUARDED_TOOLS[agent]) return null
  const held = heldCommand(event.tool_input?.command)
  if (held === null) return null
  if (agent === 'claude') {
    const reason = `BMN holds ${held} for the owner (his policy: \`bmn policy\`).`
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })
  }
  const reason = `BMN held this command: ${held}. Only the owner approves it; ask him before running it.`
  return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}
