// MODULE: bench-lib.mjs - validated shell actions, disposable environment and process identities for the QA bench
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

export function benchArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    stop: { type: 'boolean' }, 'no-build': { type: 'boolean' },
    electron: { type: 'string' }, binary: { type: 'string' }, port: { type: 'string', default: '0' }
  } })
  if (!/^\d+$/u.test(values.port) || Number(values.port) > 65535) throw new Error('Port must be an integer from 0 to 65535')
  if (values.stop && positionals.length) throw new Error('--stop takes no action')
  if (values.electron && values.binary) throw new Error('Choose --electron or --binary')
  if (positionals.length && positionals[0] !== 'do') throw new Error('Expected do <snapshot|click|type|press|screenshot>')
  if (positionals.length) validateAction(positionals.slice(1))
  return { ...values, port: Number(values.port), action: positionals.length ? positionals.slice(1) : null }
}

export function validateAction(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Action arguments must be strings')
  const lengths = { snapshot: 1, click: 2, type: 3, press: 2, screenshot: 2, stop: 1 }
  if (lengths[args[0]] !== args.length) throw new Error('Invalid action or argument count')
  if (args.some(value => value.length > 65536)) throw new Error('Action argument is too long')
  if (args[0] === 'screenshot' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}(?:\.png)?$/u.test(args[1])) {
    throw new Error('Screenshot name must be a plain filename (letters, digits, - or _)')
  }
  return args
}

export function disposableEnvironment(root) {
  return {
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: join(root, 'home'), USER: 'qa', SHELL: '/bin/bash', LANG: 'C.UTF-8', TZ: 'UTC',
    ...Object.fromEntries(['config', 'data', 'state', 'cache', 'runtime'].map(name => [`XDG_${name.toUpperCase()}_${name === 'runtime' ? 'DIR' : 'HOME'}`, join(root, name)])),
    ...Object.fromEntries(['config', 'data', 'state', 'runtime'].map(name => [`BMN_${name.toUpperCase()}_HOME`, join(root, name, 'bmn')])),
    CLAUDE_CONFIG_DIR: join(root, 'config/claude'), CODEX_HOME: join(root, 'config/codex'), OPENCODE_CONFIG_DIR: join(root, 'config/opencode'),
    BMN_LAUNCH_CWD: join(root, 'synthetic-project'), TMPDIR: join(root, 'tmp')
  }
}

export function loopbackEndpoint(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listening port')
  return `http://127.0.0.1:${port}`
}

export function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export function processIdentity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const stat = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    return { pid: Number(pid), start_ticks: stat[19], ppid: Number(stat[1]), state: stat[0] }
  } catch { return null }
}

export function isLiveProcess(recorded) {
  const live = recorded && processIdentity(recorded.pid)
  return Boolean(live && live.state !== 'Z' && live.start_ticks === recorded.start_ticks)
}

