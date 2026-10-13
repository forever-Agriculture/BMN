// MODULE: secret-ranges.ts - where secret values are in a text: the known shapes, and the wider rule that goes by a file's name (R67-NFR7); shared by what BMN sends to Telegram and what it shows of a file's difference
//
// Masking is a courtesy on screen, not detection: a value none of this finds is shown, and nothing that
// uses these ranges may say or imply that unmasked text is safe.

/** One stretch of a text, from `start` up to and not including `end`. */
export type SecretRange = [start: number, end: number]

/**
 * Secret shapes as Story 34.2 names them. A key is found wherever its shape appears, even run into other text
 * (`backupAKIA…`), so a hyphenated word ending in `sk` and followed by a long slug (`task-add-…`) is hidden
 * too: over-hiding is visible, a leak is not. Each hides the whole match except `Bearer` and an assignment,
 * whose word or name (group 1) stays so the owner can still tell what was set.
 */
const SHAPES: readonly { pattern: RegExp; keepsName?: true }[] = [
  // A PEM private key, through its END line, or to the end of the text when the text was cut short.
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

/** Ranges in order, with those that touch or overlap made one. */
function merged(found: SecretRange[]): SecretRange[] {
  found.sort((a, b) => a[0] - b[0])
  const ranges: SecretRange[] = []
  for (const [start, end] of found) {
    if (end <= start) continue
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  return ranges
}

function shapes(text: string): SecretRange[] {
  const found: SecretRange[] = []
  for (const { pattern, keepsName } of SHAPES) {
    const search = new RegExp(pattern.source, pattern.flags)
    for (let match = search.exec(text); match !== null; match = search.exec(text)) {
      found.push([match.index + (keepsName ? match[1]!.length : 0), match.index + match[0].length])
      search.lastIndex = match.index + 1
    }
  }
  return found
}

/**
 * Every stretch of `text` a known shape hides, found in the text as received: each shape is searched on its
 * own and overlapping matches are all found, so one key cannot shield the tail of another, and a kept name
 * never uncovers what another shape hides. Merged and in order.
 */
export function secretShapeRanges(text: string): SecretRange[] {
  return merged(shapes(text))
}

/** What R67-NFR7 goes by: `.env` files, config files (JSON, JSONC, YAML, TOML), lock files, and every other text. */
export type SecretFileKind = 'env' | 'config' | 'lock' | 'text'

export function secretFileKind(path: string): SecretFileKind {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'env'
  if (name.endsWith('.lock') || name === 'npm-shrinkwrap.json' || /[-_.]lock\.(?:json|jsonc|ya?ml|toml)$/.test(name)) return 'lock'
  if (/\.(?:json|jsonc|ya?ml|toml)$/.test(name)) return 'config'
  return 'text'
}

/** A name that says its value is a secret. */
const NAMED = /key|token|secret|password|passwd|auth|credential|cookie|private/i
/** `NAME=value`, with or without `export`. */
const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=[ \t]*)(.*)$/
/** `name: value`, `"name": "value",` and `name = "value"`, with or without a list dash. */
const NAMED_LINE = /^(\s*(?:-\s+)?["']?([A-Za-z0-9_.$-]+)["']?\s*[:=]\s*)(.*)$/
/** One unbroken run of 32 or more letters, digits, `-`, `_`, `+` or `=`. */
const RUN = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g
/** A value that names no secret: a map, a list or a block that begins here, or a plain yes, no or nothing. */
const NO_VALUE = /^(?:[{[|>].*|true|false|null|~)$/i

/** The value's own characters: without the comma that ends a JSON line and without the quotes around it. */
function valueRange(start: number, raw: string): SecretRange | null {
  let from = 0
  let to = raw.trimEnd().length
  if (raw[to - 1] === ',') to = raw.slice(0, to - 1).trimEnd().length
  if (to - from >= 2 && (raw[from] === '"' || raw[from] === "'") && raw[to - 1] === raw[from]) {
    from += 1
    to -= 1
  }
  return to > from ? [start + from, start + to] : null
}

/** One call per line of `text`, with the offset the line starts at. */
function eachLine(text: string, take: (line: string, start: number) => void): void {
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const stop = end < 0 ? text.length : end
    take(text.slice(start, stop), start)
    if (end < 0) break
    start = end + 1
  }
}

/**
 * Where the secret values of a file's text are, by the file's name (R67-NFR7): in a `.env` file every value;
 * in a config file a value whose name says so, one with a known shape, and one unbroken run of 32 or more
 * letters, digits, `-`, `_`, `+` or `=` (a lock file is spared that last part, or every checksum would go);
 * in any other text the known shapes. Found over the whole text, so a key block of many lines is one range.
 */
export function secretRanges(path: string, text: string): SecretRange[] {
  const kind = secretFileKind(path)
  const found = shapes(text)
  if (kind === 'env') {
    eachLine(text, (line, start) => {
      if (line.trimStart().startsWith('#')) return
      const match = ENV_LINE.exec(line)
      const range = match ? valueRange(start + match[1]!.length, match[2]!) : null
      if (range) found.push(range)
    })
  }
  if (kind === 'config' || kind === 'lock') {
    eachLine(text, (line, start) => {
      const match = NAMED_LINE.exec(line)
      if (!match || !NAMED.test(match[2]!)) return
      const range = valueRange(start + match[1]!.length, match[3]!)
      if (range && !NO_VALUE.test(text.slice(range[0], range[1]))) found.push(range)
    })
  }
  if (kind === 'config') {
    const search = new RegExp(RUN.source, RUN.flags)
    for (let match = search.exec(text); match !== null; match = search.exec(text)) found.push([match.index, match.index + match[0].length])
  }
  return merged(found)
}
