// Native equivalents of the POSIX control socket lifecycle obligations.
// Root ownership precedes every child; ACL proof uses actual protected storage.
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ControlAuth } from './control-auth'
import { ControlServer, MemoryReceiptStore, CONTROL_PIPE_PATTERN, isUserOnlyPipeDacl, resolveControlEndpoint, type ControlHandlers } from './control-server'
import { ensurePrivateDirectories } from './private-directory'

const native = process.platform === 'win32'
const roots: string[] = [], servers: ControlServer[] = [], children: ChildProcess[] = []
const requireHere = createRequire(import.meta.url)
const desktopPackage = requireHere.resolve('../../package.json')
const requireApp = createRequire(desktopPackage)
const esbuild = createRequire(requireApp.resolve('vite/package.json'))('esbuild')
type PipeReadback = { user: string; dacl: string; verifiedCurrentUserOnly: boolean }
const addon = native ? requireApp('node-pty') as { protectApplicationLifetime(): void; restrictControlPipe(name: string): PipeReadback } : undefined
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
const waitExit = async (child: ChildProcess) => {
  if (exited(child)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned synthetic control server did not exit')), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
afterEach(async () => {
  const failures: unknown[] = []
  const stopped = await Promise.allSettled(children.map(async child => { if (!exited(child)) child.kill(); await waitExit(child) }))
  for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason)
  const closed = await Promise.allSettled(servers.map(server => server.close()))
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
  // An unknown family retains its private coordinates until the owning worker
  // exits and its already-established native lifetime job closes.
  if (failures.length) throw new Error('Owned native control resources did not all close')
  children.length = 0; servers.length = 0
  const removed = await Promise.allSettled(roots.map(root => rm(root, { recursive: true, force: true })))
  for (const result of removed) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length) throw new Error('Owned native control fixture cleanup is incomplete')
  roots.length = 0
})
async function fixture() {
  if (!addon || typeof addon.protectApplicationLifetime !== 'function') throw new Error('Native lifetime ownership is unavailable')
  addon.protectApplicationLifetime() // Guarded assignment and noninherited kill-on-close handle before any subprocess.
  const root = await mkdtemp(join(tmpdir(), 'bmn-control-native-')); roots.push(root)
  const directory = join(root, 'control'), socketPath = join(directory, 'control.sock')
  // Production callers provision private roots; mode bits alone cannot do so.
  ensurePrivateDirectories([directory])
  let pipeReadback: PipeReadback | undefined, restrictionCalls = 0
  const auth = new ControlAuth(), server = new ControlServer({ socketPath, auth,
    handlers: {} as ControlHandlers, receipts: new MemoryReceiptStore(), restrictPipe: async name => {
      restrictionCalls++; pipeReadback = addon.restrictControlPipe(name); return pipeReadback
    } })
  servers.push(server)
  return { root, directory, socketPath, auth, server, pipeReadback: () => pipeReadback, restrictionCalls: () => restrictionCalls }
}
function assertPrivateAcl(directory: string) {
  // Read back with the actual guard: protected root, trusted effective owner,
  // owner full access, directory inheritance and every descendant's DACL.
  // Existing ACLs are inspected, never repaired by this operation.
  ensurePrivateDirectories([directory])
}
async function connectResult(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(endpoint), timer = setTimeout(() => { connection.destroy(); reject(new Error('Native pipe probe did not settle')) }, 1000)
    connection.once('connect', () => { clearTimeout(timer); connection.destroy(); resolve(true) })
    connection.once('error', error => {
      clearTimeout(timer); connection.destroy()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}
async function authenticate(endpoint: string, auth: ControlAuth) {
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(endpoint), timer = setTimeout(() => { connection.destroy(); reject(new Error('Synthetic authentication timed out')) }, 2000)
    let buffer = ''
    const fail = (error: Error) => { clearTimeout(timer); connection.destroy(); reject(error) }
    connection.once('error', fail)
    connection.once('connect', () => connection.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: auth.ownerToken } }) + '\n'))
    connection.on('data', bytes => {
      buffer += bytes.toString(); if (!buffer.includes('\n')) return
      try { expect(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))).result).toEqual({ scope: 'owner' }); clearTimeout(timer); connection.destroy(); resolve() }
      catch (error) { fail(error as Error) }
    })
  })
}

