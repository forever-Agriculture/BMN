// Measurement only: test same-user broker escape in a fresh disposable WSL guest.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function measureGuestBrokerEscape({ distribution, uid, guest }) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(distribution, /^BMN-Epic53-Systemd-[0-9a-f-]+$/)
  assert.match(String(uid), /^\d+$/)
  const prefix = `bmn-broker-${randomUUID()}`
  const result = guest(['/usr/bin/python3', '-c', `import os,pathlib,subprocess,tempfile,json,time,select,shutil
uid=${uid};prefix=${JSON.stringify(prefix)}
root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-broker-',dir='/home/bmnfixture'));os.chown(root,uid,uid)
parent=prefix+'-parent.service';sibling=prefix+'-sibling.service'
env=['XDG_RUNTIME_DIR=/run/user/'+str(uid),'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/'+str(uid)+'/bus']
def user(args,check=True): return subprocess.run(['runuser','-u','bmnfixture','--','env']+env+args,check=check,capture_output=True,text=True,timeout=15)
def identity(pid): return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rpartition(') ')[2].split()[19]
script=root/'broker.py'
script.write_text('''import os,pathlib,json,sys,subprocess,time
root=pathlib.Path(sys.argv[1]);role=sys.argv[2]
ticks=pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()[19]
(root/(role+'.json')).write_text(json.dumps({'pid':os.getpid(),'ticks':ticks}))
if role=='parent':
 subprocess.run(['systemd-run','--user','--unit='+sys.argv[3],'--property=Delegate=no','--property=KillMode=control-group','--property=TimeoutStopSec=5',sys.executable,__file__,str(root),'sibling'],check=True)
while True: time.sleep(1)
''')
held=[]
try:
 user(['systemd-run','--user','--unit='+parent,'--property=Delegate=no','--property=KillMode=control-group','--property=TimeoutStopSec=5','/usr/bin/python3',str(script),str(root),'parent',sibling])
 deadline=time.monotonic()+20;entries=[]
 while len(entries)!=2 and time.monotonic()<deadline:
  try: entries=[json.loads((root/(role+'.json')).read_text()) for role in ['parent','sibling']]
  except (FileNotFoundError,json.JSONDecodeError): time.sleep(.05)
 assert len(entries)==2,'Both synthetic service identities are required'
 for entry in entries:
  held.append(os.pidfd_open(entry['pid']));assert identity(entry['pid'])==entry['ticks']
 groups=[pathlib.Path('/proc/'+str(entry['pid'])+'/cgroup').read_text().strip() for entry in entries]
 assert parent in groups[0] and sibling in groups[1] and groups[0]!=groups[1]
 invocations=[user(['systemctl','--user','show',unit,'--property=InvocationID','--value']).stdout.strip() for unit in [parent,sibling]]
 assert all(len(value)==32 for value in invocations)
 user(['systemctl','--user','stop',parent])
 assert select.select([held[0]],[],[],10)[0],'Retained parent must exit after scoped Stop'
 escaped=not bool(select.select([held[1]],[],[],.5)[0])
 user(['systemctl','--user','stop',sibling])
 assert select.select([held[1]],[],[],10)[0],'Scoped sibling cleanup must signal retained handle'
 namespace=user(['/usr/bin/unshare','--user','--map-root-user','--mount','--pid','--fork','--mount-proc','/usr/bin/python3','-c','import os,json;print(json.dumps({"uid":os.getuid(),"pidNamespace":os.readlink("/proc/self/ns/pid")}))'],check=False)
 # A separate PID/user/network namespace is not a filesystem-socket sandbox.
 # Measure a synthetic same-user broker in the home directory, outside /run.
 broker=prefix+'-socket.service';socketpath=root/'outside.sock';ready=root/'socket-ready.json';childready=root/'socket-child.json'
 server=root/'socket-broker.py'
 server.write_text('''import os,pathlib,socket,sys,json,subprocess,time
root=pathlib.Path(sys.argv[1]);sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.bind(str(root/'outside.sock'));os.chmod(root/'outside.sock',0o600);sock.listen(1)
def record(path):
 path.write_text(json.dumps({'pid':os.getpid(),'ticks':pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()[19],'pidNamespace':os.readlink('/proc/self/ns/pid')}))
record(root/'socket-ready.json')
connection,_=sock.accept()
with connection:
 if connection.recv(16)==b'launch':
  code="import os,pathlib,json,time;root=pathlib.Path("+repr(str(root))+ ");(root/'socket-child.json').write_text(json.dumps({'pid':os.getpid(),'ticks':pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()[19],'pidNamespace':os.readlink('/proc/self/ns/pid')}));time.sleep(60)"
  subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  connection.sendall(b'started')
while True: time.sleep(1)
''')
 brokerHeld=[];namespaceBroker={'result':'INCONCLUSIVE'}
 try:
  user(['systemd-run','--user','--unit='+broker,'--property=Delegate=no','--property=KillMode=control-group','--property=TimeoutStopSec=5','/usr/bin/python3',str(server),str(root)])
  deadline=time.monotonic()+15
  while not ready.exists() and time.monotonic()<deadline: time.sleep(.05)
  serveridentity=json.loads(ready.read_text());brokerHeld.append(os.pidfd_open(serveridentity['pid']));assert identity(serveridentity['pid'])==serveridentity['ticks']
  client="import os,socket,json;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect("+repr(str(socketpath))+");s.sendall(b'launch');assert s.recv(16)==b'started';print(json.dumps({'uid':os.getuid(),'pidNamespace':os.readlink('/proc/self/ns/pid')}))"
  isolated=user(['/usr/bin/unshare','--user','--map-root-user','--mount','--pid','--fork','--mount-proc','--ipc','--net','/usr/bin/python3','-c',client],check=False)
  namespaceBroker={'exit':isolated.returncode,'stdout':isolated.stdout.strip(),'stderr':isolated.stderr.strip()[:1000],'result':'INCONCLUSIVE'}
  if isolated.returncode==0:
   deadline=time.monotonic()+15
   while not childready.exists() and time.monotonic()<deadline: time.sleep(.05)
   childidentity=json.loads(childready.read_text());brokerHeld.append(os.pidfd_open(childidentity['pid']));assert identity(childidentity['pid'])==childidentity['ticks']
   caller=json.loads(isolated.stdout);assert caller['pidNamespace']!=childidentity['pidNamespace']==serveridentity['pidNamespace']
   survived=not bool(select.select([brokerHeld[1]],[],[],.5)[0])
   namespaceBroker.update({'caller':caller,'child':childidentity,'outsideUnit':broker,'retainedPidfds':len(brokerHeld),'survivedNamespaceExit':survived,'result':'REFUSED' if survived else 'INCONCLUSIVE'})
 finally:
  user(['systemctl','--user','stop',broker],check=False)
  assert not brokerHeld or len(select.select(brokerHeld,[],[],10)[0])==len(brokerHeld),'Synthetic socket broker and child must exit during scoped cleanup'
  namespaceBroker['cleanupConfirmed']=True
  for fd in brokerHeld: os.close(fd)

 print(json.dumps({'uid':uid,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'pidNamespace':os.readlink('/proc/self/ns/pid'),'retainedPidfds':len(held),'parentUnit':parent,'siblingUnit':sibling,'invocations':invocations,'cgroups':groups,'parentExited':True,'siblingEscaped':escaped,'siblingCleanupConfirmed':True,'ordinaryUserNamespace':{'exit':namespace.returncode,'stdout':namespace.stdout.strip(),'stderr':namespace.stderr.strip()[:1000]},'namespaceSocketBroker':namespaceBroker,'strictGuestOwnership':'REFUSED' if escaped else 'INCONCLUSIVE'}))
finally:
 for unit in [parent,sibling]: user(['systemctl','--user','stop',unit],check=False)
 for fd in held: os.close(fd)
 shutil.rmtree(root)
`], { timeout: 90000 })
  assert.equal(result.exit, 0, 'Broker containment measurement and cleanup must complete')
  return JSON.parse(result.stdout)
}
