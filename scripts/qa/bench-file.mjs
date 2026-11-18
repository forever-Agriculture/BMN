// MODULE: bench-file.mjs - bounded-memory hashing and line reads for long certified QA captures
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export function* fileChunks(fd, stats, chunkBytes = 64 * 1024) {
  if (fstatSync(fd).size > 1024 ** 3) throw new Error('QA evidence exceeds 1GiB')
  const buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256')
  stats.bytes = 0
  let count
  while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
    const chunk = buffer.subarray(0, count)
    stats.bytes += count
    if (stats.bytes > 1024 ** 3) throw new Error('QA evidence exceeds 1GiB')
    hash.update(chunk)
    yield chunk
  }
  stats.sha256 = hash.digest('hex')
}

export function fileDigest(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), stats = {}
  try {
    if (!fstatSync(fd).isFile()) throw new Error('QA evidence is not a regular file')
    for (const chunk of fileChunks(fd, stats)) void chunk
    return stats
  } finally { closeSync(fd) }
}

export function* traceLines(fd, stats, chunkBytes = 64 * 1024) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  for (const chunk of fileChunks(fd, stats, chunkBytes)) {
    pending += decoder.write(chunk)
    let at, start = 0
    while ((at = pending.indexOf('\n', start)) !== -1) {
      if (at - start > 1024 * 1024) throw new Error('QA trace line exceeds 1MiB')
      yield pending.slice(start, at); start = at + 1
    }
    pending = pending.slice(start)
    if (pending.length > 1024 * 1024) throw new Error('QA trace line exceeds 1MiB')
  }
  pending += decoder.end()
  if (pending) yield pending
}
