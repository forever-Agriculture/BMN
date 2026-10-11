// MODULE: cli-modules.mjs - the files the bmn CLI loads by relative path, read from its own source
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every `./name.mjs` the CLI can load from `binDirectory`, starting at `entry` and following
 * static and dynamic imports to the end. A packaged build must carry each one beside bmn.mjs:
 * a missing file breaks its command, and the prompt guard reads a missing file as "no guard".
 */
export function cliModules(binDirectory, entry = 'bmn') {
  const found = new Set()
  const pending = [entry]
  while (pending.length > 0) {
    const source = readFileSync(join(binDirectory, pending.pop()), 'utf8')
    for (const [, name] of source.matchAll(/(?:from|import\()\s*['"]\.\/([\w-]+\.mjs)['"]/gu)) {
      if (found.has(name)) continue
      found.add(name)
      pending.push(name)
    }
  }
  return [...found].sort()
}
