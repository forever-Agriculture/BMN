#!/usr/bin/env python3
"""MODULE: brain-cutover-service.py - No agents or stored consent; request work from live BMN.

This process never mutates the vault, rules or database. Only the main process can
accept it and run the journal. A counterfeit socket response therefore grants no power.
"""
import json
import os
from pathlib import Path
import socket
import sys


def run(locator):
    value = json.loads(Path(locator).read_text())
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(1800)
    connection.connect(value['socket'])
    stream = connection.makefile('rwb', buffering=0)
    invocation = os.environ.get('INVOCATION_ID', '')  # Asserted, then checked against the user manager by BMN.
    for command in ('begin', 'run'):
        stream.write((json.dumps({'command': command, 'invocation': invocation}) + '\n').encode())
        response = json.loads(stream.readline(1024 * 1024))
        if 'error' in response:
            raise RuntimeError(response['error'])
    connection.close()
    print('BMN brain cutover checks completed')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Only the owner’s confirmed BMN palette action can start the brain switch')
        run(sys.argv[1])
    except Exception as error:
        print('Brain switch did not report success: %s. Reopen BMN to check its current state.' % error, file=sys.stderr)
        sys.exit(1)
