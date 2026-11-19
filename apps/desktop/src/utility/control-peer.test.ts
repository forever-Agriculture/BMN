// MODULE: control-peer.test.ts - reading a connection's peer leaves the connection readable for its next request
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlPeer } from './control-peer'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'linux')('controlPeer', () => {
  it('names the caller and still reads the next request on the same connection', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bmn-control-peer-'))
    folders.push(folder)
    const path = join(folder, 'control.sock')
    const peers: Array<{ pid: number; start: string } | undefined> = []
    const server = createServer((socket: Socket) => {
      let buffer = ''
      socket.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          void controlPeer(socket).then((peer) => { peers.push(peer); socket.write(`${line} answered\n`) })
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    try {
      const answers = await new Promise<string>((resolve, reject) => {
        const client = createConnection(path)
        let received = ''
        const timer = setTimeout(() => { client.destroy(); reject(new Error(`only received ${JSON.stringify(received)}`)) }, 5_000)
        client.setEncoding('utf8').on('data', (chunk: string) => {
          received += chunk
          if (received === 'first answered\n') client.write('second\n')
          if (received.includes('second answered\n')) { clearTimeout(timer); client.end(); resolve(received) }
        })
        client.write('first\n')
      })
      expect(answers).toBe('first answered\nsecond answered\n')
      expect(peers).toHaveLength(2)
      expect(peers[0]?.pid).toBe(process.pid)
      expect(peers[1]?.pid).toBe(process.pid)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
