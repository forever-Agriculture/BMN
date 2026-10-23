// MODULE: opencode-child-accounting.mjs - Durable child creation intent and conservative lifecycle accounting
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const pathFor = (directory, parent) => join(directory, `child-${createHash('sha256').update(parent).digest('hex')}.json`)
const valid = (value, parent) => value?.version === 1 && value.parent === parent && id(value.parent) && id(value.call) &&
  ['pending', 'settled'].includes(value.intent) && (value.child === null || id(value.child)) &&
  ['pending', 'confirmed'].includes(value.termination) && (value.intent === 'pending' ? value.child === null : value.child !== null)

/** Every persisted field is a fixed status or a native identity; prompts and answers never enter this store. */
export function createChildAccounting(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    begin(parent, call) {
      if (!id(parent) || !id(call)) throw new Error('BMN child accounting identity is unavailable')
      const path = pathFor(directory, parent)
      const state = { version: 1, parent, call, intent: 'pending', child: null, termination: 'pending' }
      const persist = (initial = false) => {
        const target = initial ? path : `${path}.${randomUUID()}.tmp`
        const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        if (!initial) renameSync(target, path)
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
      persist(true)
      return {
        identify(child) {
          if (!id(child) || state.child !== null) throw new Error('BMN child accounting identity is invalid')
          state.child = child; state.intent = 'settled'; persist()
        },
        terminated() { state.termination = 'confirmed'; persist() }
      }
    }
  }
}

/** Missing state is distinct from unreadable state; the consumer combines it with observed tool calls. */
export function readChildAccounting(directory, parent) {
  if (!id(parent)) return { complete: false, children: [], reason: 'the parent identity is unavailable' }
  let fd
  try {
    fd = openSync(pathFor(directory, parent), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) throw new Error('bound')
    const bytes = readFileSync(fd)
    if (bytes.length > 4096) throw new Error('bound')
    const state = JSON.parse(bytes)
    if (!valid(state, parent)) throw new Error('invalid')
    return { complete: state.intent === 'settled' && state.termination === 'confirmed',
      children: state.child === null ? [] : [{ session: state.child, parent: state.parent, role: 'bmn-reader' }],
      ...(state.intent === 'pending' ? { reason: 'child creation has not conclusively settled' } :
        state.termination !== 'confirmed' ? { reason: 'child termination has not been confirmed' } : {}) }
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true, complete: false, children: [] } :
      { complete: false, children: [], reason: 'child accounting could not be read' }
  } finally { if (fd !== undefined) closeSync(fd) }
}
