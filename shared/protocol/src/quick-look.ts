// MODULE: quick-look.ts - Quick look's limits, host results and the pure facts its sheet shows about a file (Epic 67)
import type { FileReferenceUnavailableReason } from './file-reference'

/** The largest file shown as text (R67-NFR2); a larger one shows its facts only. */
export const QUICK_LOOK_READ_MAX_BYTES = 2 * 1024 * 1024
/** One folder lists at most this many entries, then a line naming how many more there are. */
export const QUICK_LOOK_LIST_MAX_ENTRIES = 2_000
/** Listed and dimmed, never hidden: what a project holds but its owner rarely reads. */
export const QUICK_LOOK_DIMMED_NAMES: readonly string[] = Object.freeze(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache'])
/** A chain of folders that each hold one folder only is shown as one row, up to this many names. */
export const QUICK_LOOK_JOIN_DEPTH = 8

/** Exactly one of a session (its launch folder) or a workspace (its folder), as the file reference read takes. */
export type QuickLookSource = { sessionId: string; workspaceId?: never } | { workspaceId: string; sessionId?: never }

export type QuickLookRootResult =
  | {
      status: 'ready'
      /** The folder the session's process started in, its stored folder once stopped, or the workspace's folder. */
      sessionFolder: string
      /** The work tree's root when the session folder lies below it; null at the root or outside Git. */
      gitRoot: string | null
      home: string | null
    }
  | { status: 'unavailable'; folder: string | null; home: string | null }

export type QuickLookEntryKind = 'folder' | 'file' | 'link'

export interface QuickLookEntry {
  name: string
  kind: QuickLookEntryKind
  dimmed: boolean
  /** Folder names below this one, each the only entry of the one before; the row reads `name/joined…`. */
  joined: string[]
}

export type QuickLookListParams = QuickLookSource & { folder: string }

export type QuickLookListResult =
  | { status: 'ready'; folder: string; entries: QuickLookEntry[]; more: number }
  | { status: 'unavailable'; folder: string; message: string }

export type QuickLookReadParams = QuickLookSource & { path: string }

/** What is known about a file that is not shown as text. */
export interface QuickLookFileFacts {
  byteLength: number
  modifiedAt: string
}

/**
 * Which bytes a shown file had when it was read: its size, its modified time to the nanosecond and its inode. The
 * sheet asks for it again every 2 s and offers a reload when it differs (Story 67.2 AC2); nothing watches the file.
 */
export interface QuickLookIdentity {
  byteLength: number
  modifiedNs: string
  inode: string
}

export type QuickLookReadResult =
  | {
      status: 'ready'
      /** The path asked for, before links are followed. */
      path: string
      canonicalPath: string
      content: string
      byteLength: number
      lineCount: number
      modifiedAt: string
      identity: QuickLookIdentity
    }
  | {
      status: 'unavailable'
      path: string
      canonicalPath: string | null
      reason: FileReferenceUnavailableReason
      message: string
      facts: QuickLookFileFacts | null
    }

export type QuickLookIdentityParams = QuickLookSource & { path: string }

/** The file at a path now; `gone` when nothing readable is there or it is no longer a regular file. */
export type QuickLookIdentityResult = { status: 'ready'; identity: QuickLookIdentity } | { status: 'gone' }

/** True when the file read then and the file at its path now hold the same bytes, as far as size, time and inode tell. */
export function sameQuickLookIdentity(read: QuickLookIdentity, now: QuickLookIdentityResult): boolean {
  return now.status === 'ready' && now.identity.byteLength === read.byteLength && now.identity.modifiedNs === read.modifiedNs
    && now.identity.inode === read.inode
}

/** The language a file is coloured as; null shows it plain. */
export type QuickLookLanguage =
  | 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'json' | 'jsonc' | 'yaml' | 'toml' | 'markdown' | 'css' | 'html'
  | 'python' | 'rust' | 'go' | 'sql' | 'shell' | 'dockerfile' | 'diff'

interface FileType { label: string; language: QuickLookLanguage | null }

const BY_EXTENSION: Readonly<Record<string, FileType>> = Object.freeze({
  ts: { label: 'TypeScript', language: 'typescript' }, mts: { label: 'TypeScript', language: 'typescript' },
  cts: { label: 'TypeScript', language: 'typescript' }, tsx: { label: 'TSX', language: 'tsx' },
  js: { label: 'JavaScript', language: 'javascript' }, mjs: { label: 'JavaScript', language: 'javascript' },
  cjs: { label: 'JavaScript', language: 'javascript' }, jsx: { label: 'JSX', language: 'jsx' },
  json: { label: 'JSON', language: 'json' }, jsonc: { label: 'JSONC', language: 'jsonc' },
  yaml: { label: 'YAML', language: 'yaml' }, yml: { label: 'YAML', language: 'yaml' },
  toml: { label: 'TOML', language: 'toml' }, md: { label: 'Markdown', language: 'markdown' },
  markdown: { label: 'Markdown', language: 'markdown' }, css: { label: 'CSS', language: 'css' },
  html: { label: 'HTML', language: 'html' }, htm: { label: 'HTML', language: 'html' },
  py: { label: 'Python', language: 'python' }, rs: { label: 'Rust', language: 'rust' }, go: { label: 'Go', language: 'go' },
  sql: { label: 'SQL', language: 'sql' }, sh: { label: 'Shell', language: 'shell' }, bash: { label: 'Shell', language: 'shell' },
  zsh: { label: 'Shell', language: 'shell' }, diff: { label: 'Diff', language: 'diff' }, patch: { label: 'Diff', language: 'diff' },
  txt: { label: 'Plain text', language: null }, log: { label: 'Plain text log', language: null },
  csv: { label: 'CSV', language: null }, svg: { label: 'SVG image', language: null },
  zip: { label: 'Zip archive', language: null }, gz: { label: 'Gzip archive', language: null },
  tar: { label: 'Tar archive', language: null }, png: { label: 'PNG image', language: null },
  jpg: { label: 'JPEG image', language: null }, jpeg: { label: 'JPEG image', language: null },
  gif: { label: 'GIF image', language: null }, webp: { label: 'WebP image', language: null },
  pdf: { label: 'PDF document', language: null }, sqlite3: { label: 'SQLite database', language: null },
  db: { label: 'Database', language: null }, lock: { label: 'Lock file', language: null }
})

const BY_NAME: Readonly<Record<string, FileType>> = Object.freeze({
  dockerfile: { label: 'Dockerfile', language: 'dockerfile' },
  makefile: { label: 'Makefile', language: null },
  '.bashrc': { label: 'Shell', language: 'shell' },
  '.profile': { label: 'Shell', language: 'shell' },
  '.zshrc': { label: 'Shell', language: 'shell' }
})

/** The last path segment. */
export function quickLookName(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** A file's type in words and the language its text is coloured as, from its name alone. */
export function quickLookFileType(path: string): FileType {
  const name = quickLookName(path)
  const lower = name.toLowerCase()
  const named = BY_NAME[lower] ?? (lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile') ? BY_NAME.dockerfile : undefined)
  if (named) return named
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) return { label: 'Environment', language: null }
  const dot = lower.lastIndexOf('.')
  if (dot > 0) {
    const known = BY_EXTENSION[lower.slice(dot + 1)]
    if (known) return known
  }
  return { label: 'Text', language: null }
}

/** Sizes as the board writes them: "0 bytes", "742 B", "31.4 KB", "38.6 MB" (powers of 1024). */
export function quickLookSize(bytes: number): string {
  if (bytes === 0) return '0 bytes'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** A count with thousands separated by commas, as "1,240 more not shown" reads. */
export function quickLookCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The path with the home folder written as `~`. */
export function quickLookHomePath(path: string, home: string | null): string {
  if (!home || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** True when `path` is `root` or lies below it, compared as whole segments. */
export function quickLookInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * The path row's two parts: the folders, cut first when space is short, and the name, which stays. Inside the
 * root the folders are relative to it; outside it the path is shown whole.
 */
export function quickLookPathParts(path: string, root: string | null): { directory: string; name: string; outside: boolean } {
  const outside = root !== null && !quickLookInside(root, path)
  const shown = root !== null && !outside && path !== root ? path.slice(root.length + (root.endsWith('/') ? 0 : 1)) : path
  const name = quickLookName(shown)
  return { directory: shown.slice(0, shown.length - name.length), name, outside }
}
