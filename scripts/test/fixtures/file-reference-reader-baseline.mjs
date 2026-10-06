// Immutable original 111b522 reader, TS types erased and relative dependency relocated for the regression discriminator.
// MODULE: file-reference-reader.ts - reads one owner-addressed local text file as a bounded, read-only snapshot
import { constants,            } from 'node:fs'
import { open, realpath, stat,                 } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'
import {
  ERROR_CODES,
  FILE_REFERENCE_MAX_BYTES,
  FILE_REFERENCE_MAX_LENGTH,
  fileReferenceLines,
  hasControlOrFormatCharacter,
  parseFileReference,
                         
                               
                           
                                     
} from '../../../shared/protocol/src/index.ts'
import { HostControlError } from '../../../apps/desktop/src/utility/session-manager.ts'

                                           
                    
                      
                    
                        
                                                                                                     
                         
 

                                             
                   
                  
                                                                                         
                                  
 

function invalid(message        )        {
  throw new HostControlError(ERROR_CODES.invalidArgument, message)
}

function errorCode(error         )                     {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function chosenBase(value         )                {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_REFERENCE_MAX_LENGTH || hasControlOrFormatCharacter(value)) {
    invalid('The chosen folder is not a valid path')
  }
  if (!isAbsolute(value)) invalid('The chosen folder must be an absolute path')
  return normalize(value)
}

function sizeLabel(bytes        )         {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`
}

/** True when `path` still resolves to itself and names the same file as the open handle's `stats`. */
async function namesSameFile(path        , stats       )                   {
  const resolved = await realpath(path).catch(() => null)
  if (resolved !== path) return false
  const named = await stat(path).catch(() => null)
  return named !== null && named.dev === stats.dev && named.ino === stats.ino
}

function kindOf(stats       )         {
  if (stats.isDirectory()) return 'a folder'
  if (stats.isFIFO()) return 'a pipe'
  if (stats.isSocket()) return 'a socket'
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device'
  return 'not a regular file'
}

/**
 * Resolves a reference against its base, follows symlinks to the real file, and reads it only when it is a
 * readable regular UTF-8 text file within the size limit. The file is opened without following a final symlink
 * and without blocking, then checked on the open handle, so a swap or a pipe cannot change what is read. After the
 * read the canonical path must still name that same file, or the result says the file changed.
 */
export async function readFileReference(
  request                          ,
  options                             = {}
)                                   {
  if (typeof request.reference !== 'string') invalid('The file reference must be text')
  const parsed = parseFileReference(request.reference, 'typed', process.platform === 'win32' ? 'win32' : 'posix')
  if (!parsed.ok) invalid(parsed.reason)
  const { path, line, column } = parsed.reference
  const chosen = chosenBase(request.baseDirectory)
  const base                           = isAbsolute(path)
    ? null
    : chosen
      ? { kind: 'chosen-directory', path: chosen }
      : { kind: 'launch-directory', path: request.launchDirectory }
  const target                      = {
    sessionId: request.sessionId ?? null,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    reference: request.reference.trim(),
    line,
    column,
    base,
    resolvedPath: base ? resolve(base.path, path) : normalize(path)
  }
  const unavailable = (
    reason                                ,
    message        ,
    canonicalPath                = null
  )                          => ({ ...target, status: 'unavailable', reason, message, canonicalPath })

  if (base) {
    const baseStats = await stat(base.path).catch(() => undefined)
    if (!baseStats?.isDirectory()) {
      return unavailable('missing', `${base.kind === 'launch-directory' ? 'The launch directory' : 'The chosen folder'} no longer exists.`)
    }
  }
  let canonicalPath        
  try {
    canonicalPath = await realpath(target.resolvedPath)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EACCES' || code === 'EPERM') return unavailable('unreadable', 'Permission to reach this file was denied.')
    if (code === 'ELOOP') return unavailable('missing', 'A symlink on this path points back to itself.')
    return unavailable('missing', 'No file exists at this path.')
  }
  const maxBytes = options.maxBytes ?? FILE_REFERENCE_MAX_BYTES
  let handle            
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EACCES' || code === 'EPERM') return unavailable('unreadable', 'Permission to read this file was denied.', canonicalPath)
    if (code === 'ENOENT') return unavailable('changed', 'The file disappeared while opening; refresh to try again.', canonicalPath)
    if (code === 'ELOOP') return unavailable('changed', 'The file was replaced by a symlink while opening; refresh to try again.', canonicalPath)
    if (code === 'ENXIO' || code === 'EISDIR') return unavailable('not-a-file', 'This path is not a regular file.', canonicalPath)
    return unavailable('unreadable', 'The file could not be opened.', canonicalPath)
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return unavailable('not-a-file', `This path is ${kindOf(stats)}; only regular files are shown.`, canonicalPath)
    if (stats.size > maxBytes) {
      return unavailable('too-large', `The file is larger than ${sizeLabel(maxBytes)}; open it in an editor.`, canonicalPath)
    }
    await options.afterCheck?.()
    // One byte past the limit proves the file grew beyond it, however large it has become.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    // A folder on the path swapped for a symlink, or the file replaced, would make the shown path describe other bytes.
    if (!(await namesSameFile(canonicalPath, stats))) {
      return unavailable('changed', 'The file changed while it was being read; refresh to read it again.', canonicalPath)
    }
    if (length > maxBytes) {
      return unavailable('too-large', `The file grew past ${sizeLabel(maxBytes)} while reading; open it in an editor.`, canonicalPath)
    }
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0)) return unavailable('binary', 'This file holds binary data; only text files are shown.', canonicalPath)
    let content        
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return unavailable('binary', 'This file is not UTF-8 text; only text files are shown.', canonicalPath)
    }
    return {
      ...target,
      status: 'ready',
      canonicalPath,
      content,
      byteLength: length,
      lineCount: fileReferenceLines(content).length,
      modifiedAt: stats.mtime.toISOString(),
      readAt: (options.now?.() ?? new Date()).toISOString()
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EISDIR') return unavailable('not-a-file', 'This path is a folder; only regular files are shown.', canonicalPath)
    return unavailable('unreadable', 'The file could not be read.', canonicalPath)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
