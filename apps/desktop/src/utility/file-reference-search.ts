// MODULE: file-reference-search.ts - bounded, cancellable on-demand filename search; never follows links
import { lstat, opendir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { FileReferenceSearchResult } from '@bmn/protocol'

export const FILE_SEARCH_MAX_DEPTH = 6
export const FILE_SEARCH_MAX_ENTRIES = 20_000
export const FILE_SEARCH_MAX_RESULTS = 50

export async function searchFileReferences(
  root: string | null,
  query: string,
  signal: AbortSignal,
  limits: { maxDepth?: number; maxEntries?: number; maxResults?: number } = {}
): Promise<FileReferenceSearchResult> {
  const result: FileReferenceSearchResult = {
    root, files: [], scanned: 0, capped: false, unavailable: false, cancelled: false
  }
  if (!root || !isAbsolute(root)) return { ...result, unavailable: true }
  const stats = await lstat(root).catch(() => null)
  if (!stats?.isDirectory() || stats.isSymbolicLink()) return { ...result, unavailable: true }
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return result
  const maxDepth = limits.maxDepth ?? FILE_SEARCH_MAX_DEPTH
  const maxEntries = limits.maxEntries ?? FILE_SEARCH_MAX_ENTRIES
  const maxResults = limits.maxResults ?? FILE_SEARCH_MAX_RESULTS
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  for (let folderIndex = 0; folderIndex < pending.length; folderIndex += 1) {
    if (signal.aborted) return { ...result, cancelled: true }
    const folder = pending[folderIndex]!
    let handle
    try {
      handle = await opendir(folder.path)
    } catch {
      if (folder.depth === 0) result.unavailable = true
      continue
    }
    try {
      for await (const entry of handle) {
        if (signal.aborted) return { ...result, cancelled: true }
        result.scanned += 1
        if (entry.name !== '.git' && entry.name !== 'node_modules' && !entry.isSymbolicLink()) {
          const path = join(folder.path, entry.name)
          if (entry.isDirectory() && folder.depth < maxDepth) pending.push({ path, depth: folder.depth + 1 })
          else if (entry.isFile()) {
            const haystack = `${entry.name} ${path}`.toLocaleLowerCase()
            if (words.every((word) => haystack.includes(word))) {
              result.files.push({ name: basename(path), directory: dirname(path), path })
              if (result.files.length >= maxResults) {
                result.capped = true
                return result
              }
            }
          }
        }
        // Return after the last permitted entry, before the iterator fetches one more.
        if (result.scanned >= maxEntries) {
          result.capped = true
          return result
        }
        if (result.scanned % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch {
      if (folder.depth === 0) result.unavailable = true
    }
  }
  return result
}
