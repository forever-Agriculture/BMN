"""Synthetic real-bwrap lifetime measurement; production helper stays unchanged.

Packet globals: ROOT_HELPER_SOURCE, ROOT_PROFILE_SOURCE, NESTED_CAPABILITY_SOURCE,
TERMINFO_SOURCE. Run only as root in a freshly imported disposable CI guest.
"""
import ast
import ctypes
import hashlib
import json
import os
import pathlib
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import types


def extract_function(source, name, namespace):
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name == name]
    assert len(nodes) == 1, name
    exec(compile(ast.Module(body=nodes, type_ignores=[]), name, 'exec'), namespace)


extract_function(NESTED_CAPABILITY_SOURCE, 'candidate_source', globals())
extract_function(ROOT_PROFILE_SOURCE, 'retain', globals())
helper = types.ModuleType('bmn_nested_lifecycle_candidate')
candidate = candidate_source(ROOT_HELPER_SOURCE, True, True)
exec(compile(candidate, 'exact-synthetic-helper.py', 'exec'), helper.__dict__)
MODES = ['natural', 'stop', 'supervisor-crash', 'stdin-eof',
         'nonreading-stdin-eof', 'nonreading-tty-eof']
FRAME = b'\x1bP9;1;0q"1;1;1;6#1;2;100;0;0#1~\x1b\\'


def row_at(pid, role):
    path = pathlib.Path('/proc') / str(pid)
    before = (path / 'stat').read_text().rpartition(') ')[2].split()
    lines = (path / 'status').read_text().splitlines()
    inner = int(next(line for line in lines if line.startswith('NSpid:')).split()[-1])
    return {'role': role, 'pid': inner, 'ticks': before[19],
            'namespace': os.readlink(path / 'ns/pid')}


def host_pid(fd):
    return int(next(line for line in pathlib.Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines()
                    if line.startswith('Pid:')).split()[1])


def scan_tree(controller):
    parents = {}
    identities = {}
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            before = (path / 'stat').read_text().rpartition(') ')[2].split()
            row = row_at(int(path.name), 'supervisor')
            after = (path / 'stat').read_text().rpartition(') ')[2].split()
            # Retain this snapshot's identity, never refresh a numerical PID
            # after the ancestry scan and accidentally adopt its replacement.
            if before[19] != row['ticks'] or before[19] != after[19] or before[1] != after[1]:
                continue
            parents[int(path.name)] = int(before[1])
            identities[int(path.name)] = row
        except (FileNotFoundError, ProcessLookupError):
            continue
    tree = {controller}
    while True:
        extra = {pid for pid, parent in parents.items() if parent in tree} - tree
        if not extra:
            return {pid: identities[pid] for pid in tree}
        tree |= extra


def uid_tasks(uid):
    found = []
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            for task in (path / 'task').iterdir():
                try:
                    lines = (task / 'status').read_text().splitlines()
                    ids = next(line for line in lines if line.startswith('Uid:')).split()[1:]
                    gids = next(line for line in lines if line.startswith('Gid:')).split()[1:]
                    if str(uid) in ids:
                        assert ids == [str(uid)] * 4 and gids == [str(uid)] * 4, (path.name, ids, gids)
                        found.append(int(path.name))
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, ProcessLookupError):
            continue
    return set(found)


def protocol(fd, progress, timeout=10):
    buffer = progress['buffer']
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if not select.select([fd], [], [], max(0, until - time.monotonic()))[0]:
            break
        part = os.read(fd, 65536)
        if not part:
            break
        buffer += part
        assert len(buffer) <= 256 * 1024, 'Synthetic protocol overflow'
        progress['buffer'] = buffer
        rows = [json.loads(line) for line in buffer.split(b'\n')[:-1]]
        progress['rows'] = rows
        if any(row.get('event') == 'ready' for row in rows):
            return rows, buffer
    raise AssertionError('Nested tree readiness was not established')


