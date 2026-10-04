"""Synthetic Linux measurement of the approved per-session guest-root design.

Not a product adapter. Run as root only in a disposable test guest/container.
No permanent users, owner profiles, global configuration, or provider traffic.
Root creates namespaces; session code gets a distinct host UID, private root,
no capabilities, no_new_privs and an inherited x86_64 seccomp restriction.
"""
import ctypes
import errno
import json
import mmap
import os
import pathlib
import select
import signal
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time

import bmn_root_session
LIBC = bmn_root_session.LIBC
SESSION_UID = 200000
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='bmn-root-measurement-'))
os.chmod(ROOT, 0o700)
OUTSIDE_DIRECTORY = pathlib.Path('/tmp/outside-watch')
OUTSIDE_ABSTRACT = '\0bmn-synthetic-outside-broker'
OUTSIDE_PORT = None


def process_row(role):
    stat = pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()
    return {'role': role, 'pid': os.getpid(), 'ticks': stat[19], 'uid': os.getuid(),
            'namespace': os.readlink('/proc/self/ns/pid')}


def i386_getpid():
    # Actual compat entrypoint, not the native syscall() wrapper's architecture.
    with mmap.mmap(-1, 4096, prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC) as code:
        code.write(bytes.fromhex('b814000000cd80c3'))  # mov eax,20; int 0x80; ret
        function = ctypes.CFUNCTYPE(ctypes.c_int)(ctypes.addressof(ctypes.c_char.from_buffer(code)))
        return function()


def session_program(nonce, role):
    if role == 'root':
        assert os.getuid() == SESSION_UID
        status = pathlib.Path('/proc/self/status').read_text()
        for kind in ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']:
            assert kind + ':\t0000000000000000' in status
        assert 'NoNewPrivs:\t1' in status
        # No namespace or host directory FD survives the trusted setup.
        fds = [int(p.name) for p in pathlib.Path('/proc/self/fd').iterdir()
               if p.name.isdigit() and p.exists()]
        assert sorted(fds) == [0, 1, 2], fds
        for number, args in [(272, [0x00020000]), (105, [0]), (425, [1, 0]),
                             (308, [-1, 0]), (438, [-1, -1, 0]), (435, [0, 0]), (103, [10, 0, 0])]:
            ctypes.set_errno(0)
            result = LIBC.syscall(number, *args)
            expected = errno.ENOSYS if number == 435 else errno.EACCES if number == 103 else errno.EPERM
            assert result == -1 and ctypes.get_errno() == expected, (number, result, ctypes.get_errno())
        for family in [socket.AF_VSOCK, socket.AF_NETLINK]:
            try:
                socket.socket(family)
                raise AssertionError('Outside socket family permitted')
            except OSError as error:
                assert error.errno == errno.EPERM
        first, second = socket.socketpair()
        with first, second:
            first.send(b'private'); assert second.recv(7) == b'private'
        denied_brokers = []
        for family, destination, name in [
                (socket.AF_UNIX, str(OUTSIDE_DIRECTORY / 'launch.sock'), 'filesystem-unix'),
                (socket.AF_UNIX, OUTSIDE_ABSTRACT, 'abstract-unix'),
                (socket.AF_INET, ('127.0.0.1', OUTSIDE_PORT), 'tcp')]:
            try:
                with socket.socket(family) as connection:
                    connection.settimeout(1); connection.connect(destination)
                    connection.sendall(b'launch')
                raise AssertionError(('Outside broker reachable', name))
            except OSError as error:
                denied_brokers.append({'broker': name, 'errno': error.errno})
        try:
            (OUTSIDE_DIRECTORY / 'request').write_text(nonce)
            raise AssertionError('Outside file-watcher request escaped')
        except OSError as error:
            assert error.errno in [errno.ENOENT, errno.EACCES, errno.EPERM]
        pathlib.Path('/workspace/marker').write_text('synthetic private project')
        os.chmod('/workspace/marker', 0o600)
        for path in ['/tmp/outside-watch/request', '/run/outside.sock', '/mnt/c', '/sys', '/proc/1/root']:
            assert not os.access(path, os.W_OK), path
        # x32 reaches the filter before kernel support matters.
        pid = os.fork()
        if pid == 0:
            LIBC.syscall(0x40000000 | 39)
            os._exit(99)
        _, status = os.waitpid(pid, 0)
        assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGSYS
        pid = os.fork()
        if pid == 0:
            i386_getpid(); os._exit(99)
        _, status = os.waitpid(pid, 0)
        assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGSYS
        # Ordinary agent-like threading remains available after clone3 fallback.
        import threading
        observed = []
        thread = threading.Thread(target=lambda: observed.append(os.getuid()))
        thread.start(); thread.join()
        assert observed == [SESSION_UID]
    row = process_row(role)
    if role == 'root':
        row['outsideBrokersDenied'] = denied_brokers
    os.write(1, (json.dumps(row) + '\n').encode())
    if role != 'grandchild':
        pid = os.fork()
        if pid == 0:
            os.setsid()
            session_program(nonce, 'child' if role == 'root' else 'grandchild')
            os._exit(0)
    if role == 'root':
        os.read(0, 1)
    else:
        time.sleep(60)


