// MODULE: hook-write-observer.ts - Observe writes, including same-byte rewrites, to isolated hook/native files.
import { watch } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { setImmediate, setTimeout } from 'node:timers/promises'

/** Watch parent directories so an atomic replacement is seen as well as an in-place write. */
export async function observeHookWrites(paths: string[], operation: () => unknown | Promise<unknown>): Promise<string[]> {
  const targets = new Set(paths.map(path => resolve(path)))
  const seen = new Set<string>()
  const watchers = [...new Set(paths.map(path => dirname(resolve(path))))].map(parent => watch(parent, (_event, name) => {
    // A missing name cannot establish which file changed: fail the no-write assertion conservatively.
    if (name === null) seen.add('unknown file')
    else if (targets.has(resolve(parent, name))) seen.add(basename(name))
  }))
  try {
    await operation()
    // Synchronous CLI children block this loop; drain their queued filesystem events before checking.
    await setTimeout(50)
    await setImmediate()
    return [...seen].sort()
  } finally { for (const watcher of watchers) watcher.close() }
}
