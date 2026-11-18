#!/usr/bin/env python3
"""MODULE: brain-vault-writers.py - Read-only, fail-closed drain check for vault file handles/maps."""
import json
import errno
import fcntl
import signal
import stat
import subprocess
import os
from pathlib import Path
import sys


def lease_proof(root):
    """Exclusive leases count hidden FDs/mappings in the kernel; never retain a lease."""
    kind = subprocess.check_output(['/usr/bin/stat', '-f', '-c', '%t', root], text=True).strip().lower()
    if kind not in {'ef53', '58465342', '9123683e', '1021994'}:
        raise RuntimeError('Vault filesystem does not support the verified writer barrier')
    device = os.stat(root).st_dev
    identities = []
    busy = []
    signal.signal(signal.SIGIO, lambda *_: None)
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
    for directory, names, files in os.walk(root, followlinks=False):
        if directory == root:
            names[:] = [name for name in names if name not in ('files', '.git')]
        for name in sorted(names + files):
            path = os.path.join(directory, name)
            if directory == root and name in ('files', '.git'):
                continue
            entry = os.lstat(path)
            if stat.S_ISLNK(entry.st_mode):
                continue
            if entry.st_dev != device:
                raise RuntimeError('Vault crosses filesystem boundaries')
            if stat.S_ISDIR(entry.st_mode):
                continue
            if not stat.S_ISREG(entry.st_mode):
                raise RuntimeError('Vault contains a non-regular note entry')
            fd = os.open(path, flags)
            try:
                seen = os.fstat(fd)
                if (seen.st_dev, seen.st_ino) != (entry.st_dev, entry.st_ino):
                    raise RuntimeError('Vault inode changed during writer proof')
                try:
                    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                except OSError as error:
                    if error.errno == errno.EAGAIN:
                        busy.append(os.path.relpath(path, root))
                        continue
                    raise RuntimeError('Exclusive vault writer proof is unavailable') from error
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                # Positive control before another lease: an extra open must prevent it.
                other = os.open(path, flags)
                try:
                    try:
                        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                    except OSError as error:
                        if error.errno != errno.EAGAIN:
                            raise
                    else:
                        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                        raise RuntimeError('Filesystem did not enforce the lease control')
                finally:
                    os.close(other)
                identities.append({'path': os.path.relpath(path, root), 'dev': seen.st_dev, 'ino': seen.st_ino, 'mode': stat.S_IMODE(seen.st_mode)})
            finally:
                os.close(fd)
    return {'proved': not busy, 'busy': busy, 'identities': sorted(identities, key=lambda item: item['path'])}


def check(root):
    root = os.path.realpath(root)
    def protected(path):
        path = path.removesuffix(' (deleted)')
        return path.startswith(root + '/') and not any(path == root + '/' + part or path.startswith(root + '/' + part + '/') for part in ('files', '.git'))
    blockers = []
    unknown = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue  # Only this UID can write the private notes.
            for descriptor in (proc / 'fd').iterdir():
                try:
                    if not protected(os.readlink(descriptor)):
                        continue
                    info = (proc / 'fdinfo' / descriptor.name).read_text()
                    flags = int(next(line.split()[1] for line in info.splitlines() if line.startswith('flags:')), 8)
                    if flags & os.O_ACCMODE in (os.O_WRONLY, os.O_RDWR):
                        blockers.append({'pid': int(proc.name), 'kind': 'descriptor'})
                except FileNotFoundError:
                    continue
            for line in (proc / 'maps').read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and 'w' in fields[1] and protected(fields[5]):
                    blockers.append({'pid': int(proc.name), 'kind': 'mapping'})
        except (ProcessLookupError, FileNotFoundError):
            continue
        except (PermissionError, ValueError, StopIteration):
            unknown.append(int(proc.name))
    lease = lease_proof(root)
    return {'blockers': blockers + [{'kind': 'lease', 'path': path} for path in lease['busy']], 'unknown': [] if lease['proved'] else unknown, 'uninspected': unknown, 'lease': lease}


def close_obsidian():
    """Graceful SIGTERM only to verified Obsidian main executables, through pidfds."""
    candidates = {}
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            executable = os.readlink(proc / 'exe').removesuffix(' (deleted)')
            if Path(executable).name.lower() != 'obsidian':
                continue
            fields = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
            candidates[int(proc.name)] = {'parent': int(fields[1]), 'ticks': fields[19], 'executable': executable}
        except (OSError, ValueError, IndexError):
            continue
    closed = []
    for pid, identity in candidates.items():
        if identity['parent'] in candidates:
            continue
        descriptor = os.pidfd_open(pid)
        try:
            current = Path('/proc/%d/stat' % pid).read_text().rsplit(') ', 1)[1].split()[19]
            if current != identity['ticks'] or os.readlink('/proc/%d/exe' % pid) != identity['executable']:
                raise RuntimeError('Obsidian process identity changed; no signal sent')
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            import select
            if not select.select([descriptor], [], [], 30)[0]:
                raise RuntimeError('Obsidian did not close gracefully; no force-kill attempted')
            closed.append(pid)
        except ProcessLookupError:
            pass
        finally:
            os.close(descriptor)
    return {'closed': closed}


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--close-obsidian':
        print(json.dumps(close_obsidian()))
        sys.exit(0)
    if len(sys.argv) != 2:
        sys.exit('Expected one vault path for a read-only writer check')
    print(json.dumps(check(sys.argv[1])))
