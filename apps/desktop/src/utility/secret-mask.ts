// MODULE: secret-mask.ts - hides secret-shaped text on its way off the machine to Telegram (Story 34.2)

/** What a hidden secret reads as on a card. */
export const SECRET_MASK = '[secret hidden]'

/** The one line a card ends with when masking hid something in it. */
export const SECRET_FOOTNOTE = 'Some text looked like a secret and was hidden. The full text is on the laptop.'

/**
 * Secret shapes as Story 34.2 names them. A key is found wherever its shape appears, even run into other text
 * (`backupAKIA…`), so a hyphenated word ending in `sk` and followed by a long slug (`task-add-…`) is hidden
 * too: over-hiding on a card is visible and the laptop has the text, a leak is not. Each hides the whole match
 * except `Bearer` and an assignment, whose word or name (group 1) stays so the owner can still tell what was
 * set. The terminal, saved output, the database, Needs you, Files and handoff drafts never see this: only text
 * BMN sends to Telegram is masked.
 */
const SHAPES: readonly { pattern: RegExp; keepsName?: true }[] = [
  // A PEM private key, through its END line, or to the end of the text when the agent's text was cut short.
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // A JWT: three base64url segments, the header starting `eyJ` (`{"`).
  { pattern: /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g },
  // BMN's own session token: `s1.<session>.<incarnation>.<hex mac>` (control-auth.ts).
  { pattern: /s1\.[A-Za-z0-9_:-]+\.[A-Za-z0-9_:-]+\.[0-9a-fA-F]{16,}/g },
  // OpenAI and Anthropic keys, `sk-proj-` and `sk-ant-` included.
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  // An AWS access key id.
  { pattern: /AKIA[0-9A-Z]{16}/g },
  // GitHub tokens: classic `ghp_` and its siblings, and fine-grained `github_pat_`.
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  // Slack tokens.
  { pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // A Google API key.
  { pattern: /AIza[0-9A-Za-z_-]{35}/g },
  // `Bearer <token>`: the word stays, the token of 16 or more characters goes.
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keepsName: true },
  // `password=…`, `API_KEY: …`, `"token": "…"`: the name stays, a value of 8 or more characters goes.
  { pattern: /\b([A-Za-z0-9_-]*(?:api_key|apikey|token|secret|password|passwd)["']?\s*[:=]\s*)[^\s]{8,}/gi, keepsName: true }
]

/**
 * Every stretch of `text` a shape hides, found in the text as received: each shape is searched on its own and
 * overlapping matches are all found, so one key cannot shield the tail of another, and a kept name never
 * uncovers what another shape hides. Merged and in order.
 */
function hiddenIntervals(text: string): [number, number][] {
  const found: [number, number][] = []
  for (const { pattern, keepsName } of SHAPES) {
    const search = new RegExp(pattern.source, pattern.flags)
    for (let match = search.exec(text); match !== null; match = search.exec(text)) {
      found.push([match.index + (keepsName ? match[1]!.length : 0), match.index + match[0].length])
      search.lastIndex = match.index + 1
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of found) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Text with every secret shape replaced by SECRET_MASK; text without one comes back unchanged. */
export function maskSecrets(text: string): string {
  let masked = ''
  let at = 0
  for (const [start, end] of hiddenIntervals(text)) {
    masked += `${text.slice(at, start)}${SECRET_MASK}`
    at = end
  }
  return `${masked}${text.slice(at)}`
}

/**
 * `text` cut to at most `max` characters, moved back to the start of any secret the cut would split (Story 34.2).
 * A preview stored whole on the laptop is masked only later on its way to Telegram, and half a key no longer
 * has a key's shape. The prefix itself is never masked.
 */
export function clipOutsideSecrets(text: string, max: number): string {
  let cut = Math.min(max, text.length)
  // Merged stretches never touch, so moving to the start of one cannot land inside an earlier one.
  for (const [start, end] of hiddenIntervals(text)) {
    if (start < cut && end > cut) cut = start
  }
  return text.slice(0, cut)
}
