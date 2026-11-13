// MODULE: update-restart-launcher-fixture.mjs - production launcher with an isolated synthetic update service
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launcherScript } from '../lib/desktop-launcher.mjs'
const quote = text => `'${text.replaceAll("'", "'\\''")}'`
export function useProductionRestartLauncher(fixture, port, failed = false, blockedExecutable = null) {
  const bin = join(fixture.out, 'launcher-tools'); mkdirSync(bin, { recursive: true })
  const state = join(fixture.stateDir, 'latest.json')
  const checks = join(fixture.out, 'launcher-service-checks')
  for (const path of [checks, join(fixture.out, 'reopened-pid'), join(fixture.out, 'launcher-dialog-arguments')]) rmSync(path, { force: true })
  const binary = join(fixture.out, 'synthetic-bmn')
  const finalState = JSON.stringify({ phase: failed ? 'failed' : 'complete', commit: '1234567890abcdef', ...(failed ? { liveBuild: 'previous' } : {}) })
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
printf 'check\\n' >> ${quote(checks)}
if [ "$(wc -l < ${quote(checks)})" -gt 2 ]; then
  printf '%s\\n' ${quote(finalState)} > ${quote(state)}
  exit 1
fi
exit 0
`, { mode: 0o700 })
  writeFileSync(join(bin, 'zenity'), `#!/bin/sh
printf '%s\\n' "$@" >> ${quote(join(fixture.out, 'launcher-dialog-arguments'))}
case "$1" in --progress) while IFS= read -r line; do :; done ;; esac
exit 0
`, { mode: 0o700 })
  writeFileSync(binary, `#!/bin/sh
printf '%s\\n' "$$" > ${quote(join(fixture.out, 'reopened-pid'))}
export PATH=${quote(fixture.env.PATH)}
${blockedExecutable ? `/bin/mv ${quote(blockedExecutable)} ${quote(`${blockedExecutable}.blocked-for-check`)}\n` : ''}exec ${quote(fixture.executablePath)} ${quote(join(fixture.repo, 'apps/desktop'))} --ozone-platform=headless --bmn-test-mode --remote-debugging-port=${port} >> ${quote(join(fixture.out, 'reopened-electron.log'))} 2>&1
`, { mode: 0o700 })
  fixture.env.PATH = `${bin}:${fixture.env.PATH}`
  writeFileSync(fixture.launcher, launcherScript({ binary, statusPath: state, unit: 'bmn-121-synthetic.service' }), { mode: 0o700 })
}
