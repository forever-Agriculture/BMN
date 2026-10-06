// Native plugin routing is exercised with synthetic Bun processes, never provider credentials.
import { execFile } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
let javascript: string
beforeAll(async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'hooks', 'print', 'opencode'])
  javascript = stripTypeScriptTypes(stdout).replace('export const BMNPlugin', 'const BMNPlugin')
})
afterEach(() => vi.useRealTimers())

const sessionID = 'ses_0123456789abSyntheticTest0'
const event = (type: string, properties: Record<string, unknown> = {}) => ({ event: { type, properties } })
function completed(stdout = '', exitCode = 0) {
  return {
    stdin: { write: vi.fn(), end: vi.fn(async () => undefined) },
    stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(stdout)); controller.close() } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: Promise.resolve(exitCode), kill: vi.fn()
  }
}
function stalled(flood?: 'stdout' | 'stderr') {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  let exit!: (code: number) => void
  const exited = new Promise<number>(resolve => { exit = resolve })
  const stream = (name: 'stdout' | 'stderr') => new ReadableStream<Uint8Array>({ start(controller) {
    controllers.push(controller)
    if (flood === name) controller.enqueue(Buffer.alloc(1024 * 1024 + 1))
  } })
  const child = { stdin: { write: vi.fn(), end: vi.fn(async () => undefined) },
    stdout: stream('stdout'), stderr: stream('stderr'), exited,
    kill: vi.fn(() => { for (const controller of controllers) controller.close(); exit(137) }) }
  return child
}
type SpawnOptions = { env: Record<string, string>; stdin: string; stdout: string; stderr: string; windowsHide: boolean }
async function fixture(spawn: (argv: string[], options: SpawnOptions) => ReturnType<typeof completed>, platform = 'win32') {
  const timers: number[] = []
  const shell = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (platform === 'win32') throw new Error('Native branch must not invoke a shell')
    const text = strings.join('')
    const argv = text.includes('answer take')
      ? ['bmn', 'answer', 'take', '--wait', text.includes('--reported') ? '0' : '25', ...(text.includes('--reported') ? ['--reported', String(values[0])] : []), '--json']
      : ['bmn', 'hook', 'opencode']
    const command = { env: () => command, quiet: () => command, nothrow: async () => {
      const child = spawn(argv, { env: {}, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
      return { exitCode: await child.exited, stdout: Buffer.from(await new Response(child.stdout).arrayBuffer()) }
    } }
    return command
  })
  const spawnCall = vi.fn(spawn)
  const env = { BMN_CONTROL_SOCKET: 'synthetic-endpoint', BMN_TOKEN: 'synthetic-token' }
  const create = runInNewContext(`${javascript}; BMNPlugin`, {
    process: { platform, env }, Bun: { spawn: spawnCall }, Buffer, ReadableStream, Response,
    URL, Request, Headers, AbortController, clearTimeout,
    setTimeout: (callback: () => void, milliseconds: number) => { timers.push(milliseconds); return setTimeout(callback, milliseconds) }
  })
  const posts: Request[] = []
  let clientHeaders: Record<string, string> | Headers | undefined
  let reply: (request: Request) => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 })
  const plugin = await create({ $: shell, serverUrl: new URL('http://127.0.0.1:4096/'), directory: '/synthetic',
    client: { _client: { getConfig: () => ({ headers: clientHeaders, fetch: async (request: Request) => { posts.push(request); return reply(request) } }) } } })
  return { plugin, spawn: spawnCall, shell, env, posts, timers, setReply: (next: typeof reply) => { reply = next }, setClientHeaders: (headers: typeof clientHeaders) => { clientHeaders = headers } }
}
async function turns(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve()
  expect(check()).toBe(true)
}