it.runIf(native)('verifies caller-owned control directory and endpoint ACLs, native pipe DACL and disappearance after close', async () => {
  const f = await fixture(); await f.server.listen()
  const endpoint = (await readFile(f.socketPath, 'utf8')).trim()
  expect(endpoint).toMatch(CONTROL_PIPE_PATTERN); expect(f.server.endpoint).toBe(endpoint)
  expect((await lstat(f.socketPath)).isFile()).toBe(true); expect((await lstat(f.socketPath)).nlink).toBe(1)
  assertPrivateAcl(f.directory)
  expect(f.restrictionCalls()).toBe(1)
  expect(isUserOnlyPipeDacl(f.pipeReadback()!)).toBe(true)
  await authenticate(endpoint, f.auth)
  await f.server.close()
  await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await connectResult(endpoint)).toBe(false)
}, 30000)

it.runIf(native)('keeps an endpoint file that names another server when it closes', async () => {
  const f = await fixture(); await f.server.listen()
  const ours = f.server.endpoint!
  // Another BMN server has since published its own pipe in the same endpoint file.
  const theirs = `\\\\.\\pipe\\bmn-control-${'0123456789abcdef'.repeat(2)}`
  await writeFile(`${f.socketPath}.other.tmp`, `${theirs}\n`, { mode: 0o600 }); await rename(`${f.socketPath}.other.tmp`, f.socketPath)
  expect(await resolveControlEndpoint(f.socketPath)).toBe(theirs)
  await f.server.close()
  expect(await resolveControlEndpoint(f.socketPath)).toBe(theirs)
  expect(await connectResult(ours)).toBe(false)
}, 30000)

it.runIf(native)('replaces the actual endpoint left by a crashed ControlServer and refuses takeover while that server is live', async () => {
  const f = await fixture(), controller = join(f.root, 'controller')
  ensurePrivateDirectories([controller])
  const childBundle = join(controller, 'server.cjs')
  const source = `const {createRequire}=require('node:module');const {ControlServer,MemoryReceiptStore}=require(${JSON.stringify(join(dirname(desktopPackage), 'src/utility/control-server.ts'))});const {ControlAuth}=require(${JSON.stringify(join(dirname(desktopPackage), 'src/utility/control-auth.ts'))});const addon=createRequire(${JSON.stringify(desktopPackage)})('node-pty');const server=new ControlServer({socketPath:${JSON.stringify(f.socketPath)},auth:new ControlAuth(),handlers:{},receipts:new MemoryReceiptStore(),restrictPipe:async name=>addon.restrictControlPipe(name)});server.listen().then(()=>process.send({ready:true,endpoint:server.endpoint})).catch(()=>process.exit(2));process.on('message',value=>{if(value&&value.type==='crash')process.kill(process.pid,'SIGKILL')});`
  await esbuild.build({ stdin: { contents: source, resolveDir: dirname(desktopPackage) }, outfile: childBundle,
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['node-pty'] })
  const child = spawn(process.execPath, [childBundle], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }); children.push(child)
  const oldEndpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Actual child control server did not become ready')), 15000)
    child.once('message', value => {
      clearTimeout(timer)
      try { const frame = value as { ready: boolean; endpoint: string }; expect(frame.ready).toBe(true); expect(frame.endpoint).toMatch(CONTROL_PIPE_PATTERN); resolve(frame.endpoint) }
      catch (error) { reject(error) }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Actual child control server exited before readiness')) })
  })
  const oldBytes = await readFile(f.socketPath)
  await expect(f.server.listen()).rejects.toThrow(/already in use/); expect(await readFile(f.socketPath)).toEqual(oldBytes)
  expect(await connectResult(oldEndpoint)).toBe(true)
  const stopped = waitExit(child); child.send({ type: 'crash' }); await stopped
  expect(await connectResult(oldEndpoint)).toBe(false); expect(await readFile(f.socketPath)).toEqual(oldBytes)
  await f.server.listen()
  const fresh = (await readFile(f.socketPath, 'utf8')).trim()
  expect(fresh).toBe(f.server.endpoint); expect(fresh).not.toBe(oldEndpoint)
  assertPrivateAcl(f.directory); await authenticate(fresh, f.auth)
}, 30000)
