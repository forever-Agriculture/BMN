#!/usr/bin/python3
# MODULE: bench-recorder.py - private launch lease holder and actual parent of one traced branch
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import stat
import subprocess
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
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def process_identity(pid):
    fields = pathlib.Path('/proc/%s/stat' % pid).read_text().rsplit(') ', 1)[1].split()
    return {'pid': pid, 'start_ticks': fields[19]}


def file_identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino}


def matches(info, expected):
    return file_identity(info) == {'device': expected['device'], 'inode': expected['inode']}


def environment(root):
    env = {'PATH': str(root / 'bin') + ':/usr/bin:/bin', 'HOME': str(root / 'home'),
           'USER': 'qa', 'SHELL': '/bin/bash', 'LANG': 'C.UTF-8', 'TZ': 'UTC',
           'TMPDIR': str(root / 'tmp'), 'BMN_LAUNCH_CWD': str(root / 'synthetic-project')}
    for name in ['config', 'data', 'state', 'cache', 'runtime']:
        env['XDG_' + name.upper() + ('_DIR' if name == 'runtime' else '_HOME')] = str(root / name)
    for name in ['config', 'data', 'state', 'runtime']:
        env['BMN_' + name.upper() + '_HOME'] = str(root / name / 'bmn')
    env.update({'CLAUDE_CONFIG_DIR': str(root / 'config/claude'), 'CODEX_HOME': str(root / 'config/codex'),
                'OPENCODE_CONFIG_DIR': str(root / 'config/opencode')})
    return env


repo = pathlib.Path(__file__).resolve().parents[2]
run_id, key = sys.argv[1:3]
if not re.fullmatch(r'\d+-[a-f0-9]{16}', run_id) or not re.fullmatch(r'[a-f0-9]{16}', key):
    raise RuntimeError('Invalid recorder identity')
run = repo / '.dev-auto/evidence/qa-bench' / run_id
config = json.loads((run / 'config.json').read_text())
entry = json.loads((run / ('launch-' + key + '.json')).read_text())
current_file = run.parent / 'current.json'
lease = entry['lease']
if lease['path'] != str(run / ('launch-' + key + '.lease')) or not matches(os.fstat(4), lease):
    raise RuntimeError('Recorder lease does not match its creation')
if config['run'] != str(run) or config['runId'] != run_id or entry['key'] != key:
    raise RuntimeError('Recorder metadata mismatch')
if os.environ.get('HOME') != str(run / 'recovery-root/home') or pathlib.Path.cwd() != run / 'recovery-root':
    raise RuntimeError('Recorder needs its retained private environment')
self_identity = process_identity(os.getpid())
birth = {'runId': run_id, 'launchKey': key, 'role': entry['role'], 'recorderIdentity': self_identity,
         'tracerIdentity': None, 'admitted': False}
birth_file = run / entry['recorderFile']
atomic_json(birth_file, birth)


def locked(callback):
    with (run.parent / 'lifecycle.lock').open('a') as lock:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Recorder admission lock timed out')
                time.sleep(.02)
        state = json.loads(current_file.read_text())
        allowed = ['starting'] if entry['role'] == 'workload' else ['starting', 'stopping']
        if state.get('runId') != run_id or state.get('status') not in allowed or not any(t['key'] == key for t in state['tracers']):
            raise RuntimeError('Recorder launch was cancelled or superseded')
        return callback()


def admit():
    group = entry['group']
    expected_parent = '/sys/fs/cgroup/user.slice/user-%s.slice/user@%s.service/app.slice' % (os.getuid(), os.getuid())
    expected = expected_parent + '/bmn-qa-' + run_id + '-' + key + '.scope'
    if group['path'] != expected or group['parent'] != expected_parent or not matches(os.stat(expected_parent), group['parentIdentity']):
        raise RuntimeError('Recorder cgroup parent mismatch')
    fd = os.open(expected, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if not matches(os.fstat(fd), group):
            raise RuntimeError('Recorder cgroup identity changed')
        procs = os.open('cgroup.procs', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            os.write(procs, str(os.getpid()).encode())
        finally:
            os.close(procs)
    finally:
        os.close(fd)
    birth['admitted'] = True
    atomic_json(birth_file, birth)


def gate():
    deadline = entry['gateDeadlineAt'] / 1000
    while time.time() < deadline:
        if select.select([3], [], [], .05)[0]:
            return os.read(3, 64) == b'go\n'
        state = json.loads(current_file.read_text())
        if state.get('runId') != run_id or state.get('status') == 'stopped':
            return False
        if entry['role'] == 'workload' and state.get('status') != 'starting':
            return False
    return False


def launch():
    root = pathlib.Path(config['root'] if entry['role'] == 'workload' else config['recoveryRoot'])
    if entry['role'] == 'workload':
        if not matches(root.lstat(), config['rootIdentity']) or root.is_symlink() or (root / '.bmn-qa-run').read_text() != run_id:
            raise RuntimeError('Workload root identity changed')
        command = ['/usr/bin/python3', '-I', '-S', str(repo / 'scripts/qa/bench-launch.py'), str(run / 'config.json')]
    else:
        command = [config['node'], str(repo / 'scripts/qa/bench-recovery.mjs'), run_id, key]
    child = subprocess.Popen(['/usr/bin/strace', '-f', '-q', '-v', '--decode-pids=pidns', '-s', '4096', '-e', 'trace=%file,connect,%process',
                              '-o', str(run / entry['file']), *command], cwd=root, env=environment(root), pass_fds=(3,))
    birth['tracerIdentity'] = process_identity(child.pid)
    atomic_json(birth_file, birth)
    os.close(3)
    os.write(internal_writer, b'go\n')
    os.close(internal_writer)
    return child


try:
    locked(admit)
    accepted = gate()
    os.close(3)
    if not accepted:
        sys.exit(1)
    internal_reader, internal_writer = os.pipe()
    if internal_reader != 3:
        raise RuntimeError('Recorder child gate descriptor unavailable')
    # Membership plus the held lease cover every later fork; do not hold the global lock while spawning.
    child = launch()
    _, status = os.waitpid(child.pid, 0)
    child.returncode = os.waitstatus_to_exitcode(status)
    trace_fd = os.open(run / entry['file'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(trace_fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Trace is not a regular file')
        with os.fdopen(trace_fd, 'rb', closefd=False) as stream:
            data = stream.read()
        os.fsync(trace_fd)
    finally:
        os.close(trace_fd)
    log = run / ('bench.log' if entry['role'] == 'workload' else 'recovery-' + key + '.log')
    errors = [line for line in log.read_text(errors='replace').splitlines() if line.startswith('strace:') or re.search(r'Process \d+ detached', line)]
    atomic_json(run / entry['certificateFile'], {'version': 1, 'runId': run_id, 'launchKey': key, 'role': entry['role'],
                'recorderIdentity': self_identity, 'tracerIdentity': birth['tracerIdentity'], 'launchGroupIdentity': {'device': entry['group']['device'], 'inode': entry['group']['inode']},
                'rawWaitStatus': status, 'exitCode': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
                'signal': os.WTERMSIG(status) if os.WIFSIGNALED(status) else None, 'traceFileIdentity': file_identity(info),
                'traceBytes': len(data), 'traceSha256': hashlib.sha256(data).hexdigest(), 'traceErrors': errors})
except Exception as error:
    atomic_json(run / ('recorder-' + key + '-error.json'), {'error': str(error), 'identity': self_identity})
    print('QA recorder:', str(error), file=sys.stderr)
    sys.exit(1)
# Closing FD4 on exit releases the lease. Never unlock its shared open-file description explicitly.
