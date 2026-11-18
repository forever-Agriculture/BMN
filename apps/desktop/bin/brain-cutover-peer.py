#!/usr/bin/env python3
"""MODULE: brain-cutover-peer.py - Kernel-attested peers and one serialized final decision.

Only the inherited parent pipe can request the decision. Files and client payloads
cannot create it. Parent loss closes the broker, never starting or resuming work.
"""
import json
import uuid
import fcntl
import os
from pathlib import Path
import socket
import struct
import select
import time
import sys
import threading


def ticks(pid):
    return Path('/proc/%d/stat' % pid).read_text().rsplit(') ', 1)[1].split()[19]


def broker(path):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(4)
    lock = threading.RLock()
    replies, connections, decisions = {}, {}, {}
    sequence, decided = 0, False

    def emit(value):
        with lock:
            print(json.dumps(value), flush=True)

    def observable_loss(info):
        # One kernel poll samples peer exit and socket close/half-close together.
        # Unexpected pipelined input while awaiting run's answer is held too.
        poller = select.poll()
        poller.register(info['pidfd'], select.POLLIN | select.POLLERR | select.POLLHUP)
        poller.register(info['socket'], select.POLLIN | select.POLLERR | select.POLLHUP | select.POLLRDHUP)
        return bool(poller.poll(0))

    def decide(value):
        nonlocal decided
        decision_id = value.get('decisionId')
        encoded = json.dumps(value, sort_keys=True)
        prior = decisions.get(decision_id)
        if prior is not None:
            return prior['result'] if prior['request'] == encoded else {'decisionId': decision_id, 'accepted': False, 'error': 'Decision identity changed'}
        result = {'decisionId': decision_id, 'payloadHash': value.get('payloadHash'), 'accepted': False}
        try:
            peer, payload_hash = value['peer'], value['payloadHash']
            info = connections.get(peer['connection'])
            if not isinstance(decision_id, str) or not 1 <= len(decision_id) <= 128 or not isinstance(payload_hash, str) or len(payload_hash) != 64 or any(c not in '0123456789abcdef' for c in payload_hash):
                raise ValueError('Invalid final decision')
            if decided or info is None or info['dead']:
                raise ValueError('No unused live brain connection')
            if any(peer.get(key) != info['identity'][key] for key in ('pid', 'uid', 'ticks', 'connection')):
                raise ValueError('Brain peer identity changed')
            pending = replies.get(info.get('request'))
            if pending is None or info['payload'].get('command') != 'run' or info['payload'].get('invocation') != peer.get('invocation'):
                raise ValueError('No matching pending brain run')
            if observable_loss(info) or ticks(peer['pid']) != peer['ticks']:
                raise ValueError('Brain peer exited or disconnected before the decision')
            # This is the authority point. Later peer loss cannot undo this decision.
            decided = True
            info['decided'] = True
            result['accepted'] = True
        except (OSError, ValueError, KeyError, TypeError) as error:
            result['error'] = str(error)
        decisions[decision_id] = {'request': encoded, 'result': result}
        return result

    def reply_reader():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                with lock:
                    if value.get('command') == 'commit-decision':
                        emit({'decision': decide(value)})
                        continue
                    waiting = replies.pop(value['id'], None)
                    if waiting:
                        waiting['value'] = value
                        waiting['event'].set()
            except (ValueError, KeyError, TypeError):
                os._exit(1)
        os._exit(0)

    def client(connection):
        nonlocal sequence
        pidfd, info = None, None
        try:
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                return
            identity = {'pid': pid, 'uid': uid, 'ticks': ticks(pid), 'connection': uuid.uuid4().hex}
            pidfd = os.pidfd_open(pid)
            if ticks(pid) != identity['ticks']:
                return
            info = {'identity': identity, 'socket': connection, 'pidfd': pidfd, 'dead': False, 'decided': False}
            with lock:
                connections[identity['connection']] = info
            stream = connection.makefile('rwb', buffering=0)
            while True:
                line = stream.readline(2 * 1024 * 1024 + 1)
                if not line or len(line) > 2 * 1024 * 1024 or not line.endswith(b'\n'):
                    break
                payload = json.loads(line)
                if ticks(pid) != identity['ticks']:
                    break
                waiting = {'event': threading.Event()}
                with lock:
                    sequence += 1
                    request_id = sequence
                    replies[request_id] = waiting
                    info.update(request=request_id, payload=payload)
                    emit({'id': request_id, 'peer': identity, 'payload': payload})
                deadline = time.monotonic() + 1800
                while not waiting['event'].wait(0.25):
                    if time.monotonic() >= deadline or observable_loss(info):
                        with lock:
                            info['dead'] = True
                            emit({'gone': identity})
                        return
                stream.write((json.dumps(waiting['value']) + '\n').encode())
        except (OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            with lock:
                if info is not None:
                    info['dead'] = True
                    connections.pop(info['identity']['connection'], None)
                    replies.pop(info.get('request'), None)
                    emit({'gone': info['identity']})
                if pidfd is not None:
                    os.close(pidfd)
                connection.close()

    threading.Thread(target=reply_reader, daemon=True).start()
    emit({'ready': path})
    try:
        while True:
            connection, _ = server.accept()
            threading.Thread(target=client, args=(connection,), daemon=True).start()
    finally:
        server.close()
        Path(path).unlink(missing_ok=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'lock':
        descriptor = os.open(sys.argv[2], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print('LOCKED', flush=True)
            sys.stdin.buffer.read()
        finally:
            os.close(descriptor)
        sys.exit(0)
    if len(sys.argv) != 3 or sys.argv[1] != 'broker':
        sys.exit('This is BMN main’s peer-credential broker, not a cutover command')
    broker(sys.argv[2])
