"""Per-session guest-root helper prototype for the approved restricted profile.

Root must be invoked only in the selected distribution. No permanent users or
configuration changes. Not wired to BMN until provider, bridge, durable workspace
and native WSL measurements pass. The entry callable is trusted measurement code,
executed only after privilege drop; a production argv protocol is not yet exposed.
"""
import ctypes
import errno
import fcntl
import os
import pathlib
import pwd
import select
import signal
import socket
import stat

LIBC = ctypes.CDLL(None, use_errno=True)
NAMESPACES = 0x00020000 | 0x20000000 | 0x40000000 | 0x08000000 | 0x04000000

class UidLease:
    """Kernel flock lease, held by the root controller until confirmed exit."""
    def __init__(self, uid, descriptor):
        self.uid = uid
        self.descriptor = descriptor

    def close(self):
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None


def private_lock(directory_fd, name):
    descriptor = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=directory_fd)
    info = os.fstat(descriptor)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and info.st_size == 0):
        os.close(descriptor)
        raise RuntimeError('UID lease must be an empty private root-owned ordinary file')
    return descriptor


def uid_in_use(uid):
    try:
        pwd.getpwuid(uid)
        return True
    except KeyError:
        pass
    for process in pathlib.Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            # Linux credentials belong to threads. The thread-group leader's
            # status does not cover a worker with a different fsUID or raw UID.
            for thread in (process / 'task').iterdir():
                try:
                    line = next(row for row in (thread / 'status').read_text().splitlines() if row.startswith('Uid:'))
                    if uid in map(int, line.split()[1:]):
                        return True
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Unknown process access is a refusal, not evidence that a UID is free.
    return False


def acquire_uid(directory_fd, first=200000, count=4096):
    """All helpers in a distribution share one private runtime directory.

    The caller creates/opens it safely; it is runtime state, never passwd/config.
    Stale files are reusable only when kernel lock and account/process checks
    agree. Closing a lease while children live cannot make that UID reusable.
    """
    info = os.fstat(directory_fd)
    if not (os.geteuid() == 0 and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
            1 <= first <= 2147483647 and 1 <= count <= 4096 and first + count <= 2147483648):
        raise RuntimeError('Private root runtime directory and bounded non-root UID range required')
    guard = private_lock(directory_fd, 'allocation.lock')
    try:
        fcntl.flock(guard, fcntl.LOCK_EX)
        for uid in range(first, first + count):
            descriptor = private_lock(directory_fd, f'uid-{uid}.lock')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(descriptor)
                continue
            try:
                occupied = uid_in_use(uid)
            except BaseException:
                os.close(descriptor)
                raise
            if occupied:
                os.close(descriptor)
                continue
            return UidLease(uid, descriptor)
        raise RuntimeError('No verified free per-session UID is available')
    finally:
        os.close(guard)


def checked(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def drop_privileges(uid):
    os.setgroups([]); os.setgid(uid); os.setuid(uid)
    # Clear inherited/ambient sets explicitly, even if the trusted caller had
    # configured keepcaps. no_new_privs later prevents gaining file privileges.
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint), ('pid', ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint), ('permitted', ctypes.c_uint), ('inheritable', ctypes.c_uint)]
    header, data = Header(0x20080522, 0), (Data * 2)()
    checked(LIBC.capset(ctypes.byref(header), data))
    checked(LIBC.prctl(47, 4, 0, 0, 0))  # PR_CAP_AMBIENT_CLEAR_ALL


def close_session_fds():
    # Require Linux close_range rather than assume the caller's descriptor limit.
    checked(LIBC.syscall(436, ctypes.c_uint(3), ctypes.c_uint(0xffffffff), ctypes.c_uint(0)))


def mount(source, target, kind=None, flags=0, data=None):
    checked(LIBC.mount(source.encode() if source else None, str(target).encode(),
                       kind.encode() if kind else None, ctypes.c_ulong(flags),
                       data.encode() if data else None))