def retain(row):
    found = []
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if os.readlink(path / 'ns/pid') != row['namespace']:
                continue
            stat = (path / 'stat').read_text().rpartition(') ')[2].split()
            lines = (path / 'status').read_text().splitlines()
            inner = int(next(s for s in lines if s.startswith('NSpid:')).split()[-1])
            if inner != row['pid'] or stat[19] != row['ticks']:
                continue
            fd = os.pidfd_open(int(path.name))
            assert (path / 'stat').read_text().rpartition(') ')[2].split()[19] == row['ticks']
            found.append(fd)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    assert len(found) == 1, (row, len(found))
    return found[0]


def run_outside_broker(ready_fd):
    os.setgroups([]); os.setgid(1000); os.setuid(1000)
    servers = []
    for family, address in [(socket.AF_UNIX, str(OUTSIDE_DIRECTORY / 'launch.sock')),
                            (socket.AF_UNIX, OUTSIDE_ABSTRACT), (socket.AF_INET, ('127.0.0.1', 0))]:
        server = socket.socket(family); server.bind(address); server.listen(4); servers.append(server)
    os.write(ready_fd, (json.dumps({'port': servers[-1].getsockname()[1]}) + '\n').encode())
    os.close(ready_fd)
    sequence = 0
    while True:
        requests = []
        for server in select.select(servers, [], [], .02)[0]:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(2)
                assert connection.recv(32) == b'launch'
                requests.append('socket')
        marker = OUTSIDE_DIRECTORY / 'request'
        if marker.exists():
            marker.unlink(); requests.append('file-watcher')
        for name in requests:
            actor = os.fork()
            if actor == 0:
                for server in servers: server.close()
                time.sleep(60); os._exit(0)
            sequence += 1
            temporary = OUTSIDE_DIRECTORY / f'actor-{sequence}.tmp'
            temporary.write_text(json.dumps({'pid': actor, 'via': name}))
            os.rename(temporary, temporary.with_suffix('.json'))


def peer_project_read(host_pid):
    read_fd, write_fd = os.pipe()
    peer = os.fork()
    if peer == 0:
        os.close(read_fd)
        os.setgroups([]); os.setgid(1000); os.setuid(1000)
        try:
            pathlib.Path(f'/proc/{host_pid}/root/workspace/marker').read_text()
            result = {'peerUid': 1000, 'procAliasDenied': False}
        except OSError as error:
            result = {'peerUid': 1000, 'procAliasDenied': error.errno in [errno.EACCES, errno.EPERM], 'errno': error.errno}
        os.write(write_fd, json.dumps(result).encode()); os._exit(0)
    os.close(write_fd)
    ready = select.select([read_fd], [], [], 3)[0]
    assert ready, 'Peer read diagnostic timed out'
    result = json.loads(os.read(read_fd, 4096)); os.close(read_fd)
    os.waitpid(peer, 0)
    assert result['procAliasDenied'], result
    return result