# Only the inner driver emits JSON over outer stdout. Terminal bytes are read
# independently from its private master and compared, never parsed as protocol.
INNER = r'''
import ctypes,fcntl,hashlib,json,os,pathlib,pty,select,signal,stat,subprocess,sys,termios,time,tty
config=json.loads(sys.argv[1]);mode=config['mode'];uid=config['uid'];frame=bytes.fromhex(config['frame'])
def emit(value):os.write(1,(json.dumps(value)+'\n').encode())
def process_row(role):
 text=pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()
 return {'role':role,'pid':os.getpid(),'ticks':text[19],'namespace':os.readlink('/proc/self/ns/pid'),
         'ppid':os.getppid(),'sid':os.getsid(0),'pgid':os.getpgid(0),'ttyNumber':int(text[4]),'uid':os.getuid()}
assert os.getuid()==0 and os.getgid()==0
for name in ['uid_map','gid_map']:assert pathlib.Path('/proc/self',name).read_text().split()==['0',str(uid),'1']
status=pathlib.Path('/proc/self/status').read_text();assert 'NoNewPrivs:\t1' in status
for name in ['CapEff','CapPrm','CapInh','CapAmb']:assert name+':\t0000000000000000' in status
assert not pathlib.Path('/.old-root').exists()
with __import__('socket').socket(__import__('socket').AF_UNIX) as channel:
 try:channel.connect(config['broker']);raise AssertionError('Outside broker reachable')
 except ConnectionRefusedError:pass
term='bmn-sixel-'+mode
original=config['terminfo'].replace('\r\n','\n');assert original.count('xterm-sixel-256color|')==1
source=original.replace('xterm-sixel-256color|',term+'|',1)
directory=pathlib.Path('/workspace/terminfo');directory.mkdir(mode=0o700)
definition=pathlib.Path('/workspace/entry.ti');definition.write_text(source)
environment={'PATH':'/usr/bin:/bin','HOME':'/home','TERM':term,'TERMINFO':str(directory)}
compile_result=subprocess.run(['/usr/bin/tic','-x','-o',str(directory),str(definition)],env=environment,capture_output=True,timeout=5)
assert compile_result.returncode==0,('tic',compile_result.returncode)
lookup=subprocess.run(['/usr/bin/infocmp','-x','-A',str(directory),term],env=environment,capture_output=True,timeout=5)
assert lookup.returncode==0 and b'Sixel,' in lookup.stdout and b'Tc,' in lookup.stdout
compiled=directory/term[0]/term;assert compiled.is_file() and not compiled.is_symlink()
terminfo={'compileExit':0,'lookupExit':0,'term':term,'privateGuestLookup':True,'sixelCapability':True,
          'compiledSha256':hashlib.sha256(compiled.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256(source.encode()).hexdigest()}
mounts=pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
assert any(' /dev/pts ' in line and ' - devpts ' in line for line in mounts),'Private devpts missing'
master,slave=pty.openpty();tty.setraw(slave)
slave_info=os.fstat(slave);assert stat.S_ISCHR(slave_info.st_mode)
driver=process_row('driver')
root=os.fork()
if root==0:
 os.close(master);os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 for fd in [0,1,2]:os.dup2(slave,fd)
 if slave>2:os.close(slave)
 assert os.isatty(0) and os.isatty(1)
 signal.signal(signal.SIGHUP,signal.SIG_DFL)
 def publish(role):
  temporary=pathlib.Path('/workspace/'+role+'.tmp');temporary.write_text(json.dumps(process_row(role)))
  temporary.rename('/workspace/'+role+'.json')
 child=os.fork()
 if child==0:
  os.setsid();sink=os.open('/dev/null',os.O_RDWR)
  for fd in [0,1,2]:os.dup2(sink,fd)
  if sink>2:os.close(sink)
  grandchild=os.fork()
  if grandchild==0:
   os.setsid();publish('grandchild');time.sleep(60);os._exit(0)
  publish('child');time.sleep(60);os._exit(0)
 os.write(1,frame);publish('root')
 if mode=='natural':os.read(0,1);os._exit(17)
 time.sleep(60);os._exit(0)
os.close(slave)
data=b'';until=time.monotonic()+5
while len(data)<len(frame) and time.monotonic()<until:
 assert select.select([master],[],[],max(0,until-time.monotonic()))[0]
 data+=os.read(master,len(frame)-len(data))
assert data==frame,'Sixel bytes changed inside private PTY'
rows=[];until=time.monotonic()+5
for role in ['root','child','grandchild']:
 path=pathlib.Path('/workspace/'+role+'.json')
 while not path.exists() and time.monotonic()<until:time.sleep(.01)
 assert path.is_file() and not path.is_symlink() and path.stat().st_size<=4096
 row=json.loads(path.read_text());assert row['role']==role and row['uid']==0;rows.append(row)
assert rows[0]['sid']==rows[0]['pid'] and rows[0]['ttyNumber']!=0
assert all(row['sid']==row['pid'] and row['ttyNumber']==0 for row in rows[1:])
emit({'event':'ready','driver':driver,'rows':rows,'terminfo':terminfo,'sixelBytesExact':True,
      'privateDevpts':True,'masterOnlyInDriver':True,'uid':uid,'mode':mode})
if mode=='natural':
 assert os.read(0,1)==b'N';os.write(master,b'x')
elif mode=='nonreading-tty-eof':
 assert os.read(0,1)==b'H';emit({'event':'inner-master-close','outerInputStillOpen':True});os.close(master);master=-1
else:
 while True:time.sleep(60)
_,status=os.waitpid(root,0)
if mode=='natural':assert os.waitstatus_to_exitcode(status)==17
else:assert os.WIFSIGNALED(status) and os.WTERMSIG(status)==signal.SIGHUP
emit({'event':'terminal-root-exit','exit':os.waitstatus_to_exitcode(status),'hangupObserved':mode=='nonreading-tty-eof'})
if master!=-1:os.close(master)
'''


