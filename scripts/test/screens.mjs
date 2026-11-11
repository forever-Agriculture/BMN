// MODULE: screens.mjs - build once, then run the desktop screen gates on a private display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const run = (command, args, env = process.env) => spawnSync(command, args, { cwd: repo, env, stdio: 'inherit' })
const finish = (name, result) => {
  if (result.error || result.signal || result.status !== 0) {
    console.error(`FAIL: ${name}: ${result.error?.message ?? result.signal ?? result.status}`)
    process.exit(result.status || 1)
  }
}
if (!process.argv.includes('--display-ready')) {
  finish('build', run('pnpm', ['run', 'build']))
  const env = { ...process.env }
  delete env.WAYLAND_DISPLAY
  finish('private screen display', run('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, fileURLToPath(import.meta.url), '--display-ready'], env))
} else {
  const output = join(repo, '.dev-auto/evidence/screens', new Date().toISOString().replaceAll(':', '-'))
  mkdirSync(output, { recursive: true })
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(output, 'revision.json'), JSON.stringify({ commit: git('rev-parse', 'HEAD'), changes: git('status', '--porcelain') }, null, 2))
  for (const name of ['keyboard-catalogue', 'notification-layout', 'refinements-navigation', 'electron-visual']) {
    console.log(`SCREEN: ${name}`)
    const args = [join(repo, `scripts/test/${name}.mjs`)]
    if (name === 'electron-visual') args.push('--out', join(output, name))
    finish(name, run(process.execPath, args, { ...process.env, BMN_NOTIFICATION_EVIDENCE: join(output, 'notification-layout') }))
    console.log(`PASS: ${name}`)
  }
}
