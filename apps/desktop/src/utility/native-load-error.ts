const MAX_REASON_LENGTH = 240

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/([a-z]+:\/\/)[^\s/@]+@/gi, '$1[credentials-redacted]@')
    .slice(0, MAX_REASON_LENGTH)
}

export function nativeLoadFailureMessage(
  moduleName: 'node-pty' | 'better-sqlite3',
  error: unknown,
  repoRoot: string
): string {
  return `[ai-terminal] the terminal host cannot start: native module "${moduleName}" failed to load: ${safeReason(error)}. Fix: run the documented rebuild command ("pnpm rebuild ${moduleName}" + the pinned @electron/rebuild step) in ${repoRoot} (requires python3, make, g++, and Electron headers download). No sessions were started.`
}
