import errno, json, os, pathlib, select, shutil, signal, socket, struct, subprocess, sys, tempfile, time, uuid
# Synthetic only. No owner home, daemon/config, interop or network traffic.
root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-wsl-restricted-'))
broker=None; childfds=[]; receipts=[]
def identity(pid):
 return {'pid':pid,'ticks':pathlib.Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()[19]}
def waitfile(path):
 deadline=time.monotonic()+5
 while not path.exists() and time.monotonic()<deadline:time.sleep(.02)
 return json.loads(path.read_text())
try:
 brokerfile=root/'broker.py'
 brokerfile.write_text('''import os,pathlib,socket,subprocess,sys,json,time
root=pathlib.Path(sys.argv[1]);s=socket.socket(socket.AF_UNIX);s.bind(str(root/'broker.sock'));s.listen(2)
(root/'ready.json').write_text(json.dumps({'pid':os.getpid()}))
for i in range(2):
 c,_=s.accept()
 with c:
  assert c.recv(32)==b'launch'
  child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
  c.sendall(json.dumps({'pid':child.pid}).encode())
time.sleep(30)
''')
 broker=subprocess.Popen([sys.executable,str(brokerfile),str(root)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 brokerfd=os.pidfd_open(broker.pid); waitfile(root/'ready.json')
 # x86_64 seccomp: verify architecture; socket allows only AF_INET/AF_INET6,
 # within a new network namespace. socketpair remains available for private IPC.
 assert os.uname().machine=='x86_64'
 ALLOW=0x7fff0000;DENY=0x00050000|errno.EPERM;KILL=0x80000000
 ops=[(0x20,0,0,4),(0x15,1,0,0xc000003e),(0x06,0,0,KILL),
 (0x20,0,0,0),(0x15,0,4,41),(0x20,0,0,16),
 (0x15,2,0,socket.AF_INET),(0x15,1,0,socket.AF_INET6),(0x06,0,0,DENY),(0x06,0,0,ALLOW)]
 filterfd=os.memfd_create('bmn-synthetic-seccomp',0)
 os.write(filterfd,b''.join(struct.pack('HBBI',*op) for op in ops));os.lseek(filterfd,0,0)
 client='''import errno,json,os,socket,sys
try:
 s=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect('/fixture/broker.sock');s.sendall(b'launch');print(json.dumps({'broker':json.loads(s.recv(4096)), 'namespace':os.readlink('/proc/self/ns/pid')}))
except OSError as e:print(json.dumps({'deniedErrno':e.errno,'namespace':os.readlink('/proc/self/ns/pid')}))
'''
 base=['/usr/bin/bwrap','--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--die-with-parent','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run','--tmpfs','/home','--ro-bind',str(root),'/fixture']
 for restricted in [False,True]:
  os.lseek(filterfd,0,0)
  run=subprocess.run(base+(['--seccomp',str(filterfd)] if restricted else [])+['/usr/bin/python3','-c',client],pass_fds=(filterfd,),capture_output=True,text=True,timeout=8)
  assert run.returncode==0,run.stderr
  row=json.loads(run.stdout);row['restricted']=restricted
  if not restricted:
   held=os.pidfd_open(row['broker']['pid']);childfds.append(held)
   row['retainedIdentity']=identity(row['broker']['pid']);row['survivedCallerExit']=not bool(select.select([held],[],[],.2)[0]);assert row['survivedCallerExit']
  else:assert row['deniedErrno']==errno.EPERM
  receipts.append(row)
 # Private socketpair IPC remains usable, but no external socket descriptor is passed.
 os.lseek(filterfd,0,0)
 pair=subprocess.run(base+['--seccomp',str(filterfd),'/usr/bin/python3','-c',"import socket;s,t=socket.socketpair();s.send(b'private');assert t.recv(7)==b'private';print('PASS')"],pass_fds=(filterfd,),capture_output=True,text=True,timeout=8)
 assert pair.returncode==0,pair.stderr
 # Each bwrap invocation consumes the shared filter file offset.
 assert os.lseek(filterfd,0,os.SEEK_CUR)==len(ops)*8
 assert len(os.pread(filterfd,len(ops)*8,0))==len(ops)*8
 os.lseek(filterfd,0,0)
 # Retain host pidfds before lifecycle actions, with start ticks and namespace
 # readback. No reusable PID is used for termination or later attribution.
 lifecycle=[]
 treecode='''import os,pathlib,json,subprocess,sys,time
nonce,role=sys.argv[1:]
if role!='grandchild':subprocess.Popen([sys.executable,'-c',__import__('os').environ['BMN_SYNTHETIC_TREE_CODE'],nonce,'child' if role=='root' else 'grandchild'],stdin=subprocess.DEVNULL,start_new_session=True)
row={'role':role,'pid':os.getpid(),'ticks':pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()[19],'namespace':os.readlink('/proc/self/ns/pid')}
os.write(1,(json.dumps(row)+'\\n').encode())
if role=='root':sys.stdin.readline()
else:time.sleep(30)
'''
 for mode in ['natural','stop','supervisor-crash']:
  os.lseek(filterfd,0,0);nonce='bmn-synthetic-'+str(uuid.uuid4());held=[];tree=None
  try:
   tree=subprocess.Popen(base+['--seccomp',str(filterfd),'/usr/bin/python3','-c',treecode,nonce,'root'],pass_fds=(filterfd,),env={'PATH':'/usr/bin:/bin','BMN_SYNTHETIC_TREE_CODE':treecode},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   buffer=b'';deadline=time.monotonic()+8
   while buffer.count(b'\n')<3 and time.monotonic()<deadline:
    if select.select([tree.stdout],[],[],.1)[0]:
     data=os.read(tree.stdout.fileno(),65536)
     if not data:break
     buffer+=data
   rows=[json.loads(line) for line in buffer.splitlines()]
   assert len(rows)==3,(mode,buffer)
   for row in rows:
    matched=[]
    for path in pathlib.Path('/proc').iterdir():
     if not path.name.isdigit():continue
     try:
      argv=(path/'cmdline').read_bytes().split(b'\0')
      if argv[-3:-1]!=[nonce.encode(),row['role'].encode()]:continue
      if os.readlink(path/'ns/pid')!=row['namespace']:continue
      status=(path/'status').read_text().splitlines()
      inner=int(next(line for line in status if line.startswith('NSpid:')).split()[-1])
      if inner!=row['pid']:continue
      pid=int(path.name);before=identity(pid);fd=os.pidfd_open(pid)
      if before['ticks']!=row['ticks'] or identity(pid)!=before:os.close(fd);continue
      matched.append(fd)
     except (FileNotFoundError,PermissionError,ProcessLookupError):continue
    if len(matched)!=1:
     for fd in matched:os.close(fd)
     raise AssertionError((mode,row,len(matched)))
    held.extend(matched)
   if mode=='natural':tree.stdin.write(b'exit\n');tree.stdin.flush()
   elif mode=='stop':tree.terminate()
   else:tree.kill()
   tree.wait(timeout=8)
   # select returns after the first ready pidfd, not after all deaths.
   pending=list(held);deadline=time.monotonic()+8
   while pending and time.monotonic()<deadline:
    ready=select.select(pending,[],[],max(0,deadline-time.monotonic()))[0]
    pending=[fd for fd in pending if fd not in ready]
   assert not pending,('A retained descendant survived the deadline',mode,len(pending))
   lifecycle.append({'action':mode,'retainedPidfds':3,'allExited':True})
  finally:
   if tree is not None and tree.poll() is None:tree.kill();tree.wait(timeout=8)
   for fd in held:
    if not select.select([fd],[],[],0)[0]:signal.pidfd_send_signal(fd,signal.SIGKILL)
    assert select.select([fd],[],[],5)[0];os.close(fd)
 print(json.dumps({'platform':os.environ.get('BMN_SYNTHETIC_PLATFORM','linux-local'),'bwrap':subprocess.check_output(['/usr/bin/bwrap','--version'],text=True).strip(),'socketBroker':receipts,'privateSocketpair':'PASS','lifecycle':lifecycle,'nativeWSL':os.environ.get('BMN_SYNTHETIC_PLATFORM','UNVERIFIED'),'profileComplete':False,'remaining':['provider egress mediation','persistent workspace sharing/export','privileged device/fd and namespace escape audit','native WSL interop/GUI/files/ports parity']},indent=2))
finally:
 for fd in childfds:
  signal.pidfd_send_signal(fd,signal.SIGKILL);assert select.select([fd],[],[],5)[0];os.close(fd)
 if broker is not None:
  broker.kill();broker.wait(timeout=5);os.close(brokerfd)
 if 'filterfd' in locals():os.close(filterfd)
 shutil.rmtree(root)
