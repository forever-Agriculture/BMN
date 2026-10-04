// CI-only measured guest ownership. Never imports/configures an owner distribution.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureRawSupervisor } from './wsl-raw-supervisor-spike.mjs'
import { measureGuestBrokerEscape } from './wsl-broker-escape-spike.mjs'
import { measureRestrictedGuestProfile } from './wsl-restricted-profile-spike.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const source = 'https://releases.ubuntu.com/noble/ubuntu-24.04.4-wsl-amd64.wsl'
const expected = '9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5'
const bytesExpected = 391541571
const executable = join(process.env.SystemRoot, 'System32', 'wsl.exe')
const root = mkdtempSync(join(tmpdir(), 'bmn-wsl-systemd-spike-'))
const distribution = `BMN-Epic53-Systemd-${randomUUID()}`
const receipt = { distribution, source, sha256: expected, acceptance: 'UNVERIFIED', commands: [], measuredGuestOwnership: false,
  guiInteropOwnership: 'UNVERIFIED', rawSupervisorDeath: 'UNVERIFIED' }
const decode = bytes => bytes?.toString(bytes.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').trim().slice(0, 16000) ?? ''
const run = (args, { timeout = 30000, input } = {}) => {
  const started = Date.now()
  try {
    const stdout = execFileSync(executable, args, { input, windowsHide: true, timeout,
      maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    const result = { args, exit: 0, elapsedMs: Date.now() - started, stdout: decode(stdout) }
    receipt.commands.push(result); return result
  } catch (error) {
    const result = { args, exit: error.status ?? null, code: error.code ?? null, elapsedMs: Date.now() - started,
      stdout: decode(error.stdout), stderr: decode(error.stderr) }
    receipt.commands.push(result); return result
  }
}
const guest = (args, options) => run(['--distribution', distribution, '--user', 'root', '--exec', ...args], options)
let importAttempted = false
try {
  const listed = run(['--list', '--quiet'])
  assert.ok(!listed.stdout.split(/\r?\n/u).includes(distribution))
  const response = await fetch(source, { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok && response.body, `Root filesystem HTTP ${response.status}`)
  const partial = join(root, 'rootfs.part')
  const file = await open(partial, 'wx', 0o600)
  const digest = createHash('sha256'); let received = 0
  try {
    for await (const bytes of response.body) {
      received += bytes.length; assert.ok(received <= bytesExpected)
      digest.update(bytes)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
        assert.ok(bytesWritten > 0); offset += bytesWritten
      }
    }
    assert.equal(received, bytesExpected); assert.equal(digest.digest('hex'), expected)
    await file.sync()
  } finally { await file.close() }
  const archive = join(root, 'rootfs.wsl'); await rename(partial, archive)
  importAttempted = true
  const imported = run(['--import', distribution, join(root, 'distribution'), archive, '--version', '2'], { timeout: 120000 })
  assert.equal(imported.exit, 0, 'Pinned Ubuntu WSL2 import must succeed')
  // Change only this freshly imported distro; never .wslconfig or an existing registration.
  const configured = guest(['/usr/bin/python3', '-c', `import configparser, pathlib, subprocess
p=pathlib.Path('/etc/wsl.conf'); c=configparser.ConfigParser(); c.read(p)
if not c.has_section('boot'): c.add_section('boot')
c.set('boot','systemd','true')
with p.open('w') as f: c.write(f)
subprocess.run(['useradd','-m','-s','/bin/bash','bmnfixture'],check=True)
print('configured-disposable-guest')`])
  assert.equal(configured.exit, 0, 'Guest needs Python and a fresh ordinary fixture account')
  assert.equal(run(['--terminate', distribution]).exit, 0)
  const boot = guest(['/bin/sh', '-c', 'cat /proc/1/comm; uname -r; stat -fc %T /sys/fs/cgroup; id -u bmnfixture; command -v systemd-run; command -v python3'])
  assert.equal(boot.exit, 0); assert.match(boot.stdout, /^systemd\n/u); assert.match(boot.stdout, /cgroup2fs/u)
  const prepared = guest(['/bin/sh', '-c', 'loginctl enable-linger bmnfixture; uid=$(id -u bmnfixture); systemctl start user@"$uid".service; printf "%s" "$uid"'])
  assert.equal(prepared.exit, 0); const uid = prepared.stdout.trim(); assert.match(uid, /^\d+$/u)
  const unitPrefix = `bmn-probe-${randomUUID()}`
  const probe = `import os, pathlib, select, signal, subprocess, time, json, tempfile
uid=${uid}; prefix=${JSON.stringify(unitPrefix)}
env=dict(os.environ, XDG_RUNTIME_DIR='/run/user/'+str(uid), DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/'+str(uid)+'/bus')
def user(args): return subprocess.run(['runuser','-u','bmnfixture','--','env','XDG_RUNTIME_DIR='+env['XDG_RUNTIME_DIR'],'DBUS_SESSION_BUS_ADDRESS='+env['DBUS_SESSION_BUS_ADDRESS']]+args,check=True,capture_output=True,text=True).stdout
root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-ownership-',dir='/home/bmnfixture')); os.chown(root,uid,uid)
fixture=root/'tree.py'
fixture.write_text('''import os, sys, time, subprocess, pathlib, json
root=pathlib.Path(sys.argv[1]); role=sys.argv[2] if len(sys.argv)>2 else 'root'
text=pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()
(root/(role+'.json')).write_text(json.dumps({'pid':os.getpid(),'ticks':text[19]}))
if role!='grandchild': subprocess.Popen([sys.executable,__file__,str(root),'child' if role=='root' else 'grandchild'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
while True: time.sleep(1)
''')
def identity(pid): return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rpartition(') ')[2].split()[19]
results=[]
try:
 for action in ['stop','main-crash']:
  directory=root/action; directory.mkdir(); os.chown(directory,uid,uid); unit=prefix+'-'+action+'.service'
  user(['systemd-run','--user','--unit='+unit,'--property=Delegate=no','--property=KillMode=control-group','--property=TimeoutStopSec=5','/usr/bin/python3',str(fixture),str(directory)])
  held=[]
  try:
   deadline=time.monotonic()+20; entries=[]
   while len(entries)!=3 and time.monotonic()<deadline:
    try: entries=[json.loads((directory/(role+'.json')).read_text()) for role in ['root','child','grandchild']]
    except (FileNotFoundError,json.JSONDecodeError): time.sleep(.05)
   assert len(entries)==3
   for entry in entries:
    fd=os.pidfd_open(entry['pid']); assert identity(entry['pid'])==entry['ticks']; held.append(fd)
   invocation=user(['systemctl','--user','show',unit,'--property=InvocationID','--value']).strip(); assert len(invocation)==32
   if action=='stop': user(['systemctl','--user','stop',unit])
   else: user(['systemctl','--user','kill','--kill-whom=main','--signal=SIGKILL',unit])
   pending=list(held); deadline=time.monotonic()+15
   while pending and time.monotonic()<deadline:
    ready,_,_=select.select(pending,[],[],.5); pending=[fd for fd in pending if fd not in ready]
   assert not pending, 'A retained guest process survived the unit action'
   results.append({'action':action,'retainedPidfds':len(held),'invocationId':invocation,'passed':True})
  finally:
   subprocess.run(['runuser','-u','bmnfixture','--','env','XDG_RUNTIME_DIR='+env['XDG_RUNTIME_DIR'],'DBUS_SESSION_BUS_ADDRESS='+env['DBUS_SESSION_BUS_ADDRESS'],'systemctl','--user','stop',unit],capture_output=True)
   for fd in held: os.close(fd)
 print(json.dumps({'uid':uid,'pidNamespace':os.readlink('/proc/self/ns/pid'),'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'results':results}))
finally:
 import shutil; shutil.rmtree(root)
`
  const owned = guest(['/usr/bin/python3', '-c', probe], { timeout: 90000 })
  assert.equal(owned.exit, 0, 'Detached guest trees must exit after scoped Stop and root crash')
  receipt.guest = JSON.parse(owned.stdout); receipt.measuredGuestOwnership = true
  receipt.rawSupervisorDeath = await measureRawSupervisor({ executable, distribution, uid, guest })
  receipt.guestBrokerIsolation = measureGuestBrokerEscape({ distribution, uid, guest })
  receipt.restrictedProfile = measureRestrictedGuestProfile({ distribution, uid, guest })
  assert.notEqual(receipt.restrictedProfile.result, 'FAIL', 'Restricted guest measurement failed')
  receipt.reason = 'Direct detached guest-tree and raw host EOF/death cleanup pass. Same-user service broker escape is measured separately; the unisolated strict design is refused when it escapes. Enforced broker/interop isolation remains required before product implementation.'
} catch (error) { receipt.reason = String(error.message).slice(0, 1000) }
finally {
  if (importAttempted) {
    const removed = run(['--unregister', distribution], { timeout: 30000 })
    receipt.registrationRemoved = removed.exit === 0 || !run(['--list', '--quiet']).stdout.split(/\r?\n/u).includes(distribution)
  }
  try { rmSync(root, { recursive: true, force: true }) } catch { receipt.fixtureFilesRemoved = false }
  await rm(join(root, 'rootfs.part'), { force: true }).catch(() => {})
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/windows-wsl-systemd-spike.json', JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
assert.notEqual(receipt.registrationRemoved, false, 'Disposable registration must be removed')
assert.notEqual(receipt.restrictedProfile?.result, 'FAIL', 'Restricted-profile measurement failed; inspect retained receipt')
