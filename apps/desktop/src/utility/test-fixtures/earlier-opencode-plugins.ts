// MODULE: earlier-opencode-plugins.ts - BMN's earlier OpenCode plugin texts read back from this repository's history, and a plugin run in a fresh context with a fake spawn (Story 96.3)
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const REPOSITORY = fileURLToPath(new URL('../../../../..', import.meta.url))
const DECLARATION = 'const OPENCODE_PLUGIN = `'

/** The OPENCODE_PLUGIN text a file of BMN held at a commit, as its template literal evaluates. */
export function shippedPluginText(commit: string, file: string): string {
  const source = execFileSync('git', ['-C', REPOSITORY, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const start = source.indexOf(DECLARATION)
  if (start < 0) throw new Error(`${file} at ${commit} declares no OPENCODE_PLUGIN`)
  let body = ''
  for (let at = start + DECLARATION.length; at < source.length; at += 1) {
    const char = source[at]!
    if (char === '\\') { body += char + source[at + 1]!; at += 1; continue }
    if (char === '$' && source[at + 1] === '{') throw new Error(`OPENCODE_PLUGIN at ${commit} interpolates; it cannot be read back here`)
    if (char === '`') return new Function(`return \`${body}\``)() as string
    body += char
  }
  throw new Error(`OPENCODE_PLUGIN at ${commit} never ends`)
}

/** What an OpenCode 2 terminal plugin told BMN, given events, when it unloaded, and what it wrote to its terminal. */
export async function replayTerminalPlugin(text: string, events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): Promise<{
  told: Array<Record<string, unknown>>
  written: string[]
}> {
  const told: Array<Record<string, unknown>> = []
  const written: string[] = []
  const spawn = (_program: string, args: string[]) => {
    const handlers: Record<string, (code: number) => void> = {}
    return {
      stdout: { on: () => undefined },
      stdin: { on: () => undefined, end: (input: string) => { if (args.includes('hook')) told.push(JSON.parse(input)); queueMicrotask(() => handlers.close?.(0)) } },
      on: (name: string, handler: (code: number) => void) => { handlers[name] = handler }
    }
  }
  const javascript = stripTypeScriptTypes(text).replace('import { spawn } from "node:child_process"', '').replace('export default', 'const plugin =')
  const plugin = runInNewContext(`${javascript}; plugin`, {
    process: { env: { BMN_CONTROL_SOCKET: '/synthetic/socket' }, stdout: { write: (chunk: string) => { written.push(chunk); return true } } },
    spawn, setInterval: () => ({ unref: () => undefined }), clearInterval: () => undefined, setTimeout
  }) as { setup(context: unknown): (() => unknown) | undefined }
  let listen: (input: unknown) => void = () => undefined
  const stop = plugin.setup({
    data: { listen: (handler: (input: unknown) => void) => { listen = handler; return () => undefined }, session: { root: (id: string) => id, get: () => ({ time: { created: 0 } }) } },
    ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_synthetic' }) } },
    client: {}
  })
  for (const event of events) listen({ details: { id: 'evt_synthetic', created: 0, ...event } })
  await stop?.()
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  return { told, written }
}
