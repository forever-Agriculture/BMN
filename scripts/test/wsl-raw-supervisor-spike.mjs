// Measurement only. Caller owns a fresh CI distribution and ordinary fixture user.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const waitFor = async probe => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const result = probe()
    if (result) return result
    await delay(50)
  }
  throw new Error('Raw WSL fixture readiness timeout')
}

export async function measureRawSupervisor({ executable, distribution, uid, guest }) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(distribution, /^BMN-Epic53-Systemd-[0-9a-f-]+$/)
  assert.match(String(uid), /^\d+$/)
  const created = guest(['/usr/bin/python3', '-c', `import pathlib, tempfile, os, json
root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-raw-ownership-',dir='/home/bmnfixture'));os.chown(root,${uid},${uid})
(root/'tree.py').write_text('''import os,sys,time,subprocess,pathlib,json
root=pathlib.Path(sys.argv[1]);role=sys.argv[2] if len(sys.argv)>2 else 'root'
text=pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()
(root/(role+'.json')).write_text(json.dumps({'pid':os.getpid(),'ticks':text[19]}))
if role!='grandchild': subprocess.Popen([sys.executable,__file__,str(root),'child' if role=='root' else 'grandchild'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
if role=='root':
 while sys.stdin.buffer.read(1): pass
else:
 while True: time.sleep(1)
''')
print(json.dumps({'root':str(root)}))`])
  assert.equal(created.exit, 0)
  const { root } = JSON.parse(created.stdout)
  assert.match(root, /^\/home\/bmnfixture\/bmn-raw-ownership-[a-zA-Z0-9_-]+$/)
  const children = []
  const start = args => {
    const child = spawn(executable, ['--distribution', distribution, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.push(child)
    let output = '', stderr = '', failure
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 16000) { failure = new Error('Fixture output bound'); child.kill() } })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16000) })
    child.on('error', error => { failure = error })
    child.stdin.on('error', error => { failure = error })
    const closed = new Promise(resolve => child.on('close', code => resolve(code)))
    return { child, output: () => { if (failure) throw failure; return output }, stderr: () => stderr, closed }
  }
  const results = []
  try {
    for (const action of ['stdin-eof', 'native-host-crash']) {
      const directory = root + '/' + action
      const unit = `bmn-raw-${randomUUID()}.service`
      const prepared = guest(['/usr/bin/python3', '-c', `import os
os.mkdir(${JSON.stringify(directory)});os.chown(${JSON.stringify(directory)},${uid},${uid})`])
      assert.equal(prepared.exit, 0)
      const subject = start(['--user', 'bmnfixture', '--exec', '/usr/bin/env', `XDG_RUNTIME_DIR=/run/user/${uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, '/usr/bin/systemd-run', '--user', '--pipe', '--wait',
        `--unit=${unit}`, '--property=Delegate=no', '--property=KillMode=control-group', '--property=TimeoutStopSec=5',
        '/usr/bin/python3', root + '/tree.py', directory])
      const script = `import pathlib,json,os,time,select,sys
root=pathlib.Path(${JSON.stringify(directory)});entries=[];held=[];deadline=time.monotonic()+20
try:
 while len(entries)!=3 and time.monotonic()<deadline:
  try: entries=[json.loads((root/(role+'.json')).read_text()) for role in ['root','child','grandchild']]
  except (FileNotFoundError,json.JSONDecodeError): time.sleep(.05)
 assert len(entries)==3
 for entry in entries:
  fd=os.pidfd_open(entry['pid']);held.append(fd)
  assert pathlib.Path('/proc/'+str(entry['pid'])+'/stat').read_text().rpartition(') ')[2].split()[19]==entry['ticks']
 print('READY',flush=True);assert sys.stdin.readline().strip()=='go'
 pending=list(held);deadline=time.monotonic()+15
 while pending and time.monotonic()<deadline:
  ready,_,_=select.select(pending,[],[],.5);pending=[fd for fd in pending if fd not in ready]
 print(json.dumps({'retainedPidfds':len(held),'allExited':not pending}),flush=True)
finally:
 for fd in held: os.close(fd)
`
      const observer = start(['--user', 'root', '--exec', '/usr/bin/python3', '-c', script])
      try {
        await waitFor(() => observer.output().includes('READY'))
        assert.equal(subject.child.exitCode, null, subject.stderr())
        if (action === 'stdin-eof') subject.child.stdin.end()
        else assert.equal(subject.child.kill(), true, 'Terminate the handle of the owned native WSL child')
        observer.child.stdin.end('go\n')
        await waitFor(() => observer.output().split(/\r?\n/).find(line => line.startsWith('{')))
        const result = JSON.parse(observer.output().split(/\r?\n/).find(line => line.startsWith('{')))
        await waitFor(() => observer.child.exitCode !== null || observer.child.signalCode !== null)
        assert.equal(await observer.closed, 0, observer.stderr())
        assert.equal(result.retainedPidfds, 3)
        results.push({ action, ...result })
      } finally {
        guest(['/bin/sh', '-c', `runuser -u bmnfixture -- env XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user stop "$1"`, 'fixture', unit])
        for (const item of [subject, observer]) if (item.child.exitCode === null) item.child.kill()
      }
    }
    return { results, passed: results.every(result => result.allExited) }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    guest(['/usr/bin/python3', '-c', `import shutil;shutil.rmtree(${JSON.stringify(root)})`])
  }
}
