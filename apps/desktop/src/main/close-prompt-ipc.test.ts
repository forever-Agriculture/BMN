import { describe, expect, it, vi } from 'vitest'
import type { IpcMainEvent, WebContents } from 'electron'
import { ClosePromptCoordinator, agentName } from './close-prompt-ipc'

type Receive = (event: IpcMainEvent, requestId: unknown, decision: unknown) => void

function coordinator(senderId = 4) {
  let receive: Receive = () => undefined
  const ipc = { on: (_channel: 'aiterm:lifecycle:close-decision', listener: Receive) => (receive = listener) }
  const handlers = new Map<string, () => void>()
  const sender = {
    id: senderId,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => handlers.set(event, listener)),
    off: vi.fn((event: string) => handlers.delete(event))
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> }
  const instance = new ClosePromptCoordinator(ipc, (candidate) => candidate === sender)
  return {
    instance,
    sender,
    handlers,
    receive: (...args: Parameters<Receive>) => receive(...args),
    requestId: () => sender.send.mock.calls[0]?.[1]?.requestId as string
  }
}

const SESSIONS = [
  { sessionId: 'session-1', name: 'Same CLI chat B', agent: 'claude', processState: 'live' as const }
]

describe('close prompt coordinator', () => {
  it('waits for the owner, with no deadline, and returns exactly what the window answered', async () => {
    const run = coordinator()

    const asked = run.instance.request(run.sender, 'close', SESSIONS)
    let settled = false
    void asked.then(() => (settled = true))
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(run.sender.send).toHaveBeenCalledWith('aiterm:lifecycle:close-prompt', {
      requestId: run.requestId(),
      mode: 'close',
      sessions: SESSIONS
    })

    run.receive({ sender: run.sender } as unknown as IpcMainEvent, run.requestId(), {
      kind: 'proceed',
      choices: { 'session-1': 'stop' },
      remember: true
    })

    await expect(asked).resolves.toEqual({
      kind: 'proceed',
      choices: { 'session-1': 'stop' },
      remember: true
    })
  })

  it('ignores an answer from another sender, another request, or a shape it cannot read', async () => {
    const run = coordinator()
    const other = { id: 99 } as WebContents

    const asked = run.instance.request(run.sender, 'close', SESSIONS)
    let settled = false
    void asked.then(() => (settled = true))

    run.receive({ sender: other } as unknown as IpcMainEvent, run.requestId(), { kind: 'cancel' })
    run.receive({ sender: run.sender } as unknown as IpcMainEvent, 'another-request', { kind: 'cancel' })
    run.receive({ sender: run.sender } as unknown as IpcMainEvent, run.requestId(), { kind: 'proceed', choices: { a: 'quit' }, remember: true })
    run.receive({ sender: run.sender } as unknown as IpcMainEvent, run.requestId(), { kind: 'invented' })
    await Promise.resolve()
    expect(settled).toBe(false)

    run.receive({ sender: run.sender } as unknown as IpcMainEvent, run.requestId(), { kind: 'cancel' })
    await expect(asked).resolves.toEqual({ kind: 'cancel' })
  })

  it.each(['destroyed', 'did-start-loading'] as const)(
    'gives the question back to the caller when the window %s',
    async (event) => {
      const run = coordinator()

      const asked = run.instance.request(run.sender, 'close', SESSIONS)
      run.handlers.get(event)?.()

      await expect(asked).resolves.toBeUndefined()
      // A late answer from the window that went away must not resolve an already-returned question.
      run.receive({ sender: run.sender } as unknown as IpcMainEvent, run.requestId(), { kind: 'cancel' })
    }
  )

  it('has no window to ask when there is none, or when it is destroyed', async () => {
    const run = coordinator()
    const destroyed = { id: 5, isDestroyed: () => true } as WebContents

    await expect(run.instance.request(undefined, 'close', SESSIONS)).resolves.toBeUndefined()
    await expect(run.instance.request(destroyed, 'close', SESSIONS)).resolves.toBeUndefined()
  })

  it('names the agent, not its path', () => {
    expect(agentName('/usr/bin/claude')).toBe('claude')
    expect(agentName('/bin/bash')).toBe('bash')
    expect(agentName('codex')).toBe('codex')
    expect(agentName('/')).toBe('/')
  })
})
