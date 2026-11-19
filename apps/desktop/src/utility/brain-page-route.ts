// MODULE: brain-page-route.ts - The window's private, read-only brain route: exact reads only, checked keys, no write operation (Epic 128 D5, R128-NFR2)
import { BrainError } from './brain-store'
import type { BrainWorkerClient } from './brain-client'

/** Every command the page may send and the keys each takes; nothing here can change the brain. */
export const BRAIN_PAGE_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  status: [],
  list: ['archived', 'withdrawn', 'offset'],
  search: ['query', 'archived'],
  read: ['id'],
  history: ['id'],
  graph: ['id', 'depth', 'archived']
})

export type BrainPageReads = Pick<BrainWorkerClient, 'admission' | 'pageList' | 'pageSearch' | 'pageRead' | 'pageHistory' | 'pageGraph'>
export type BrainPageState = 'ready' | 'not-switched'

function invalid(message: string): never { throw new BrainError('INVALID_ARGUMENT', message) }

/** Answers one page request from the brain worker's reads; any other command or key is refused before the worker. */
export async function brainPageRequest(client: BrainPageReads, params: Record<string, unknown>): Promise<unknown> {
  const command = params.command
  if (typeof command !== 'string' || !Object.hasOwn(BRAIN_PAGE_COMMANDS, command)) invalid('Unknown Brain page request')
  const keys = BRAIN_PAGE_COMMANDS[command]!
  if (Object.keys(params).some((key) => key !== 'command' && !keys.includes(key))) invalid('Unexpected Brain page parameter')
  const text = (key: string, max: number): string => {
    const value = params[key]
    if (typeof value !== 'string' || value.length > max) invalid(`Brain page ${key} must be text of at most ${max} characters`)
    return value
  }
  const flag = (key: string): boolean => {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') invalid(`Brain page ${key} must be true or false`)
    return params[key] === true
  }
  switch (command) {
    case 'status': {
      // The page reads his notes only after the switch: before it, the store may hold an unfinished import.
      const admission = await client.admission()
      return { state: (admission.committed ? 'ready' : 'not-switched') satisfies BrainPageState }
    }
    case 'list': {
      const offset = params.offset ?? 0
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) invalid('Brain page offset must be a whole number')
      return client.pageList({ archived: flag('archived'), withdrawn: flag('withdrawn'), offset })
    }
    case 'search': return client.pageSearch(text('query', 500), flag('archived'))
    case 'read': return client.pageRead(text('id', 64))
    case 'history': return client.pageHistory(text('id', 64))
    case 'graph': {
      const depth = params.depth
      if (depth !== undefined && depth !== 1 && depth !== 2 && depth !== 3) invalid('Brain page depth must be 1, 2 or 3')
      return client.pageGraph(text('id', 64), { ...(depth === undefined ? {} : { depth }), archived: flag('archived') })
    }
  }
  return invalid('Unknown Brain page request')
}