def measure_uid_leases():
    directory = ROOT / 'leases'; directory.mkdir(mode=0o700)
    directory_fd = os.open(directory, os.O_DIRECTORY | os.O_NOFOLLOW)
    ready, release = threading.Event(), threading.Event()
    observed = []
    def worker():
        # Raw setfsuid is per-thread: the leader continues to report UID0.
        LIBC.syscall(122, 200000)
        try:
            line = next(line for line in pathlib.Path('/proc/thread-self/status').read_text().splitlines() if line.startswith('Uid:'))
            observed.append(int(line.split()[-1])); ready.set(); release.wait(5)
        finally:
            LIBC.syscall(122, 0)
    thread = threading.Thread(target=worker); thread.start()
    unexpected = None
    try:
        assert ready.wait(3) and observed == [200000], 'Thread fsUID control must be ready'
        try:
            unexpected = bmn_root_session.acquire_uid(directory_fd, count=1)
            raise AssertionError('A live worker-thread fsUID was allocated to the session')
        except RuntimeError as error:
            assert 'No verified free' in str(error)
    finally:
        unexpected and unexpected.close(); release.set(); thread.join()
    first = bmn_root_session.acquire_uid(directory_fd)
    second = bmn_root_session.acquire_uid(directory_fd)
    assert first.uid != second.uid
    # A separate root caller must respect the live locks, not just local memory.
    read_fd, write_fd = os.pipe()
    process = os.fork()
    if process == 0:
        os.close(read_fd)
        other = bmn_root_session.acquire_uid(directory_fd)
        os.write(write_fd, str(other.uid).encode()); other.close(); os._exit(0)
    os.close(write_fd)
    assert select.select([read_fd], [], [], 5)[0]
    other_uid = int(os.read(read_fd, 32)); os.close(read_fd); os.waitpid(process, 0)
    assert other_uid not in [first.uid, second.uid]
    # Closing a lock prematurely must not reuse a still-running numerical UID.
    ready_read, ready_write = os.pipe()
    process = os.fork()
    if process == 0:
        os.close(ready_read)
        first.close(); second.close(); os.close(directory_fd)
        bmn_root_session.drop_privileges(second.uid)
        os.write(ready_write, b'ready'); os.close(ready_write)
        time.sleep(30); os._exit(0)
    handle = os.pidfd_open(process)
    os.close(ready_write)
    assert select.select([ready_read], [], [], 5)[0] and os.read(ready_read, 32) == b'ready'
    os.close(ready_read); second.close()
    next_lease = bmn_root_session.acquire_uid(directory_fd)
    assert next_lease.uid != second.uid, 'Live process UID was reused after lock closed'
    next_lease.close()
    signal.pidfd_send_signal(handle, signal.SIGKILL)
    assert select.select([handle], [], [], 5)[0]; os.close(handle); os.waitpid(process, 0)
    recovered = bmn_root_session.acquire_uid(directory_fd)
    assert recovered.uid == second.uid, 'Empty stale slot cannot be reused after confirmed exit'
    recovered.close()
    # Private runtime objects must be ordinary, single-linked, root-owned files.
    bad = ROOT / 'bad-leases'; bad.mkdir(mode=0o700)
    bad_fd = os.open(bad, os.O_DIRECTORY | os.O_NOFOLLOW)
    sentinel = ROOT / 'sentinel'; sentinel.write_text('unrelated fixture sentinel')
    os.symlink(sentinel, bad / 'uid-200000.lock')
    try:
        bmn_root_session.acquire_uid(bad_fd, count=1)
        raise AssertionError('Symlink UID lock adopted')
    except OSError as error:
        assert error.errno == errno.ELOOP
    assert sentinel.read_text() == 'unrelated fixture sentinel'
    os.unlink(bad / 'uid-200000.lock')
    linked = bad / 'original.lock'; linked.touch(mode=0o600)
    os.link(linked, bad / 'uid-200000.lock')
    try:
        bmn_root_session.acquire_uid(bad_fd, count=1)
        raise AssertionError('Hardlink UID lock adopted')
    except RuntimeError as error:
        assert 'ordinary' in str(error)
    os.close(bad_fd)
    return first, directory_fd, {'separateRootCaller': True, 'liveUidNotReused': True,
        'staleSlotReusedAfterExit': True, 'symlinkAndHardlinkRefused': True, 'workerThreadFsUidNotReused': True}


def syslog_size_control():
    read_fd, write_fd = os.pipe()
    process = os.fork()
    if process == 0:
        os.close(read_fd); bmn_root_session.drop_privileges(1000)
        ctypes.set_errno(0)
        result = LIBC.syscall(103, 10, 0, 0)  # SYSLOG_ACTION_SIZE_BUFFER, no contents
        os.write(write_fd, json.dumps({'sizeProbeAllowed': result >= 0, 'errno': ctypes.get_errno()}).encode())
        os._exit(0)
    os.close(write_fd)
    assert select.select([read_fd], [], [], 3)[0], 'No-content syslog control timed out'
    result = json.loads(os.read(read_fd, 4096)); os.close(read_fd); os.waitpid(process, 0)
    return {'unfilteredControl': 'ALLOWED' if result['sizeProbeAllowed'] else 'INCONCLUSIVE_OUTER_DENIAL',
            'controlErrno': result['errno'], 'filteredPolicyErrno': errno.EACCES, 'contentsRead': False}