def launch(uid, mode, broker):
    helper.checked(helper.LIBC.prctl(4, 1, 0, 0, 0))
    assert pathlib.Path('/proc/self/uid_map').stat().st_uid == uid
    assert os.getsid(0) == os.getpid()
    fds = {p.name for p in pathlib.Path('/proc/self/fd').iterdir() if p.exists()}
    assert fds == {'0', '1', '2'}, fds
    for fd in [0, 1, 2]:
        info = os.fstat(fd)
        assert not os.isatty(fd) and (stat.S_ISFIFO(info.st_mode) or
               stat.S_ISCHR(info.st_mode) and (os.major(info.st_rdev), os.minor(info.st_rdev)) == (1, 3))
    assert pathlib.Path('/proc/self/ns/net').stat().st_uid == 0
    binary = pathlib.Path('/usr/bin/bwrap')
    assert not binary.stat().st_mode & (stat.S_ISUID | stat.S_ISGID)
    config = json.dumps({'mode': mode, 'uid': uid, 'frame': FRAME.hex(),
                         'terminfo': TERMINFO_SOURCE, 'broker': broker})
    argv = [str(binary), '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
            '--uid', '0', '--gid', '0', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
            '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
            '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--dir', '/home', '--bind', '/workspace', '/workspace', '--chdir', '/workspace',
            '/usr/bin/python3', '-c', INNER, config]
    row = row_at(os.getpid(), 'launcher')
    row.update(event='launcher', uid=uid, argv=argv[:-2],
               executableSha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
               innerSourceSha256=hashlib.sha256(INNER.encode()).hexdigest())
    os.write(1, (json.dumps(row) + '\n').encode())
    child = subprocess.Popen(argv)
    code = child.wait()
    assert code == 0, ('bwrap', code)


