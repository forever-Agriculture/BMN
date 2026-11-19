// MODULE: control-peer.ts - read the actual process behind a local control connection from Linux
import { spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import type { ForegroundCaller } from './foreground-process'

const PEER_CREDENTIAL = `import os, socket, struct
s = socket.socket(fileno=3)
pid, uid, _ = struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
if uid == os.getuid() and pid > 1:
    with open(f'/proc/{pid}/stat') as status:
        fields = status.read().rsplit(')', 1)[1].split()
    print(pid, fields[19])
`

/** No process id in a request can substitute for the identity on the accepted socket. */
export async function controlPeer(socket: Socket | undefined): Promise<ForegroundCaller | undefined> {
  if (process.platform !== 'linux' || !socket || socket.destroyed) return undefined
  return new Promise(resolve => {
    try {
      const probe = spawn('/usr/bin/python3', ['-I', '-S', '-c', PEER_CREDENTIAL], {
        stdio: ['ignore', 'pipe', 'ignore', socket], timeout: 500
      })
      let output = ''
      probe.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
      probe.once('error', () => resolve(undefined))
      probe.once('close', code => {
        const match = code === 0 ? /^(\d+) (\d+)$/u.exec(output.trim()) : null
        resolve(match === null ? undefined : { pid: Number(match[1]), start: match[2]! })
      })
    } catch { resolve(undefined) }
  })
}
