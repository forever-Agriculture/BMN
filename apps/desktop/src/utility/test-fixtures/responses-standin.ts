// MODULE: responses-standin.ts - Epic 72 test fixture: one made-up OpenAI Responses provider on loopback that plays a script of tool calls, then answers, and records every request body for the sentinels it must never carry; it is also the run's HTTP(S) proxy, refusing and recording every tunnel
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One tool call the made-up model makes: the tool's name and its input. */
export interface ScriptedCall { tool: string; input: Record<string, unknown> }

export interface StandIn {
  port: number
  /** Every model request's body, whole, as text. */
  bodies: string[]
  /** The tools each model request offered. */
  offered: string[][]
  /** Every tool result the model was sent back, by call. */
  results: Array<{ call: string; output: string }>
  /** Hosts a client asked to tunnel to through the proxy (all refused). */
  tunnels: string[]
  /** Whether each model request carried this key as its bearer, without keeping the value. */
  bearerIs: (key: string) => boolean[]
  close: () => Promise<void>
}

const sse = (response: ServerResponse, events: Array<Record<string, unknown>>): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  events.forEach((event, index) => response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`))
  response.end()
}

/**
 * Starts the stand-in. A model request whose input already holds the results of every scripted
 * call gets the final answer `answer`; any other gets all the script's calls at once. A request
 * without a user message (a title) gets a made-up title.
 */
export async function startResponsesStandIn(script: ScriptedCall[], answer = 'made-up final answer'): Promise<StandIn> {
  const bodies: string[] = []
  const offered: string[][] = []
  const results: Array<{ call: string; output: string }> = []
  const tunnels: string[] = []
  const bearers: string[] = []
  let n = 0
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (request.method !== 'POST' || !/\/responses$/u.test(request.url ?? '')) {
        response.writeHead(404).end()
        return
      }
      n += 1
      bodies.push(body)
      bearers.push(String(request.headers.authorization ?? ''))
      let json: { input?: Array<Record<string, unknown>>; tools?: Array<{ name?: string; type?: string }>; model?: string }
      try {
        json = JSON.parse(body)
      } catch {
        response.writeHead(400).end()
        return
      }
      offered.push((json.tools ?? []).map((tool) => tool.name ?? String(tool.type)))
      const input = Array.isArray(json.input) ? json.input : []
      for (const item of input) if (item.type === 'function_call_output') results.push({ call: String(item.call_id), output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) })
      const answered = input.filter((item) => item.type === 'function_call_output').length
      const main = input.some((item) => item.type === 'message' && item.role === 'user')
      const id = `resp_standin_${n}`
      const calls = main && answered < script.length ? script : []
      const words = main ? answer : 'A made-up title'
      const items = calls.length > 0
        ? calls.map((call, index) => ({ type: 'function_call', id: `fc_${n}_${index}`, call_id: `call-${index}`, name: call.tool, arguments: JSON.stringify(call.input), status: 'completed' }))
        : [{ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: words, annotations: [] }] }]
      const usage = { input_tokens: 21, input_tokens_details: { cached_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 }
      const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: json.model, output: [] } }]
      items.forEach((item, index) => {
        events.push({ type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : { ...item, status: 'in_progress', arguments: '' } })
        if (item.type === 'message') {
          const text = (item as { content: Array<{ text: string }> }).content[0]!.text
          events.push({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
          events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: text })
          events.push({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text })
          events.push({ type: 'response.content_part.done', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
        } else {
          events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: (item as { arguments: string }).arguments })
          events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: (item as { arguments: string }).arguments })
        }
        events.push({ type: 'response.output_item.done', output_index: index, item })
      })
      events.push({ type: 'response.completed', response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: json.model, output: items, usage } })
      sse(response, events)
    })
  }
  const server: Server = createServer(handle)
  // As the run's proxy: every tunnel is recorded by host and refused.
  server.on('connect', (request: IncomingMessage, socket) => {
    tunnels.push(String(request.url ?? ''))
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port, bodies, offered, results, tunnels,
    bearerIs: (key) => bearers.map((bearer) => bearer === `Bearer ${key}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
