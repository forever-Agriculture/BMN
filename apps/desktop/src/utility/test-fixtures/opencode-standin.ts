// MODULE: opencode-standin.ts - a made-up model, proxy and trap on loopback for running the real OpenCode in tests (Story 70.2, after 70.1's oc-standin.mjs)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One step of the made-up model: call a tool (offered or not), or answer in words. */
export type StandinStep = { tool: string; input: Record<string, unknown> } | { text: string }

export interface StandinRequest {
  model: string | undefined
  /** The tools the request offered, by name. */
  tools: string[]
  /** What each tool call came back with, in order. */
  results: string[]
  /** The whole request body, to look for markers in. */
  body: string
}

export interface Standin {
  port: number
  /** OpenAI Chat Completions requests, in order. */
  requests: StandinRequest[]
  /** Hosts a run asked the proxy to reach; every one is refused. */
  tunnels: string[]
  /** Paths fetched under /trap/. */
  trapped: string[]
  close: () => Promise<void>
}

const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('\n') : ''

/**
 * Speaks OpenAI Chat Completions, streamed, as OpenCode's openai-compatible provider uses it: a
 * request with tools plays `script` by the number of tool results it carries; a request without
 * tools gets a made-up title. Every call is made whether the tool was offered or not, so a tool the
 * run withholds is still tried. The same server refuses every proxy tunnel and records any fetch of
 * `/trap/…`. `{PORT}` in a step is replaced by the server's port.
 */
export async function startStandin(script: StandinStep[]): Promise<Standin> {
  const requests: StandinRequest[] = []
  const tunnels: string[] = []
  const trapped: string[] = []
  const answer = (request: IncomingMessage, response: ServerResponse, body: string): void => {
    const json = JSON.parse(body || '{}') as { model?: string; stream?: boolean; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> }
    const tools = (json.tools ?? []).map((tool) => tool.function?.name ?? '')
    const results = (json.messages ?? []).filter((message) => message.role === 'tool').map((message) => text(message.content))
    requests.push({ model: json.model, tools, results, body })
    const step: StandinStep = tools.length === 0 ? { text: 'A made-up title' } : script[results.length] ?? { text: 'made-up final answer' }
    const filled = JSON.parse(JSON.stringify(step).replaceAll('{PORT}', String(port))) as StandinStep
    const n = requests.length
    const base = { id: `chatcmpl-standin-${n}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: json.model ?? 'standin' }
    const call = 'tool' in filled ? [{ index: 0, id: `call_standin_${n}`, type: 'function', function: { name: filled.tool, arguments: JSON.stringify(filled.input) } }] : null
    const events = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: call ? null : '' }, finish_reason: null }] },
      call ? { ...base, choices: [{ index: 0, delta: { tool_calls: call }, finish_reason: null }] } : { ...base, choices: [{ index: 0, delta: { content: 'text' in filled ? filled.text : '' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
    void request
  }
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      if (/^https?:\/\//.test(request.url ?? '')) {
        tunnels.push(new URL(request.url ?? '').host)
        response.writeHead(403).end()
      } else if (request.url?.startsWith('/trap/')) {
        trapped.push(request.url)
        response.writeHead(200, { 'content-type': 'text/plain' }).end('made-up trap page')
      } else if (request.url?.endsWith('/chat/completions')) {
        answer(request, response, body)
      } else {
        response.writeHead(404).end()
      }
    })
  })
  server.on('connect', (request: IncomingMessage, socket) => {
    tunnels.push(request.url ?? '')
    // A refused CONNECT can be reset by the native client before our response is flushed.
    socket.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'ECONNRESET') throw error })
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port, requests, tunnels, trapped,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}
