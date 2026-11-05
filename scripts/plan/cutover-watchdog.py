#!/usr/bin/env python3
# MODULE: cutover-watchdog.py - Epic 107 Linux pidfd watchdog restores fenced paths before releasing writers
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import tempfile
import time
import uuid


def ticks(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def atomic(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".migration-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def restore(path, *, interrupted):
    if not path.exists():
        return
    data = json.loads(path.read_text())
    if not data.get("fenced"):
        return
    errors = []
    for entry in data.get("fence", []):
        try:
            stat = os.lstat(entry["path"])
            if str(stat.st_dev) != entry["device"] or str(stat.st_ino) != entry["inode"]:
                raise RuntimeError("inode changed")
            os.chmod(entry["path"], entry["mode"], follow_symlinks=False)
        except (OSError, ValueError, RuntimeError) as exc:
            errors.append({"path": entry["path"], "error": str(exc)})
    data["restore_errors"] = errors
    if errors:
        data["phase"] = "recovery-required"
    else:
        data["fenced"] = False
        data["interrupted_after"] = data["phase"] if interrupted else None
        data["phase"] = "interrupted" if interrupted else "restored"
    atomic(path, data)
    if errors:
        raise RuntimeError("permission restoration incomplete; writers must remain blocked")


def require_ended_owner(path):
    """A dead watchdog does not prove that its migration lead stopped writing."""
    if not path.exists():
        return
    data = json.loads(path.read_text())
    if not data.get("fenced"):
        return
    try:
        owner = data["owner"]
        fd = os.pidfd_open(int(owner["pid"]))
        try:
            same = ticks(int(owner["pid"])) == owner["start_ticks"]
            if same and not select.select([fd], [], [], 0)[0]:
                raise RuntimeError("RECOVERY_OWNER_ALIVE: preserve the fence until its migration owner ends")
        finally:
            os.close(fd)
    except (FileNotFoundError, ProcessLookupError):
        return
    except (KeyError, TypeError, ValueError, PermissionError) as exc:
        raise RuntimeError("RECOVERY_OWNER_UNCONFIRMED: cannot prove the old migration owner ended") from exc


def main():
    journal, lock = Path(sys.argv[1]), Path(sys.argv[2])
    parent, expected = int(sys.argv[3]), sys.argv[4]
    pidfd = os.pidfd_open(parent)
    if ticks(parent) != expected:
        raise RuntimeError("migration process identity changed")
    nonce, acquired, recovery_allowed = uuid.uuid4().hex, False, False
    guard = open(str(journal) + ".guard", "a+")
    try:
        until = time.monotonic() + 60
        while not acquired:
            if select.select([pidfd], [], [], 0)[0]:
                return
            try:
                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w") as stream:
                    json.dump({"pid": os.getpid(), "nonce": nonce, "start_ticks": ticks(os.getpid())}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                acquired = True
            except FileExistsError:
                # Stale-lock reclamation is serialized and checks the exact observed holder before removing it.
                fcntl.flock(guard, fcntl.LOCK_EX)
                try:
                    before = lock.read_text()
                    holder = json.loads(before)
                    try:
                        observed = ticks(int(holder["pid"]))
                        dead = holder.get("start_ticks") is not None and observed != holder["start_ticks"]
                    except FileNotFoundError:
                        dead = True
                    if dead and lock.read_text() == before:
                        require_ended_owner(journal)
                        restore(journal, interrupted=True)
                        lock.unlink()
                except (FileNotFoundError, KeyError, ValueError):
                    pass
                finally:
                    fcntl.flock(guard, fcntl.LOCK_UN)
                if time.monotonic() >= until:
                    raise RuntimeError("MIGRATION_LOCKED: writer handover lock remained held for60s")
                time.sleep(0.05)
        fcntl.flock(guard, fcntl.LOCK_EX)
        # A previous interruption must be recovered before this lead can arm a new window.
        require_ended_owner(journal)
        recovery_allowed = True
        restore(journal, interrupted=True)
        print(json.dumps({"event": "LOCKED", "pid": os.getpid(), "start_ticks": ticks(os.getpid()), "nonce": nonce}), flush=True)
        interrupted = True
        while True:
            ready = select.select([pidfd, sys.stdin], [], [])[0]
            if pidfd in ready:
                break
            command = sys.stdin.readline()
            if not command:
                break
            if command.strip() == "arm":
                data = json.loads(journal.read_text())
                if data.get("watchdog_nonce") != nonce:
                    raise RuntimeError("journal belongs to another watchdog")
                for entry in data["fence"]:
                    stat = os.lstat(entry["path"])
                    if str(stat.st_dev) != entry["device"] or str(stat.st_ino) != entry["inode"]:
                        raise RuntimeError("input identity changed before fencing")
                print(json.dumps({"event": "ARMED"}), flush=True)
            elif command.strip() == "release":
                current = json.loads(journal.read_text()) if journal.exists() else {}
                interrupted = current.get("phase") != "ref-committed"
                break
            else:
                raise RuntimeError("unknown watchdog control command")
        restore(journal, interrupted=interrupted)
    finally:
        if acquired:
            try:
                # Also runs for a failure after READY; never expose unrestored modes to the next writer.
                if recovery_allowed:
                    restore(journal, interrupted=True)
            finally:
                if lock.exists() and json.loads(lock.read_text()).get("nonce") == nonce:
                    lock.unlink()
        fcntl.flock(guard, fcntl.LOCK_UN)
        guard.close()
        os.close(pidfd)


if __name__ == "__main__":
    main()
