/* global window, document, HTMLDialogElement, Element, MutationObserver */
// MODULE: update-restart-fixture.mjs - isolated roots and owned Electron processes for both restart flows
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync, renameSync, mkdtempSync, readlinkSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'

/** `base`: where the run's own roots go (a live run with real agents keeps them below the tests' home); `runtimeBase` likewise. */
export function createUpdateRestartFixture({ base = null, runtimeBase = tmpdir(), extraEnv = {} } = {}) {
const repo = resolve(import.meta.dirname, '../..')
const out = join(base ?? join(repo, '.dev-auto/evidence/update-restart-runtime'), String(Date.now()))
mkdirSync(out, { recursive: true })
const runtime = mkdtempSync(join(runtimeBase, 'bmn-restart-runtime-'))
const roots = Object.fromEntries(['config', 'data', 'state', 'cache'].map(name => { const path = join(out, name); mkdirSync(path); return [name, path] }))
const stateDir = join(roots.state, 'bmn/source-update'); mkdirSync(stateDir, { recursive: true })
const launcher = join(out, 'stub-launcher')
writeFileSync(launcher, `#!/bin/sh\n# BMN update restart v1\n[ "$BMN_RESTART_ACK" = 1 ] && { printf 'READY\\n' >&3; exec 3>&-; }\nprintf 'armed\\n' > '${out}/launcher-armed'\nwhile [ "$(sed 's/.*) //' "/proc/$BMN_RESTART_WAIT_PID/stat" 2>/dev/null | awk '{print $20}')" = "$BMN_RESTART_WAIT_TICKS" ]; do sleep 0.1; done\n[ "$(cat "$BMN_RESTART_AUTH_PATH" 2>/dev/null)" = "$BMN_RESTART_AUTH_ID launch" ] || exit 0\nprintf 'old instance exited\\n' > '${out}/launcher-after-exit'\n`, { mode: 0o700 })
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BMN_')))
const env = { ...inherited, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
  XDG_RUNTIME_DIR: runtime, BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'), BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(runtime, 'bmn'), BMN_TEST_RESTART_LAUNCHER: launcher, BMN_LAUNCH_CWD: out, ...extraEnv }
// Linked worktrees may use the default checkout's AppArmor-approved Electron (docs/development.md).
const executablePath = process.env.BMN_TEST_ELECTRON_BINARY ?? createRequire(join(repo, 'apps/desktop/package.json'))('electron')
const launches = [], tracedPages = new WeakSet()
async function tracePage(page) {
  if (!tracedPages.has(page)) {
    tracedPages.add(page)
    await page.addInitScript(installTrace)
    page.on('console', message => {
    const text = message.text()
    if (text.startsWith('BMN121TESTTRACE:')) appendFileSync(join(out, 'ui-events.jsonl'), text.slice('BMN121TESTTRACE:'.length) + '\n')
    })
  }
  await page.evaluate(installTrace)
}
function installTrace() {
    if (window.__bmn121UiTrace) return
    window.__bmn121UiTrace = []
    const record = detail => {
      const row = { at: Date.now(), ...detail }; window.__bmn121UiTrace.push(row)
      console.log('BMN121TESTTRACE:' + JSON.stringify(row))
    }
    for (const kind of ['cancel', 'close']) document.addEventListener(kind, event => {
      if (event.target instanceof HTMLDialogElement) record({ kind, label: event.target.getAttribute('aria-label'), trusted: event.isTrusted })
    }, true)
    document.addEventListener('keydown', event => { if (event.key === 'Escape') record({ kind: 'escape', trusted: event.isTrusted }) }, true)
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('dialog button') : null
      if (button) record({ kind: 'button', text: button.textContent?.trim(), label: button.closest('dialog')?.getAttribute('aria-label'), trusted: event.isTrusted })
    }, true)
    const seen = new WeakSet()
    const inspect = () => {
      for (const dialog of document.querySelectorAll('dialog[open]')) if (!seen.has(dialog)) {
        seen.add(dialog); record({ kind: 'shown', label: dialog.getAttribute('aria-label') })
      }
    }
    new MutationObserver(inspect).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-label'] })
    inspect()
}
function persistJson(path, value) {
  const temp = path + '.tmp', fd = openSync(temp, 'w', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path)
  const directory = openSync(join(path, '..'), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function record(pid, label, cdpPort = null) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)
  const item = { kind: 'process', pid, start_ticks: fields[19], command: label,
    exe: readlinkSync(`/proc/${pid}/exe`), ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]),
    cdpPort, runFolder: out, cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8'), driverCgroup: readFileSync('/proc/self/cgroup', 'utf8') }
  launches.push(item)
  persistJson(join(out, 'owned-identities.json'), launches)
  // A dev-auto run also lists what it started in its handoff; without one, owned-identities.json above is the record.
  const path = join(repo, '.dev-auto/handoff.md'); if (!existsSync(path)) return
  const source = readFileSync(path, 'utf8')
  const marker = '## Started\n'; assert(source.includes(marker))
  const updated = source.replace(marker, `${marker}\n- ${JSON.stringify({ kind: item.kind, pid, start_ticks: item.start_ticks, command: label })}\n`)
  writeFileSync(`${path}.runtime.tmp`, updated); renameSync(`${path}.runtime.tmp`, path)
  const checked = spawnSync('python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'check'], { cwd: repo, encoding: 'utf8', timeout: 35000 })
  assert.equal(checked.status, 0, checked.stdout)
}
function cleanup() {
  const results = []
  for (const owned of launches) {
    const inventory = spawnSync('python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'leftovers', repo], { encoding: 'utf8', timeout: 35000 })
    appendFileSync(join(out, 'cleanup-inventory.log'), inventory.stdout ?? 'inventory unavailable\n')
    const stopped = spawnSync('python3', ['-c', `
import os,sys,signal,select,json
x=json.loads(sys.argv[1]);pid=x['pid'];result={'pid':pid,'start_ticks':x['start_ticks']}
try:
 fd=os.pidfd_open(pid)
 try:
  def matches():
   try:
    stat=open(f'/proc/{pid}/stat').read().rsplit(')',1)[1].split()
    if stat[19]!=x['start_ticks']:return False
    if os.readlink(f'/proc/{pid}/exe')!=x['exe']:raise RuntimeError('recorded executable changed')
    return True
   except (FileNotFoundError,ProcessLookupError):return False
  if not matches():result['state']='exited-or-replaced'
  else:
   signal.pidfd_send_signal(fd,signal.SIGTERM)
   if select.select([fd],[],[],5)[0]:result['state']='terminated'
   elif matches():
    signal.pidfd_send_signal(fd,signal.SIGKILL)
    result['state']='killed' if select.select([fd],[],[],5)[0] else 'alive'
   else:result['state']='exited-or-replaced'
 finally:os.close(fd)
except (FileNotFoundError,ProcessLookupError):result['state']='exited'
except Exception as e:result.update(state='unverified',error=type(e).__name__)
print(json.dumps(result))
`, JSON.stringify(owned)], { encoding: 'utf8', timeout: 15000 })
    let result
    try { result = JSON.parse(stopped.stdout) } catch { result = { pid: owned.pid, state: 'unverified', error: 'cleanup subprocess did not return a receipt' } }
    results.push(result)
  }
  const result = { result: results.every(row => !['alive', 'unverified'].includes(row.state)) ? 'PASS' : 'FAIL', results }
  persistJson(join(out, 'cleanup-receipt.json'), result)
  return result
}
async function launch(args = []) {
  const app = await electron.launch({ executablePath, chromiumSandbox: true, args: [join(repo, 'apps/desktop'), '--ozone-platform=headless', '--bmn-test-mode', ...args], cwd: repo, env })
  record(app.process().pid, 'isolated Electron runtime (update restart test)')
  app.process().stderr?.on('data', bytes => appendFileSync(join(out, `electron-${app.process().pid}.stderr.log`), bytes))
  const page = await app.firstWindow(); page.on('pageerror', e => console.error('PAGEERROR', e.message))
  await tracePage(page)
  await page.waitForFunction(() => Boolean(window.aiTerminal), { timeout: 30_000 })
  await page.setViewportSize({ width: 680, height: 720 })
  return { app, page }
}
return { repo, out, runtime, roots, stateDir, launcher, env, executablePath, launches, record, launch, tracePage, persistJson, cleanup }
}