def restrict_syscalls():
    # Explicitly reject i386 and x32 before interpreting x86_64 syscall numbers.
    allow, denied, kill = 0x7fff0000, 0x00050000 | errno.EPERM, 0x80000000
    ops = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xc000003e), (0x06, 0, 0, kill),
           (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, kill)]
    # Kernel-global logs are outside this session. Distinct EACCES makes this
    # policy's denial measurable even when an outer filter already uses EPERM.
    ops.extend([(0x15, 0, 1, 103), (0x06, 0, 0, 0x00050000 | errno.EACCES)])
    # No namespace/mount re-entry, outside-process FD/inspection, privileged
    # kernel interfaces, io_uring socket bypass or identity changes. This is a
    # measured restricted profile, not a claim to cover every future syscall.
    blocked = [101, 105, 106, 113, 114, 117, 119, 122, 123, 165, 166, 155,
               161, 163, 164, 167, 168, 169, 175, 176, 246, 248, 249, 250,
               272, 298, 303, 304, 308, 310, 311, 313, 321, 323,
               425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 440, 442]
    for number in blocked:
        ops.extend([(0x15, 0, 1, number), (0x06, 0, 0, denied)])
    # clone3's pointer flags are opaque to classic BPF. ENOSYS permits ordinary
    # libc/pthread fallback; clone accepts normal processes/threads only.
    ops.extend([(0x15, 0, 1, 435), (0x06, 0, 0, 0x00050000 | errno.ENOSYS),
                (0x15, 0, 4, 56), (0x20, 0, 0, 16),
                (0x45, 0, 1, NAMESPACES | 0x10000000 | 0x02000000 | 0x00000080),
                (0x06, 0, 0, denied), (0x06, 0, 0, allow),
                (0x15, 1, 0, 41), (0x15, 0, 5, 53), (0x20, 0, 0, 16),
                (0x15, 3, 0, socket.AF_UNIX), (0x15, 2, 0, socket.AF_INET),
                (0x15, 1, 0, socket.AF_INET6), (0x06, 0, 0, denied),
                (0x06, 0, 0, allow)])
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    filters = (Filter * len(ops))(*(Filter(*op) for op in ops))
    program = Program(len(ops), filters)
    checked(LIBC.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    checked(LIBC.prctl(22, 2, ctypes.byref(program), 0, 0))


def install_root(directory, uid):
    mount(None, '/', flags=0x4000 | 0x40000)  # private recursive propagation
    mount('tmpfs', directory, 'tmpfs', 2 | 4, 'size=32m,mode=0755')
    for name in ['usr', 'bin', 'lib', 'lib64']:
        source = pathlib.Path('/') / name
        if not source.exists():
            continue
        target = directory / name
        target.mkdir()
        mount(str(source.resolve()), target, flags=4096)
        mount(None, target, flags=4096 | 32 | 1 | 2 | 4)
    for name in ['proc', 'dev', 'tmp', 'run', 'home', 'etc', 'workspace']:
        (directory / name).mkdir()
    mount('proc', directory / 'proc', 'proc', 2 | 4 | 8)
    for name in ['null', 'zero', 'urandom']:
        target = directory / 'dev' / name
        target.touch()
        mount('/dev/' + name, target, flags=4096)
    for name in ['tmp', 'run', 'home', 'workspace']:
        os.chmod(directory / name, 0o700)
        os.chown(directory / name, uid, uid)
    (directory / 'etc/passwd').write_text(f'root:x:0:0:root:/root:/bin/false\nsession:x:{uid}:{uid}:session:/home:/bin/sh\n')
    os.chroot(directory)
    os.chdir('/workspace')


def run_session(directory, runtime_directory_fd, entry):
    if os.geteuid() != 0 or os.uname().machine != 'x86_64':
        raise RuntimeError('Selected guest-root/x86_64 is required')
    if runtime_directory_fd < 3:
        raise RuntimeError('Runtime directory cannot replace session stdio')
    # Root keeps exactly stdio and the trusted runtime directory. In particular,
    # an inherited stdin writer would prevent natural EOF and owned teardown.
    if runtime_directory_fd != 3:
        os.dup2(runtime_directory_fd, 3, inheritable=False)
    else:
        os.set_inheritable(3, False)
    checked(LIBC.syscall(436, ctypes.c_uint(4), ctypes.c_uint(0xffffffff), ctypes.c_uint(0)))
    runtime_directory_fd = 3
    # Allocate in this controller; callers cannot accidentally launch concurrent
    # sessions under one lease/UID. The kernel releases it at controller exit.
    lease = acquire_uid(runtime_directory_fd)
    uid = lease.uid
    # Creator stays guest root; namespace ownership is not delegated to the UID.
    checked(LIBC.unshare(NAMESPACES))
    parent_handle = os.pidfd_open(os.getpid())
    init = os.fork()
    if init == 0:
        # No exception in either fork may unwind into the root caller frame.
        # The PID namespace dies on init exit; the controller keeps its UID lease
        # until waitpid confirms that exit. Callback failures use EX_SOFTWARE.
        try:
            checked(LIBC.prctl(1, signal.SIGKILL, 0, 0, 0))
            # getppid() is zero across this PID-namespace boundary. A retained
            # pidfd closes the parent-death race without a reusable/outside PID.
            if select.select([parent_handle], [], [], 0)[0]:
                os._exit(97)
            os.close(parent_handle)
            install_root(directory, uid)
            child = os.fork()
            if child == 0:
                drop_privileges(uid)
                os.environ.clear()
                os.environ.update({'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home', 'TERM': 'xterm'})
                close_session_fds()
                restrict_syscalls()
                entry(uid)
                os._exit(0)
            os.close(0)
            while True:
                pid, status = os.waitpid(-1, 0)
                if pid == child:
                    os._exit(os.waitstatus_to_exitcode(status) & 255)
        finally:
            os._exit(70)
    os.close(parent_handle)
    handle = os.pidfd_open(init)
    def stop(_signal, _frame):
        signal.pidfd_send_signal(handle, signal.SIGKILL)
    signal.signal(signal.SIGTERM, stop)
    _, status = os.waitpid(init, 0)
    os.close(handle)
    os._exit(os.waitstatus_to_exitcode(status) & 255)
