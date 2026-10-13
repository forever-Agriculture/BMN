// MODULE: turn-changes-git.test.ts - holds the whole list of Git commands turn changes may start; fails when one is added, changed, or could write (R69-NFR2, Story 69.2 criterion 5)
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { capture, isRefusal } from './turn-changes-capture'
import {
  TURN_GIT_CANDIDATES, TURN_GIT_COMMANDS, TURN_GIT_OPTIONS, turnGitEnvironment, turnGitExecutable, type TurnGitCall
} from './turn-changes-git'
import { scratch, write, type Place } from './test-fixtures/turn-changes/fixtures'

const here = dirname(fileURLToPath(import.meta.url))
const places: Place[] = []
afterEach(() => {
  for (const made of places.splice(0)) made.done()
})

const ENVIRONMENT = {
  PATH: '/usr/bin:/bin', HOME: '/home/made-up', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0'
}
const OPTIONS = [
  '--no-pager', '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false',
  '-c', 'core.pager=cat', '-c', 'core.sshCommand=false', '-c', 'credential.helper='
]
const COMMANDS = {
  identity: ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir', '--show-object-format', 'HEAD^{commit}'],
  list: ['ls-files', '-z', '-t', '--stage', '--cached', '--others', '--exclude-standard'],
  head: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
  nested: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']
}

describe('the Git commands of turn changes', () => {
  it('are this list, these options and this environment, from a fixed program', () => {
    expect([...TURN_GIT_CANDIDATES]).toEqual(['/usr/bin/git', '/usr/local/bin/git', '/bin/git'])
    expect(turnGitEnvironment('/home/made-up')).toEqual(ENVIRONMENT)
    expect([...TURN_GIT_OPTIONS]).toEqual(OPTIONS)
    expect(JSON.parse(JSON.stringify(TURN_GIT_COMMANDS))).toEqual(COMMANDS)
  })

  it('only read: no command writes, names a Git directory, a work tree or an index, or lifts a refusal', () => {
    // The two Git commands that only print what they are asked about.
    for (const command of Object.values(TURN_GIT_COMMANDS)) expect(['rev-parse', 'ls-files']).toContain(command[0])
    const everything = [...TURN_GIT_OPTIONS, ...Object.values(TURN_GIT_COMMANDS).flat(), ...Object.entries(turnGitEnvironment('/h')).flat()].join('\n')
    for (const never of ['--git-dir', '--work-tree', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG', 'safe.directory', '--exec-path', 'core.worktree']) {
      expect(everything).not.toContain(never)
    }
    // What a settings file could name to start a program or to write is switched off for every command.
    for (const off of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', '--no-lazy-fetch', '--no-optional-locks', '--no-replace-objects', '--no-pager', 'maintenance.auto=false', 'gc.auto=0']) {
      expect(TURN_GIT_OPTIONS).toContain(off)
    }
  })

  it('a capture starts only commands of the list, with exactly those options and that environment, in the root or a repository below it', async () => {
    const at = scratch('git-list')
    places.push(at)
    const nested = join(at.repo, 'nested')
    mkdirSync(nested)
    at.git(nested, 'init', '-q', '-b', 'main')
    write(nested, 'deep.txt', 'd\n')
    at.git(nested, 'add', '-A')
    at.git(nested, 'commit', '-qm', 'nested')
    const calls: TurnGitCall[] = []
    const outcome = await capture(at.repo, { ...at.options, observeGit: (call) => calls.push(call) })
    if (isRefusal(outcome)) throw new Error(outcome.reason)
    outcome.discard()
    expect(calls.map((call) => call.command)).toEqual(['identity', 'list', 'nested', 'head'])
    for (const call of calls) {
      expect(call.executable).toBe(turnGitExecutable())
      expect(call.argv).toEqual([...OPTIONS, '-C', call.folder, ...COMMANDS[call.command]])
      expect(call.env).toEqual({ ...ENVIRONMENT, HOME: at.home, ...(call.command === 'nested' ? { GIT_CEILING_DIRECTORIES: at.repo } : {}) })
      expect(call.folder).toBe(call.command === 'nested' ? nested : at.repo)
    }
  })

  it('is the only place of the feature that starts a process, but for the one question to an agent\'s own program', () => {
    const sources = readdirSync(here).filter((name) => name.startsWith('turn-changes-') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect(sources).toContain('turn-changes-capture.ts')
    for (const name of sources) {
      const text = readFileSync(join(here, name), 'utf8')
      if (name !== 'turn-changes-git.ts' && name !== 'turn-changes-version.ts') expect(text, name).not.toMatch(/child_process|repositoryGit|execFile|\bexec\(|\bspawn\(/)
    }
    const git = readFileSync(join(here, 'turn-changes-git.ts'), 'utf8')
    expect(git.match(/\bspawn\(/g)).toHaveLength(1)
    expect(git).not.toMatch(/execFile|\bexec\(|shell:/)
    // Story 69.4 reads a foreground agent's version by asking the program that process already is, and nothing
    // else: never Git, never a path anybody names, never through a shell, and only after `mayAskProgram`. What
    // runs is the file it opened from `/proc/<pid>/exe` and compared, through that same open file.
    const version = readFileSync(join(here, 'turn-changes-version.ts'), 'utf8')
    expect(version.match(/\bexecFile\(/g)).toHaveLength(1)
    expect(version).toMatch(/held = openSync\(`\/proc\/\$\{pid\}\/exe`, constants\.O_RDONLY\)\n\s+const program = fstatSync\(held, \{ bigint: true \}\)/)
    expect(version).toMatch(/execFile\(`\/proc\/\$\{process\.pid\}\/fd\/\$\{held\}`, \['--version'\], /)
    expect(version).toMatch(/if \(!mayAskProgram\(identity\)\) return Promise\.resolve\(null\)\n\s+return new Promise/)
    // `.exec(` is a regular expression's; a bare `exec(` would be a shell's.
    expect(version).not.toMatch(/\bspawn\(|(?<!\.)\bexec\(|shell:|repositoryGit|turn-changes-git/)
  })

  it('is the list docs/turn-changes.md shows the owner', () => {
    const page = readFileSync(join(here, '../../../../docs/turn-changes.md'), 'utf8').replace(/\s+/g, ' ')
    expect(page).toContain(OPTIONS.join(' '))
    for (const command of Object.values(COMMANDS)) expect(page).toContain(`\`${command.join(' ')}\``)
    for (const [name, value] of Object.entries(ENVIRONMENT)) if (name !== 'HOME') expect(page).toContain(`\`${name}=${value}\``)
    for (const candidate of TURN_GIT_CANDIDATES) expect(page).toContain(`\`${candidate}\``)
  })
})
