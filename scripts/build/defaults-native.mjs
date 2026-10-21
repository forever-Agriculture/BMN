// MODULE: defaults-native.mjs - Build the Linux no-replace helper using BMN's existing C toolchain
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../apps/desktop/native/defaults-publish.c', import.meta.url))
export const defaultsNativeOutput = fileURLToPath(new URL('../../apps/desktop/resources/defaults/defaults-publish', import.meta.url))

export function buildDefaultsNative(output = defaultsNativeOutput) {
  if (process.platform !== 'linux') throw new Error('Setup defaults publication supports Linux')
  mkdirSync(dirname(output), { recursive: true })
  const staged = `${output}.build-${process.pid}`
  try {
    execFileSync('/usr/bin/cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', staged], { stdio: 'pipe' })
    chmodSync(staged, 0o755); renameSync(staged, output)
  } finally { rmSync(staged, { force: true }) }
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('defaults-native takes no command-line arguments')
  console.log(`Built ${buildDefaultsNative()}`)
}
