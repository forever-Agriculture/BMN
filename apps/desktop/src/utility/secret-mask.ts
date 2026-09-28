// MODULE: secret-mask.ts - hides secret-shaped text on its way off the machine to Telegram (Story 34.2)

/** What a hidden secret reads as on a card. */
export const SECRET_MASK = '[secret hidden]'

/** The one line a card ends with when masking hid something in it. */
export const SECRET_FOOTNOTE = 'Some text looked like a secret and was hidden. The full text is on the laptop.'

/**
 * Secret shapes, most specific first. Each hides the whole match except an assignment, whose name stays so the
 * owner can still tell what was set. The terminal, saved output, the database, Needs you, Files and handoff
 * drafts never see this: only text BMN sends to Telegram is masked.
 */
const SHAPES: readonly { pattern: RegExp; keep?: (match: string, ...groups: string[]) => string }[] = [
  // A PEM private key, through its END line, or to the end of the text when the agent's text was cut short.
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // A JWT: three base64url segments, the header starting `eyJ` (`{"`).
  { pattern: /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g },
  // BMN's own session token: `s1.<session>.<incarnation>.<hex mac>` (control-auth.ts).
  { pattern: /\bs1\.[A-Za-z0-9_:-]+\.[A-Za-z0-9_:-]+\.[0-9a-fA-F]{16,}/g },
  // OpenAI and Anthropic keys, `sk-proj-` and `sk-ant-` included.
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // An AWS access key id.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens: classic `ghp_` and its siblings, and fine-grained `github_pat_`.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // Slack tokens.
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // A Google API key.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  // `Bearer <token>`: the word stays, the token of 16 or more characters goes.
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keep: (_match, word) => `${word}${SECRET_MASK}` },
  // `password=…`, `API_KEY: …`, `"token": "…"`: the name stays, a value of 8 or more characters goes.
  {
    pattern: /\b([A-Za-z0-9_-]*(?:api_key|apikey|token|secret|password|passwd)["']?\s*[:=]\s*)[^\s]{8,}/gi,
    keep: (_match, name) => `${name}${SECRET_MASK}`
  }
]

/** Text with every secret shape replaced by SECRET_MASK; text without one comes back unchanged. */
export function maskSecrets(text: string): string {
  let masked = text
  for (const { pattern, keep } of SHAPES) {
    masked = masked.replace(pattern, keep ?? (() => SECRET_MASK))
  }
  return masked
}