def run_mode(base, runtime, mode, broker, sentinel_fd, custody):
    directory = base / mode
    directory.mkdir(mode=0o700)
    read_input, write_input = os.pipe()
    read_output, write_output = os.pipe()
    controller = os.fork()
    if controller == 0:
        os.dup2(read_input, 0)
        os.dup2(write_output, 1)
        sink = os.open('/dev/null', os.O_WRONLY)
        os.dup2(sink, 2)
        helper.run_session(directory, os.open(runtime, os.O_RDONLY | os.O_DIRECTORY),
                           lambda uid: launch(uid, mode, broker))
        os._exit(70)
    os.close(read_input)
    os.close(write_output)
    held = [retain(row_at(controller, 'controller'))]
    reaped = False
    uid = None
    progress = {'buffer': b'', 'rows': []}
    try:
        rows, buffer = protocol(read_output, progress)
        launcher = next(row for row in rows if row.get('event') == 'launcher')
        ready = next(row for row in rows if row.get('event') == 'ready')
        uid = launcher['uid']
        assert ready['uid'] == uid and ready['mode'] == mode
        reported = [launcher, ready['driver'], *ready['rows']]
        known = {}
        for row in reported:
            fd = retain(row)
            held.append(fd)
            known[host_pid(fd)] = row
        owned = scan_tree(controller)
        assert uid_tasks(uid) <= set(owned) and uid_tasks(uid), 'Unaccounted lease task'
        for pid in sorted(set(owned) - {host_pid(fd) for fd in held}):
            row = owned[pid]
            held.append(retain(row))
            known[pid] = row
        assert {host_pid(fd) for fd in held} == set(owned)
        assert len(held) >= 8, ('Missing controller/init/bwrap supervisor', len(held))
        assert not select.select(held, [], [], 0)[0], 'Ready tree already exited'
        outer_ns = launcher['namespace']
        supervisor_receipts = []
        binary_info = pathlib.Path('/usr/bin/bwrap').stat()
        for pid in sorted(owned):
            path = pathlib.Path('/proc') / str(pid)
            status = (path / 'status').read_text().splitlines()
            ids = next(line for line in status if line.startswith('Uid:')).split()[1:]
            gids = next(line for line in status if line.startswith('Gid:')).split()[1:]
            row = owned[pid]
            if pid == controller:
                role = 'controller'
                assert ids == gids == ['0'] * 4
            elif row['namespace'] == outer_ns and row['pid'] == 1:
                role = 'outer-init'
                assert ids == gids == ['0'] * 4
            else:
                assert ids == gids == [str(uid)] * 4
                if pid in known and known[pid]['role'] != 'supervisor':
                    role = known[pid]['role']
                else:
                    executable = (path / 'exe').stat()
                    assert (executable.st_dev, executable.st_ino) == (binary_info.st_dev, binary_info.st_ino), 'Unregistered supervisor'
                    role = 'bwrap-init' if row['pid'] == 1 else 'bwrap-supervisor'
            if pid != controller and row['namespace'] != outer_ns:
                for name in ['uid_map', 'gid_map']:
                    assert (path / name).read_text().split() == ['0', str(uid), '1'], (pid, name)
            supervisor_receipts.append({'role': role,
                                        'hostPid': pid, 'hostUids': ids, 'namespace': os.readlink(path / 'ns/pid')})
        assert {'controller', 'outer-init', 'launcher', 'bwrap-init', 'driver', 'root', 'child', 'grandchild'} <= {row['role'] for row in supervisor_receipts}
        assert scan_tree(controller) == owned, 'Unregistered fork after readiness'
        runtime_fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY)
        try:
            second = helper.acquire_uid(runtime_fd)
            assert second.uid != uid, 'Active lease was reused'
            second.close()
        finally:
            os.close(runtime_fd)
        if mode == 'natural':
            os.write(write_input, b'N')
        elif mode in ['stop', 'supervisor-crash']:
            signal.pidfd_send_signal(held[0], signal.SIGTERM if mode == 'stop' else signal.SIGKILL)
        elif mode == 'nonreading-tty-eof':
            os.write(write_input, b'H')
        else:
            os.close(write_input)
            write_input = -1
        pending = list(held)
        until = time.monotonic() + 8
        while pending and time.monotonic() < until:
            ended = select.select(pending, [], [], max(0, until - time.monotonic()))[0]
            pending = [fd for fd in pending if fd not in ended]
        assert not pending, (mode, 'Nested/supervisor descendant survived')
        _, status = os.waitpid(controller, 0)
        reaped = True
        assert mode not in ['natural', 'nonreading-tty-eof'] or os.waitstatus_to_exitcode(status) == 0
        assert not uid_tasks(uid), 'UID task survived cleanup'
        tail = b''
        while select.select([read_output], [], [], 1)[0]:
            part = os.read(read_output, 65536)
            if not part:
                break
            tail += part
            assert len(buffer) + len(tail) <= 256 * 1024
        events = [json.loads(line) for line in (buffer + tail).splitlines()]
        if mode == 'nonreading-tty-eof':
            assert write_input != -1, 'Outer stdin must remain open for inner hangup'
            assert any(row.get('event') == 'terminal-root-exit' and row['hangupObserved'] for row in events)
        assert not select.select([sentinel_fd], [], [], 0)[0], 'Unrelated sentinel terminated'
        return {'mode': mode, 'trigger': 'INNER-PTY-HANGUP' if mode == 'nonreading-tty-eof' else mode,
                'retainedPidfds': len(held), 'allExitedBeforeFallback': True, 'controllerReaped': True,
                'leaseTasksAbsent': True, 'activeUidNotReused': True, 'uid': uid,
                'unrelatedSentinelAlive': True, 'sixelBytesExact': ready['sixelBytesExact'],
                'privateDevpts': ready['privateDevpts'], 'terminfo': ready['terminfo'],
                'supervisors': supervisor_receipts, 'launcher': launcher}
    finally:
        # Any fallback remains on an exception path and can never grant PASS.
        primary = sys.exc_info()[1]
        cleanup_errors = []
        if uid is None:
            candidates = [row['uid'] for row in progress['rows'] if row.get('event') == 'launcher']
            if len(candidates) == 1:
                uid = candidates[0]
        if not reaped and not select.select([held[0]], [], [], 0)[0]:
            retained = {host_pid(fd) for fd in held}
            try:
                partial = scan_tree(controller)
            except BaseException:
                cleanup_errors.append('partial-tree-snapshot')
                partial = {}
            for pid in sorted(set(partial) - retained):
                try:
                    held.append(retain(partial[pid]))
                except (FileNotFoundError, ProcessLookupError):
                    pass  # This exact descendant exited during identity capture.
                except BaseException:
                    cleanup_errors.append('partial-identity-retention')
        # Killing the retained controller also triggers the existing root init's
        # parent-death guard. Still confirm every independently retained handle.
        for fd in held:
            try:
                if not select.select([fd], [], [], 0)[0]:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except BaseException:
                cleanup_errors.append('retained-kill')
        pending = list(held)
        until = time.monotonic() + 8
        while pending and time.monotonic() < until:
            ended = select.select(pending, [], [], max(0, until - time.monotonic()))[0]
            pending = [fd for fd in pending if fd not in ended]
        if pending:
            cleanup_errors.append('owned-exit-unconfirmed')
        if not reaped:
            if held[0] not in pending:
                os.waitpid(controller, 0)
            else:
                os.waitpid(controller, os.WNOHANG)
        for fd in held:
            os.close(fd)
        try:
            if uid is not None and uid_tasks(uid):
                cleanup_errors.append('leased-task-survived')
        except BaseException:
            cleanup_errors.append('lease-task-observation-unavailable')
        for fd in [write_input, read_output]:
            if fd != -1:
                os.close(fd)
        if cleanup_errors:
            custody['safeToRemove'] = False
            # Preserve a body failure; annotate cleanup rather than replacing it.
            if primary is not None:
                primary.add_note('Synthetic cleanup: ' + ','.join(cleanup_errors))
            else:
                raise RuntimeError('Synthetic cleanup: ' + ','.join(cleanup_errors))


