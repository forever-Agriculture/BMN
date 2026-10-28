// MODULE: browser-accounts-fixture.mjs - Private D-Bus/keyring and loopback sign-in contracts for Epic 97 live checks.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicJson } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { authenticatorCode } from '../../apps/desktop/bin/browser-account-relay.mjs'

export function recordProcess(pid, command) {
  const start_ticks = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
  const entry = { kind: 'process', pid, start_ticks, command }
  const file = resolve('.dev-auto/handoff.md'), body = readFileSync(file, 'utf8')
  const start = body.indexOf('## Started\n'), end = body.indexOf('\n## ', start + 1), retired = []
  assert(start >= 0 && end > start, 'Started section')
  const kept = body.slice(start, end).split('\n').filter(line => line.startsWith('- {')).filter(line => {
    const identity = JSON.parse(line.slice(2))
    if (identity.kind !== 'process') return true
    try {
      const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(') ')[1].split(' ')
      if (stat[0] !== 'Z' && stat[19] === String(identity.start_ticks)) return true
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return true }
    retired.push(line); return false
  })
  const next = body.slice(0, start) + '## Started\n\n' + [`- ${JSON.stringify(entry)}`, ...kept].join('\n') + '\n' + body.slice(end)
  if (retired.length) appendFileSync(resolve('.dev-auto/log.md'), '\nObserved stopped fixture identities (host /proc):\n' + retired.join('\n') + '\n')
  const temp = `${file}.tmp`; writeFileSync(temp, next)
  // The lead is the only handoff writer during a live run.
  renameSync(temp, file)
  const check = spawnSync('/usr/bin/python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'check', process.cwd()], { encoding: 'utf8' })
  assert.equal(check.status, 0, 'handoff check')
  return entry
}

export function stopProcess(entry, signal = 'SIGTERM') {
  spawnSync('/usr/bin/python3', ['/home/oleksandr/code/dev-auto/skills/dev-auto/scripts/check.py', 'leftovers', process.cwd()], { stdio: 'pipe' })
  const result = spawnSync('/usr/bin/python3', ['-c', `import os,signal,sys
try:
 fd=os.pidfd_open(int(sys.argv[1])); actual=open('/proc/'+sys.argv[1]+'/stat').read().rsplit(') ',1)[1].split()[19]
 if actual==sys.argv[2]:signal.pidfd_send_signal(fd,getattr(signal,sys.argv[3]))
 os.close(fd)
except ProcessLookupError:pass
`, String(entry.pid), entry.start_ticks, signal])
  assert.equal(result.status, 0, 'pidfd cleanup')
}

export function isolatedMain(out) {
  if (process.argv.includes('--inner')) return
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const runtime = mkdtempSync(`/run/user/${process.getuid()}/b97-`); chmodSync(runtime, 0o700)
  const home = join(out, 'home'); mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = join(out, 'dbus.conf')
  writeFileSync(config, `<busconfig><type>session</type><auth>EXTERNAL</auth><listen>unix:tmpdir=${runtime}</listen><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`)
  const result = spawnSync('dbus-run-session', ['--config-file', config, '--', process.execPath, resolve(process.argv[1]), ...process.argv.slice(2), '--inner'], {
    env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      HOME: home, XDG_DATA_HOME: join(home, 'share'), XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
      XDG_RUNTIME_DIR: runtime, BMN_DATA_HOME: join(out, 'data'), GTK_USE_PORTAL: '0', NO_AT_BRIDGE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000
  })
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(line => line.includes(runtime))
  assert.equal(mounts.length, 0, 'private bus left a mount')
  rmSync(runtime, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}

export async function privateKeyring() {
  const password = randomBytes(24).toString('hex'), control = join(process.env.XDG_RUNTIME_DIR, 'keyring')
  mkdirSync(control, { mode: 0o700 })
  const daemon = spawn('gnome-keyring-daemon', ['--foreground', '--components=secrets', '--control-directory', control, '--unlock'], { stdio: ['pipe', 'ignore', 'ignore'] })
  let entry
  try { entry = recordProcess(daemon.pid, '97 private synthetic keyring') }
  catch (error) {
    const exited = new Promise(ok => daemon.once('close', ok))
    const start_ticks = readFileSync(`/proc/${daemon.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
    stopProcess({ pid: daemon.pid, start_ticks }); await exited
    throw error
  }
  daemon.stdin.end(password)
  let owner
  const probe = (action, account) => {
    const answer = spawnSync('/usr/bin/python3', [resolve('scripts/test/browser-keyring-probe.py')], {
      input: JSON.stringify({ action, account, pid: daemon.pid, owner, ...(action === 'unlock' ? { password } : {}) }), encoding: 'utf8', timeout: 10_000 })
    assert.equal(answer.status, 0, 'private keyring identity/lock probe failed')
    const state = JSON.parse(answer.stdout); assert(state.ok, 'private keyring probe failed'); owner = state.owner
    return state
  }
  return { lock: account => probe('lock', account), unlock: account => probe('unlock', account), state: account => probe('state', account), stop: async () => {
    const exited = new Promise(ok => daemon.once('close', ok))
    stopProcess(entry); await exited
  } }
}

export async function syntheticSite() {
  const values = Array.from({ length: 6 }, () => randomBytes(24).toString('hex'))
  const [password, cookie, bearer, local, indexed, keyringProbe] = values
  const authenticator = randomBytes(20).toString('hex').split('').map(ch => 'ABCDEFGHIJKLMNOP'[parseInt(ch, 16)]).join('')
  const active = new Map(), tokens = new Map(), attempts = [], forbidden = []
  let crossOrigin
  const scriptedHands = new Set(), completed = new Map()
  const markup = (mode, signed, origin) => `<!doctype html><html><body>
    <script>
    async function db(){return await new Promise(ok=>{let r=indexedDB.open('auth',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>ok(r.result)})}
    async function seed(){let d=await db(),k=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),iv=crypto.getRandomValues(new Uint8Array(12)),ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,new TextEncoder().encode('${indexed}'));await new Promise(ok=>{let t=d.transaction('kv','readwrite');t.objectStore('kv').put(k,'key');t.objectStore('kv').put({iv,ct},'blob');t.oncomplete=ok});localStorage.setItem('token','${local}')}
    async function decryptToken(){let d=await db(),get=k=>new Promise(ok=>{let r=d.transaction('kv').objectStore('kv').get(k);r.onsuccess=()=>ok(r.result)}),k=await get('key'),b=await get('blob');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.iv},k,b.ct))}
    async function login(){let r=await fetch('/${mode}/login',{method:'POST',body:JSON.stringify({username:document.querySelector('[name=user]')?.value,password:document.querySelector('[name=password]')?.value,code:document.querySelector('[name=code]')?.value})});if(!r.ok)return;await seed();console.log('before-sign-in-history');
      ${mode === 'session' ? "sessionStorage.setItem('signed','yes');document.querySelector('main').innerHTML='<h1>Signed in</h1>'" : mode === 'fetch' || mode === 'email' || mode === 'public' ? "document.querySelector('main').innerHTML='<h1>Signed in</h1>'" : `location.href='${origin}/${mode}/app'`}}
    async function api(){await fetch('/${mode}/api',{headers:{Authorization:'Bearer ${bearer}'}})}
    </script><main>${signed ? '<h1>Signed in</h1>' : mode === 'public' ? '<h1>Public</h1>' : `<label>User name<input name="user" autocomplete="username"></label>${mode === 'email' ? '' : '<label>Password<input name="password" type="password"></label><label>Code<input name="code" autocomplete="one-time-code"></label>'}<button onclick="login()">Sign in</button>`}</main>
    ${mode === 'session' ? "<script>if(sessionStorage.getItem('signed'))document.querySelector('main').innerHTML='<h1>Signed in</h1>'</script>" : ''}
    ${mode === 'busy' && signed ? '<script>setInterval(()=>fetch("/busy/poll"),100)</script>' : ''}</body></html>`
  const handler = origin => async (req, res) => {
    const [mode, path = ''] = req.url.split('?')[0].split('/').slice(1)
    res.setHeader('Content-Type', 'text/html')
    if (mode === 'busy' && path === 'poll') { setTimeout(() => res.end('ok'), 300); return }
    if (mode === 'hostile') {
      res.end('<label>Password<input name="password" type="password" oninput="document.title=btoa(this.value);console.log(this.value)"></label>'); return
    }
    const present = /(?:^|; )session=([^;]+)/u.exec(req.headers.cookie || '')?.[1]
    const signed = mode !== 'session' && active.get(mode)?.has(present)
    if (path === 'login' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk
      let data; try { data = JSON.parse(body) } catch { data = {} }
      const passed = ['email', 'public'].includes(mode) || data.username === 'synthetic' && data.password === password && data.code === authenticatorCode(authenticator)
      attempts.push({ mode, passed })
      if (!passed) { res.writeHead(403); res.end('no'); return }
      const value = `${cookie}-${randomBytes(8).toString('hex')}`
      if (!active.has(mode)) active.set(mode, new Set())
      active.get(mode).add(value); tokens.set(mode, value)
      res.setHeader('Set-Cookie', `session=${value}; HttpOnly; Path=/${mode}/`); res.end('ok'); return
    }
    if (path === 'api') {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', `session=${present || cookie}; HttpOnly; Path=/${mode}/`)
      res.end(JSON.stringify({ ok: Boolean(signed) })); return
    }
    if (path === 'renew') {
      if (!signed) { active.get(mode)?.clear(); res.writeHead(401); res.end('expired'); return }
      active.get(mode).delete(present)
      const value = `${cookie}-${randomBytes(8).toString('hex')}`; active.get(mode).add(value); tokens.set(mode, value)
      res.setHeader('Set-Cookie', `session=${value}; HttpOnly; Path=/${mode}/`); res.end('refreshed'); return
    }
    if (mode === 'cross' && !signed && origin !== crossOrigin) { res.writeHead(302, { Location: `${crossOrigin}/cross/login` }); res.end(); return }
    if (path === '' && !['fetch', 'email', 'public', 'session', 'noncanonical'].includes(mode)) { res.writeHead(302, { Location: `/${mode}/${signed ? 'app' : 'login'}` }); res.end(); return }
    if (path === 'app' && !signed) { res.writeHead(302, { Location: `/${mode}/login` }); res.end(); return }
    res.setHeader('Set-Cookie', 'anonymous=before-sign-in; Path=/')
    if (signed && path === 'app') completed.set(mode, (completed.get(mode) || 0) + 1)
    let html = markup(mode, Boolean(signed), primaryOrigin)
    if (!signed && scriptedHands.delete(mode)) html = html.replace('</body>', `<script>setTimeout(()=>{document.querySelector('[name=user]').value='synthetic';document.querySelector('[name=password]').value='${password}';document.querySelector('[name=code]').value='${authenticatorCode(authenticator)}';document.querySelector('button').click()},700)</script></body>`)
    res.end(html)
  }
  let primaryOrigin
  const a = createServer((req, res) => { void handler(primaryOrigin)(req, res).catch(() => { forbidden.push('server error'); res.destroy() }) })
  const b = createServer((req, res) => { void handler(crossOrigin)(req, res).catch(() => { forbidden.push('server error'); res.destroy() }) })
  await new Promise(ok => a.listen(0, '127.0.0.1', ok)); primaryOrigin = `http://127.0.0.1:${a.address().port}`
  await new Promise(ok => b.listen(0, '127.0.0.1', ok)); crossOrigin = `http://127.0.0.1:${b.address().port}`
  return { origin: primaryOrigin, hostile: crossOrigin + '/hostile/', values: [...values, authenticator], password, authenticator, local, indexed, keyringProbe, attempts,
    url: mode => `${primaryOrigin}/${mode}/`, expire: mode => active.get(mode)?.clear(),
    scriptNextSignIn: mode => scriptedHands.add(mode), completed: mode => completed.get(mode) || 0,
    close: async () => { await Promise.all([new Promise(ok => a.close(ok)), new Promise(ok => b.close(ok))]); assert.equal(forbidden.length, 0, 'fixture failures') } }
}

export function assertNoValues(folder, values) {
  let files = 0
  function scan(path) {
    if (!existsSync(path)) return
    for (const name of readdirSync(path)) {
      const file = join(path, name), stat = lstatSync(file)
      if (stat.isDirectory()) scan(file)
      else if (stat.isFile()) {
        files++
        const data = readFileSync(file)
        assert(!values.some(value => value && data.includes(Buffer.from(value))), 'synthetic private value persisted')
      }
    }
  }
  scan(folder)
  return files
}

export function result(out, phase, checks, limits = []) { atomicJson(join(out, 'result.json'), { phase, result: 'PASS', checks, limits }); console.log(JSON.stringify({ phase, result: 'PASS', checks, limits })) }
