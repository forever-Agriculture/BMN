#!/usr/bin/python3
# MODULE: browser-accounts-launch.py - Register a gated browser PID namespace and drain every writer before a RAM lease is wiped.
import fcntl
import json
import os
import select
import shutil
import signal
import subprocess
import sys
import uuid
from contextlib import contextmanager


def identity(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as source:
            ticks = source.read().rsplit(') ', 1)[1].split()[19]
        return {'pid': int(pid), 'ticks': ticks}
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(expected):
    return bool(expected and identity(expected['pid']) == expected)


def read_json(path):
    with open(path) as source:
        return json.load(source)


def atomic_json(path, value):
    temporary = path + '.' + uuid.uuid4().hex + '.tmp'
    try:
        with open(temporary, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as target:
            json.dump(value, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        fd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def paths(folder):
    folder = os.path.abspath(folder)
    runtime, name = os.path.split(folder)
    expected = os.path.join(os.environ['XDG_RUNTIME_DIR'], 'b')
    assert runtime == expected and name.startswith(('s-', 'anonymous-'))
    assert os.stat(runtime).st_uid == os.getuid() and os.stat(runtime).st_mode & 0o077 == 0
    records, locks = os.path.join(runtime, '.launches'), os.path.join(runtime, '.lifecycle')
    for directory in (records, locks):
        os.makedirs(directory, mode=0o700, exist_ok=True)
    return folder, name, os.path.join(runtime, '.claims', name + '.json'), records, os.path.join(locks, name + '.lock')


@contextmanager
def lifecycle(lock):
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def terminate(expected, first=signal.SIGKILL):
    if not expected:
        return
    try:
        fd = os.pidfd_open(expected['pid'])
    except ProcessLookupError:
        return
    try:
        if identity(expected['pid']) != expected:
            return
        poll = select.poll()
        poll.register(fd, select.POLLIN | select.POLLHUP)
        if poll.poll(0):
            return
        signal.pidfd_send_signal(fd, first)
        if poll.poll(1000 if first != signal.SIGKILL else 10_000):
            return
        if first != signal.SIGKILL and identity(expected['pid']) == expected:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        assert poll.poll(10_000), 'browser writer did not exit'
    finally:
        os.close(fd)


def drain(record):
    # A namespace init's completed exit proves every descendant writer has terminated.
    terminate(record.get('init'))
    terminate(record.get('monitor'), signal.SIGTERM)
    terminate(record.get('launcher'), signal.SIGTERM)


def finish(request, erase):
    folder, name, claim_path, records, lock = paths(request['folder'])
    with lifecycle(lock):
        claim = read_json(claim_path) if os.path.exists(claim_path) else request
        assert claim['folder'] == folder and claim['profile'] == os.path.join(folder, 'profile')
        owner = {'pid': claim['pid'], 'ticks': claim['ticks']}
        assert not alive(owner) or os.getppid() == owner['pid']
        # Seal under the launch lock before draining. A delayed launch must never
        # reopen this lease while its profile is being archived or removed.
        if os.path.exists(claim_path):
            atomic_json(claim_path, {**claim, 'sealed': True})
        launches = [os.path.join(records, entry) for entry in os.listdir(records)
                    if entry.startswith(name + '--') and entry.endswith('.json')]
        for entry in launches:
            record = read_json(entry)
            assert record['folder'] == folder and record['owner'] == owner
            drain(record)
        # Claims and launch records remain outside the wiped subtree until this succeeds.
        if erase and os.path.exists(folder):
            shutil.rmtree(folder)
        for entry in launches:
            os.unlink(entry)
        if erase and os.path.exists(claim_path):
            os.unlink(claim_path)
    print(json.dumps({'ok': True}))


def namespace_init(arguments):
    gate, ready = int(arguments[0]), int(arguments[1])
    assert os.getpid() == 1 and os.getuid() != 0
    os.write(ready, json.dumps({'namespace': os.readlink('/proc/self/ns/pid')}).encode())
    os.close(ready)
    permitted = os.read(gate, 1) == b'1'
    os.close(gate)
    if not permitted:
        return 1
    chrome = subprocess.Popen(['/usr/bin/google-chrome', *arguments[2:]], pass_fds=(3, 4))
    os.close(3)
    os.close(4)
    # Exiting PID 1 invokes kernel teardown, including reparented/double-forked helpers.
    return chrome.wait()


def launch(arguments):
    profile = next(argument.split('=', 1)[1] for argument in arguments if argument.startswith('--user-data-dir='))
    folder, name, claim_path, records, lock = paths(os.path.dirname(profile))
    record_path = os.path.join(records, name + '--' + uuid.uuid4().hex + '.json')
    monitor = None
    record = None
    gate_write = ready_read = None
    try:
        with lifecycle(lock):
            # Never recreate a removed lease from a delayed launch callback.
            claim = read_json(claim_path)
            assert not claim.get('sealed'), 'browser lease is sealed'
            owner = {'pid': claim['pid'], 'ticks': claim['ticks']}
            assert claim['folder'] == folder and claim['profile'] == profile
            assert alive(owner) and os.getppid() == owner['pid']
            os.makedirs(os.path.join(folder, 'browser-home'), mode=0o700, exist_ok=True)
            record = {'folder': folder, 'owner': owner, 'launcher': identity(os.getpid())}
            atomic_json(record_path, record)
            gate_read, gate_write = os.pipe()
            ready_read, ready_write = os.pipe()
            monitor = subprocess.Popen([
                '/usr/bin/unshare', '--user', '--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL',
                '/usr/bin/python3', os.path.abspath(__file__), '--namespace-init', str(gate_read), str(ready_write), *arguments
            ], pass_fds=(3, 4, gate_read, ready_write))
            os.close(gate_read)
            os.close(ready_write)
            record['monitor'] = identity(monitor.pid)
            atomic_json(record_path, record)
            assert select.select([ready_read], [], [], 10)[0], 'namespace did not become ready'
            ready = json.loads(os.read(ready_read, 4096))
            with open('/proc/' + str(monitor.pid) + '/task/' + str(monitor.pid) + '/children') as source:
                children = source.read().split()
            assert len(children) == 1
            init = identity(int(children[0]))
            assert init and os.readlink('/proc/' + str(init['pid']) + '/ns/pid') == ready['namespace']
            record['init'] = init
            record['namespace'] = ready['namespace']
            atomic_json(record_path, record)
            assert alive(owner) and os.path.exists(claim_path)
            os.write(gate_write, b'1')
            os.close(gate_write)
            gate_write = None
        os.close(3)
        os.close(4)
        return monitor.wait()
    except Exception:
        # Before the gate opens there can be no Chrome; afterwards init identity is already durable.
        if gate_write is not None:
            os.close(gate_write)
            gate_write = None
        if record:
            if record.get('init'):
                terminate(record['init'])
            if record.get('monitor'):
                terminate(record['monitor'])
        raise
    finally:
        if gate_write is not None:
            os.close(gate_write)
        if ready_read is not None:
            os.close(ready_read)


try:
    if len(sys.argv) > 1 and sys.argv[1] == '--terminate':
        request = json.load(sys.stdin)
        assert request['owner'] == identity(os.getppid())
        terminate(request['child'])
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] in ('--discard', '--seal'):
        finish(json.load(sys.stdin), sys.argv[1] == '--discard')
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == '--namespace-init':
        sys.exit(namespace_init(sys.argv[2:]))
    sys.exit(launch(sys.argv[1:]))
except Exception:
    # Never print browser argv, environment, profile contents or a credential-bearing exception.
    sys.stderr.write('BMN browser lifecycle unavailable.\n')
    sys.exit(1)
