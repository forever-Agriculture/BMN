/** Renderer-only focus history, no time/content tracking. */
export function rememberRecentSession(ids: readonly string[], sessionId: string): string[] {
  return [sessionId, ...ids.filter(id => id !== sessionId)].slice(0, 20)
}
