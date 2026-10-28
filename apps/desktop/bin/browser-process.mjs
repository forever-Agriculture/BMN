// MODULE: browser-process.mjs - Shared browser/keyring process identities and packaged lifecycle helper resolution.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function processIdentity(pid = process.pid) {
  try { return { pid, ticks: readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] } }
  catch { return { pid, ticks: null } }
}
export function browserLaunchHelper() {
  const packaged = join(dirname(process.execPath), 'resources/bin/browser-accounts-launch.py')
  if (existsSync(packaged)) return packaged
  const source = fileURLToPath(new URL('./browser-accounts-launch.py', import.meta.url))
  if (existsSync(source)) return source
  return fileURLToPath(new URL('../../bin/browser-accounts-launch.py', import.meta.url))
}
