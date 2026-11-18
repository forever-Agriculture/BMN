"""MODULE: brain-broker.test.py - Actual kernel close/exit and one-use decision checks, no user manager."""
import array
import json
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

PEER = Path(__file__).resolve().parents[2] / 'apps/desktop/bin/brain-cutover-peer.py'


class BrokerDecision(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix='bmn-brain-broker-')
        self.path = str(Path(self.root.name) / 'peer.sock')
        self.process = subprocess.Popen([sys.executable, '-I', str(PEER), 'broker', self.path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.events = queue.Queue()
        def reader():
            for line in self.process.stdout:
                self.events.put(json.loads(line))
            self.events.put({'closed': True})
        threading.Thread(target=reader, daemon=True).start()
        self.assertEqual(self.events.get(timeout=5), {'ready': self.path})
        self.sockets = []

    def tearDown(self):
        for stream in self.sockets:
            stream.close()
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.assertEqual(self.process.returncode, 0, self.process.stderr.read())
        self.process.stdout.close()
        self.process.stderr.close()
        self.root.cleanup()

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()

    def event(self, key):
        while True:
            value = self.events.get(timeout=5)
            self.assertNotIn('closed', value)
            if key in value:
                return value

    def connect(self):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(self.path)
        self.sockets.append(connection)
        connection.sendall((json.dumps({'command': 'run', 'invocation': 'a' * 32}) + '\n').encode())
        return connection, self.event('peer')

    def decision(self, request, identifier='first', payload_hash='b' * 64, **changes):
        peer = {**request['peer'], 'invocation': 'a' * 32, **changes}
        self.send({'command': 'commit-decision', 'decisionId': identifier, 'peer': peer, 'payloadHash': payload_hash})
        return self.event('decision')['decision']

    def test_live_peer_has_one_decision_bound_to_exact_bytes(self):
        _, request = self.connect()
        self.assertTrue(self.decision(request)['accepted'])
        self.assertTrue(self.decision(request)['accepted'])  # Same decision's lost-ack replay.
        self.assertFalse(self.decision(request, identifier='another')['accepted'])
        self.assertFalse(self.decision(request, payload_hash='c' * 64)['accepted'])

    def test_half_close_before_decision_is_refused_without_waiting_for_the_monitor(self):
        connection, request = self.connect()
        connection.shutdown(socket.SHUT_WR)
        self.assertFalse(self.decision(request)['accepted'])

    def test_loss_after_decision_does_not_revoke_the_accepted_decision(self):
        connection, request = self.connect()
        result = self.decision(request)
        self.assertTrue(result['accepted'])
        connection.shutdown(socket.SHUT_WR)
        self.assertEqual(self.decision(request), result)

    def test_wrong_peer_or_invocation_does_not_consume_the_live_decision(self):
        _, request = self.connect()
        self.assertFalse(self.decision(request, identifier='wrong-ticks', ticks='0')['accepted'])
        self.assertFalse(self.decision(request, identifier='wrong-invocation', invocation='c' * 32)['accepted'])
        self.assertTrue(self.decision(request)['accepted'])

    def test_exited_peer_is_refused_even_when_another_process_keeps_its_socket_open(self):
        parent, child = socket.socketpair()
        self.sockets.append(parent)
        code = '''import array,json,os,socket,sys
transfer=socket.socket(fileno=int(sys.argv[2]))
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.connect(sys.argv[1])
connection.sendall((json.dumps({'command':'run','invocation':'a'*32})+'\\n').encode())
transfer.sendmsg([b'fd'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[connection.fileno()]))])
sys.stdin.buffer.read()
os._exit(0)
'''
        process = subprocess.Popen([sys.executable, '-I', '-c', code, self.path, str(child.fileno())], pass_fds=(child.fileno(),), stdin=subprocess.PIPE)
        child.close()
        try:
            _, ancillary, _, _ = parent.recvmsg(16, socket.CMSG_SPACE(array.array('i').itemsize))
            descriptors = array.array('i')
            descriptors.frombytes(ancillary[0][2][:descriptors.itemsize])
            duplicate = socket.socket(fileno=descriptors[0])
            self.sockets.append(duplicate)
            request = self.event('peer')
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertFalse(self.decision(request)['accepted'])
        finally:
            if process.poll() is None:
                process.stdin.close()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