def measure_callback_failure(runtime_fd):
    """A forked session failure must exit, never unwind root-caller cleanup."""
    directory = ROOT / 'callback-failure'
    directory.mkdir()
    read_output, write_output = os.pipe()
    supervisor = os.fork()
    if supervisor == 0:
        os.close(read_output); os.dup2(write_output, 1)
        def failure(_uid):
            raise RuntimeError('Synthetic session callback failure')
        try:
            bmn_root_session.run_session(directory, runtime_fd, failure)
        except BaseException:
            os.write(1, b'caller-frame-unwound')
            os._exit(90)
        os._exit(91)
    os.close(write_output)
    handle = os.pidfd_open(supervisor)
    try:
        assert select.select([handle], [], [], 8)[0], 'Failing session did not exit'
        _, status = os.waitpid(supervisor, 0)
        supervisor = None
        output = os.read(read_output, 4096)
        assert os.waitstatus_to_exitcode(status) == 70 and output == b'', (status, output)
        return {'exit': 70, 'callerCleanupUnwound': False}
    finally:
        if supervisor is not None:
            signal.pidfd_send_signal(handle, signal.SIGKILL); os.waitpid(supervisor, 0)
        os.close(handle); os.close(read_output)


def main():
    global OUTSIDE_PORT, SESSION_UID
    assert os.getuid() == 0 and os.uname().machine == 'x86_64'
    assert i386_getpid() == os.getpid(), 'Compat ABI positive control required'
    syslog_receipt = syslog_size_control()
    # Synthetic lease: production allocation and concurrent identity reuse remain
    # a separate gate. Never test against an occupied numerical identity.
    for path in pathlib.Path('/proc').iterdir():
        if path.name.isdigit():
            assert str(SESSION_UID) not in (path / 'status').read_text().split('Uid:')[1].splitlines()[0].split()
    lease, lease_directory_fd, uid_receipt = measure_uid_leases()
    SESSION_UID = lease.uid
    lease.close()
    callback_receipt = measure_callback_failure(lease_directory_fd)
    OUTSIDE_DIRECTORY.mkdir(mode=0o700)
    os.chown(OUTSIDE_DIRECTORY, 1000, 1000)
    ready_read, ready_write = os.pipe()
    broker = os.fork()
    if broker == 0:
        os.close(ready_read); run_outside_broker(ready_write); os._exit(0)
    os.close(ready_write)
    broker_fd = os.pidfd_open(broker)
    assert select.select([ready_read], [], [], 5)[0], 'Outside broker must be ready'
    OUTSIDE_PORT = json.loads(os.read(ready_read, 4096))['port']; os.close(ready_read)
    actor_handles = []
    # Every outside route is exercised positively before denial is assessed.
    for family, destination in [(socket.AF_UNIX, str(OUTSIDE_DIRECTORY / 'launch.sock')),
                                (socket.AF_UNIX, OUTSIDE_ABSTRACT), (socket.AF_INET, ('127.0.0.1', OUTSIDE_PORT))]:
        with socket.socket(family) as connection:
            connection.settimeout(2); connection.connect(destination); connection.sendall(b'launch')
    (OUTSIDE_DIRECTORY / 'request').write_text('synthetic positive control')
    deadline = time.monotonic() + 5
    while len(list(OUTSIDE_DIRECTORY.glob('actor-*.json'))) != 4 and time.monotonic() < deadline:
        time.sleep(.02)
    actor_records = [json.loads(p.read_text()) for p in OUTSIDE_DIRECTORY.glob('actor-*.json')]
    assert len(actor_records) == 4, 'All outside broker positive controls must launch'
    actor_handles = [os.pidfd_open(row['pid']) for row in actor_records]
    receipts = []
    try:
      for mode in ['natural', 'stop', 'supervisor-crash', 'stdin-eof']:
        directory = ROOT / mode
        directory.mkdir()
        read_input, write_input = os.pipe()
        read_output, write_output = os.pipe()
        supervisor = os.fork()
        if supervisor == 0:
            os.dup2(read_input, 0); os.dup2(write_output, 1)
            # Root keeps only trusted measurement resources; run_session closes
            # every extra FD before calling unprivileged entry(uid).
            def entry(uid):
                global SESSION_UID
                SESSION_UID = uid
                session_program(mode, 'root')
            bmn_root_session.run_session(directory, lease_directory_fd, entry)
        os.close(read_input); os.close(write_output)
        held = []
        try:
            buffer = b''; deadline = time.monotonic() + 10
            while buffer.count(b'\n') < 3 and time.monotonic() < deadline:
                if select.select([read_output], [], [], max(0, deadline-time.monotonic()))[0]:
                    data = os.read(read_output, 65536)
                    if not data:
                        break
                    buffer += data
            rows = [json.loads(line) for line in buffer.splitlines()]
            assert len(rows) == 3, (mode, buffer, os.waitid(os.P_PID, supervisor, os.WEXITED | os.WNOHANG | os.WNOWAIT))
            assert all(row['uid'] == SESSION_UID for row in rows)
            held = [retain(row) for row in rows]
            root_handle = held[next(i for i, row in enumerate(rows) if row['role'] == 'root')]
            host_pid = int(next(line for line in pathlib.Path(f'/proc/self/fdinfo/{root_handle}').read_text().splitlines()
                                if line.startswith('Pid:')).split()[1])
            assert pathlib.Path(f'/proc/{host_pid}/root/workspace/marker').read_text() == 'synthetic private project'
            peer = peer_project_read(host_pid)
            if mode == 'natural':
                os.write(write_input, b'x')
            elif mode == 'stop':
                os.kill(supervisor, signal.SIGTERM)
            elif mode == 'supervisor-crash':
                os.kill(supervisor, signal.SIGKILL)
            else:
                os.close(write_input); write_input = -1
            pending = list(held); deadline = time.monotonic() + 8
            while pending and time.monotonic() < deadline:
                ready = select.select(pending, [], [], max(0, deadline-time.monotonic()))[0]
                pending = [fd for fd in pending if fd not in ready]
            assert not pending, (mode, 'retained descendant survived')
            _, status = os.waitpid(supervisor, 0)
            supervisor = None
            assert mode != 'natural' or os.waitstatus_to_exitcode(status) == 0
            assert len(list(OUTSIDE_DIRECTORY.glob('actor-*.json'))) == 4, 'Restricted request created outside actor'
            assert not select.select([broker_fd, *actor_handles], [], [], 0)[0], 'Unrelated outside sentinel terminated'
            receipts.append({'mode': mode, 'uid': SESSION_UID, 'retainedPidfds': len(held), 'allExited': True,
                             'peer': peer, 'outsideActorsCreated': 0, 'unrelatedSentinelsAlive': True,
                             'outsideBrokersDenied': next(row for row in rows if row['role'] == 'root')['outsideBrokersDenied']})
        finally:
            if supervisor is not None:
                os.kill(supervisor, signal.SIGKILL); os.waitpid(supervisor, 0)
            for fd in held:
                if not select.select([fd], [], [], 0)[0]:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                os.close(fd)
            if write_input != -1:
                os.close(write_input)
            os.close(read_output)
    finally:
        for fd in [broker_fd, *actor_handles]:
            if not select.select([fd], [], [], 0)[0]: signal.pidfd_send_signal(fd, signal.SIGKILL)
            assert select.select([fd], [], [], 5)[0], 'Synthetic outside actor cleanup not confirmed'
            os.close(fd)
        os.waitpid(broker, 0)
        lease.close(); os.close(lease_directory_fd)
        shutil.rmtree(OUTSIDE_DIRECTORY)
        shutil.rmtree(ROOT)
    print(json.dumps({'scope': 'Synthetic root-owned namespaces/UID/private-filesystem/syscall/lifecycle measurement',
                      'architecture': 'x86_64', 'kernel': os.uname().release,
                      'lifecycle': receipts, 'profileComplete': False, 'syntheticFilesRemoved': True,
                      'nativeWindows': 'UNVERIFIED', 'wsl2': 'UNVERIFIED',
                      'outsideBrokerPositiveControls': 4,
                      'uidLeases': uid_receipt,
                      'callbackFailure': callback_receipt,
                      'syslogSizeProbe': syslog_receipt,
                      'i386PositiveControl': True, 'i386AndX32Denied': True,
                      'remaining': ['durable project import/export', 'owned provider egress', 'scoped bmn relay',
                                    'PTY/terminfo', 'actual WSL/native-host lifecycle']}), flush=True)


if __name__ == '__main__':
    def timeout(_signal, _frame):
        raise TimeoutError('Synthetic fixture exceeded 75 seconds')
    signal.signal(signal.SIGALRM, timeout); signal.alarm(75)
    main()