def main():
    assert os.geteuid() == 0 and os.uname().machine == 'x86_64'
    for name in ['bwrap', 'tic', 'infocmp']:
        assert pathlib.Path('/usr/bin', name).is_file(), ('Missing guest prerequisite', name)
    base = pathlib.Path(tempfile.mkdtemp(prefix='bmn-nested-lifecycle-'))
    os.chmod(base, 0o700)
    runtime = base / 'runtime'
    runtime.mkdir(mode=0o700)
    broker = '\0bmn-nested-lifecycle-' + str(os.getpid())
    outside = socket.socket(socket.AF_UNIX)
    outside.bind(broker)
    outside.listen(8)
    with socket.socket(socket.AF_UNIX) as positive:
        positive.connect(broker)
        peer, _ = outside.accept()
        peer.close()
    sentinel = os.fork()
    if sentinel == 0:
        outside.close()
        time.sleep(140)
        os._exit(0)
    sentinel_fd = os.pidfd_open(sentinel)
    custody = {'safeToRemove': True}
    result = None
    try:
        receipts = [run_mode(base, runtime, mode, broker, sentinel_fd, custody) for mode in MODES]
        with socket.socket(socket.AF_UNIX) as positive:
            positive.connect(broker)
            peer, _ = outside.accept()
            peer.close()
        result = {'status': 'PASS_REAL_NESTED_LIFECYCLE_ONLY', 'profileComplete': False,
                          'kernel': os.uname().release, 'modes': receipts,
                          'candidateSha256': hashlib.sha256(candidate.encode()).hexdigest(),
                          'originalHelperUnchanged': True, 'outsideBrokerPositiveBeforeAfter': True,
                          'nativeHostDisconnect': 'UNVERIFIED', 'actualAgents': 'UNVERIFIED'}
    finally:
        primary = sys.exc_info()[1]
        cleanup_errors = []
        try:
            if not select.select([sentinel_fd], [], [], 0)[0]:
                signal.pidfd_send_signal(sentinel_fd, signal.SIGKILL)
            if select.select([sentinel_fd], [], [], 5)[0]:
                os.waitpid(sentinel, 0)
            else:
                cleanup_errors.append('unrelated-sentinel-cleanup-unconfirmed')
        except BaseException:
            cleanup_errors.append('unrelated-sentinel-cleanup')
        os.close(sentinel_fd)
        outside.close()
        if cleanup_errors:
            custody['safeToRemove'] = False
        if not custody['safeToRemove']:
            # The outer harness removes only this fresh disposable registration;
            # retain private lease files rather than delete under unknown tasks.
            cleanup_errors.append('private-files-retained')
        else:
            try:
                shutil.rmtree(base)
            except BaseException:
                cleanup_errors.append('private-file-cleanup')
        if cleanup_errors:
            if primary is not None:
                primary.add_note('Synthetic cleanup: ' + ','.join(cleanup_errors))
            else:
                raise RuntimeError('Synthetic cleanup: ' + ','.join(cleanup_errors))
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    def timeout(_signal, _frame):
        raise TimeoutError('Nested synthetic fixture exceeded 120 seconds')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(120)
    main()
