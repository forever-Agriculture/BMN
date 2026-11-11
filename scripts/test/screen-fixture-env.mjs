// MODULE: screen-fixture-env.mjs - screen fixtures never inherit the owner's app profiles or startup opt-ins.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function screenFixtureEnvironment(root) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return {
    PATH: '/usr/bin:/bin', HOME: home, SHELL: '/bin/bash', LANG: 'C.UTF-8', TZ: 'UTC',
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {})
  }
}
