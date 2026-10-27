#!/usr/bin/python3
# MODULE: bench-launch.py - gated, stdlib-only admission to the pinned QA cgroup before any workload executes
import fcntl
import json
import os
import pathlib
import select
import sys
import time


def atomic_json(path, value):
    temporary = str(path) + '.' + str(os.getpid()) + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def live(identity):
    try:
        fields = pathlib.Path('/proc/%s/stat' % identity['pid']).read_text().rsplit(') ', 1)[1].split()
        return fields[19] == identity['start_ticks'] and fields[0] != 'Z'
    except FileNotFoundError:
        return False


config = json.loads(pathlib.Path(sys.argv[1]).read_text())
run = pathlib.Path(config['run'])
repo = pathlib.Path(__file__).resolve().parents[2]
current_file = repo / '.dev-auto/evidence/qa-bench/current.json'
lock_file = current_file.parent / 'lifecycle.lock'
fields = pathlib.Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()
parent_trace = None
try:
    parent = os.getppid()
    parent_fields = pathlib.Path('/proc/%s/stat' % parent).read_text().rsplit(') ', 1)[1].split()
    candidate = {'pid': parent, 'start_ticks': parent_fields[19]}
    if os.readlink('/proc/%s/exe' % parent) == '/usr/bin/strace' and live(candidate):
        parent_trace = candidate
except FileNotFoundError:
    pass
birth_state = json.loads(current_file.read_text())
key = config['runId'][-16:]
intent = next((trace for trace in birth_state.get('tracers', []) if trace['key'] == key), {})
gate_deadline = intent.get('gateDeadlineAt', 0)
atomic_json(run / 'launcher.json', {'pid': os.getpid(), 'start_ticks': fields[19], 'tracer': parent_trace,
                                  'runId': config['runId'], 'key': key, 'gateDeadlineAt': gate_deadline})

# Only the starter holds the other end. A crash before its durable journal closes this gate.
while time.time() * 1000 < gate_deadline:
    if select.select([3], [], [], 0.1)[0]:
        if os.read(3, 64) != b'go\n':
            sys.exit(1)
        break
    waiting_state = json.loads(current_file.read_text())
    if waiting_state.get('runId') != config['runId'] or waiting_state.get('status') != 'starting':
        sys.exit(1)
else:
    sys.exit(1)
os.close(3)

with lock_file.open('a') as lock:
    deadline = time.monotonic() + 5
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError('QA admission lock timed out')
            time.sleep(0.02)
    state = json.loads(current_file.read_text())
    watchdog = state.get('watchdog') or {}
    if state.get('runId') != config['runId'] or state.get('status') != 'starting' or not watchdog.get('ready'):
        raise RuntimeError('QA admission was cancelled or superseded')
    if not live(watchdog['identity']) or not live(watchdog['tracer']):
        raise RuntimeError('QA recovery monitor is unavailable')
    root = pathlib.Path(config['root'])
    root_stat = root.lstat()
    if root.is_symlink() or (root_stat.st_dev, root_stat.st_ino) != (config['rootIdentity']['device'], config['rootIdentity']['inode']):
        raise RuntimeError('QA root identity changed before admission')
    if (root / '.bmn-qa-run').read_text() != config['runId']:
        raise RuntimeError('QA root marker changed before admission')
    group = config['group']
    group_fd = os.open(group['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(group_fd)
        if (actual.st_dev, actual.st_ino) != (group['device'], group['inode']):
            raise RuntimeError('QA cgroup identity changed before admission')
        procs = os.open('cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=group_fd)
        try:
            os.write(procs, str(os.getpid()).encode())
        finally:
            os.close(procs)
    finally:
        os.close(group_fd)

# Python descriptors are non-inheritable; the lifecycle lock is closed before exec.
os.execve('/usr/bin/dbus-run-session', ['/usr/bin/dbus-run-session', '--config-file', config['busConfig'], '--',
          config['node'], str(repo / 'scripts/qa/bench-server.mjs'), str(run / 'config.json')], dict(os.environ))