describe('native OpenCode plugin deadlines', () => {
  it('passes literal exe argv, raw JSON stdin and the pinned session environment without a shell', async () => {
    const child = completed()
    const f = await fixture(() => child)
    const properties = { sessionID, data: "Unicode Київ, quotes ' \" %, ^, &, trailing \\ and\nnewlines" }
    await f.plugin.event(event('session.created', properties))
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(['bmn.exe', 'hook', 'opencode'], {
      env: { ...f.env, BMN_OPENCODE_SESSION_ID: sessionID }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true
    })
    expect(child.stdin.write).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ hook_event_name: 'session.created', ...properties }))
    expect(child.stdin.end).toHaveBeenCalledOnce()
    expect(f.timers).toEqual([3000]); expect(f.shell).not.toHaveBeenCalled()
  })
  it('terminates and reaps a child stalled before socket connection at the hook deadline', async () => {
    vi.useFakeTimers()
    const child = stalled(), f = await fixture(() => child)
    let finished = false
    const pending = f.plugin.event(event('session.created', { sessionID })).then(() => { finished = true })
    await turns(() => f.spawn.mock.calls.length === 1)
    await vi.advanceTimersByTimeAsync(2999); expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await pending
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL'); expect(finished).toBe(true)
    expect(f.posts).toEqual([])
  })
  it.each(['stdout', 'stderr'] as const)('terminates and reaps a child flooding %s without using partial output', async stream => {
    const child = stalled(stream), f = await fixture(() => child)
    await f.plugin.event(event('session.created', { sessionID }))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(f.posts).toEqual([])
    expect(f.shell).not.toHaveBeenCalled()
  })
  it('settles both inherited output readers before returning an overflow failure', async () => {
    let held!: ReadableStreamDefaultController<Uint8Array>
    const child = completed()
    child.stdout = new ReadableStream({ start(controller) { held = controller } })
    child.stderr = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(1024 * 1024 + 1)); controller.close() } })
    const f = await fixture(() => child)
    let finished = false
    const pending = f.plugin.event(event('session.created', { sessionID })).then(() => { finished = true })
    try {
      await turns(() => child.kill.mock.calls.length === 1)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(finished).toBe(false)
    } finally { held.close(); await pending }
    expect(finished).toBe(true); expect(f.posts).toEqual([])
  })
  it('swallows missing-executable failure after attempting the native route', async () => {
    const f = await fixture(() => { throw new Error('synthetic missing exe') })
    await expect(f.plugin.event(event('session.created', { sessionID }))).resolves.toBeUndefined()
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.shell).not.toHaveBeenCalled()
  })
  it('keeps oversized hook stdin out of process creation', async () => {
    const f = await fixture(() => completed())
    await f.plugin.event(event('session.created', { sessionID, data: 'x'.repeat(1024 * 1024 + 1) }))
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.shell).not.toHaveBeenCalled()
  })
  it('uses literal poll/report arguments and acknowledges only an accepted reply', async () => {
    let picked = false
    const f = await fixture(argv => {
      if (argv.includes('--reported')) return completed('{"answers":[]}')
      if (argv.includes('--wait')) {
        if (picked) return completed('', 1)
        picked = true
        return completed(JSON.stringify({ answers: [{ requestRef: 'per_1', kind: 'permission', reply: 'once' }] }))
      }
      return completed()
    })
    f.setReply(async () => {
      await f.plugin.event(event('permission.replied', { sessionID, requestID: 'per_1' }))
      return { ok: true, status: 200 }
    })
    await f.plugin.event(event('session.created', { sessionID }))
    await f.plugin.event(event('permission.asked', { sessionID, id: 'per_1' }))
    await turns(() => f.spawn.mock.calls.some(([argv]) => argv.includes('--reported')))
    expect(f.spawn.mock.calls.map(([argv]) => argv)).toContainEqual(['bmn.exe', 'answer', 'take', '--wait', '25', '--json'])
    expect(f.spawn.mock.calls.map(([argv]) => argv)).toContainEqual(['bmn.exe', 'answer', 'take', '--wait', '0', '--reported', 'per_1=ok', '--json'])
    expect(f.timers).toContain(35000); expect(f.timers).toContain(10000)
    expect(f.posts).toHaveLength(1); expect(await f.posts[0]!.json()).toEqual({ reply: 'once' })
    expect(f.shell).not.toHaveBeenCalled()
  })
  it.each(['record', 'Headers'])('keeps the own server client authentication from %s on a reply', async form => {
    let picked = false
    const f = await fixture(argv => {
      if (argv.includes('--reported')) return completed('{"answers":[]}')
      if (argv.includes('--wait')) {
        if (picked) return completed('', 1)
        picked = true
        return completed(JSON.stringify({ answers: [{ requestRef: 'que_auth', kind: 'question', answers: [['synthetic']] }] }))
      }
      return completed()
    })
    const headers = { Authorization: 'Basic synthetic-fixture-only', 'x-fixture': 'kept', 'content-type': 'wrong/type' }
    f.setClientHeaders(form === 'Headers' ? new Headers(headers) : headers)
    f.setReply(async () => {
      await f.plugin.event(event('question.replied', { sessionID, requestID: 'que_auth' }))
      return { ok: false, status: 404 }
    })
    await f.plugin.event(event('session.created', { sessionID }))
    await f.plugin.event(event('question.asked', { sessionID, id: 'que_auth' }))
    await turns(() => f.spawn.mock.calls.some(([argv]) => argv.includes('--reported')))
    expect(f.posts).toHaveLength(1)
    expect(f.posts[0]!.headers.get('authorization')).toBe('Basic synthetic-fixture-only')
    expect(f.posts[0]!.headers.get('x-fixture')).toBe('kept')
    expect(f.posts[0]!.headers.get('content-type')).toBe('application/json')
    expect(f.posts[0]!.redirect).toBe('error')
    expect(f.spawn.mock.calls.map(([argv]) => argv)).toContainEqual(['bmn.exe', 'answer', 'take', '--wait', '0', '--reported', 'que_auth=failed', '--json'])
  })
  it.each(['win32', 'linux'])('aborts a hanging reply on %s and never acknowledges or repeats its late success', async platform => {
    vi.useFakeTimers()
    let picked = false, late!: (value: { ok: boolean; status: number }) => void
    const f = await fixture(argv => {
      if (argv.includes('--wait')) {
        if (picked) return completed('', 1)
        picked = true
        return completed(JSON.stringify({ answers: [{ requestRef: 'que_1', kind: 'question', answers: [['synthetic']] }] }))
      }
      return completed()
    }, platform)
    f.setReply(() => new Promise(resolve => { late = resolve }))
    await f.plugin.event(event('session.created', { sessionID }))
    await f.plugin.event(event('question.asked', { sessionID, id: 'que_1' }))
    await turns(() => f.posts.length === 1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.posts[0]!.signal.aborted).toBe(true)
    late({ ok: true, status: 200 })
    await f.plugin.event(event('session.idle', { sessionID }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.posts).toHaveLength(1)
    expect(f.spawn.mock.calls.some(([argv]) => argv.includes('--reported'))).toBe(false)
    if (platform === 'linux') expect(f.shell.mock.calls.some(([strings]) => strings.join('').includes('--reported'))).toBe(false)
  })
})
