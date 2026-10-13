// MODULE: secret-ranges.ts - where secret values are in a text: the known shapes, and the wider rule that goes by a file's name (R67-NFR7); shared by what BMN sends to Telegram and what it shows of a file's difference
//
// Masking is a courtesy on screen, not detection: a value none of this finds is shown, and nothing that
// uses these ranges may say or imply that unmasked text is safe.

/** One stretch of a text, from `start` up to and not including `end`. */
export type SecretRange = [start: number, end: number]

interface Shape { pattern: RegExp; keepsName?: true }

/** A PEM private key, through its END line, or to the end of the text when the text was cut short. */
const KEY_BLOCK: Shape = { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g }

/**
 * Secret shapes of one line, as Story 34.2 names them. A key is found wherever its shape appears, even run
 * into other text (`backupAKIA…`), so a hyphenated word ending in `sk` and followed by a long slug
 * (`task-add-…`) is hidden too: over-hiding is visible, a leak is not. Each hides the whole match except
 * `Bearer` and an assignment, whose word or name (group 1) stays so the owner can still tell what was set.
 */
const LINE_SHAPES: readonly Shape[] = [
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

const SHAPES: readonly Shape[] = [KEY_BLOCK, ...LINE_SHAPES]

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
 * never uncovers what another shape hides. Merged and in order. For a short text (a card on its way to
 * Telegram): a file's text goes through `secretRanges`, whose work is bounded.
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

export interface SecretSearchOptions {
  /** Called again and again while the search runs: between lines and between matches. It stops the search by throwing. */
  check?: () => void
  /**
   * How many characters of a line a reader is ever shown. With it a line is searched that far and a little
   * beyond, so one long line cannot hold the search up, and the ranges are right for the part that is shown:
   * a value that begins there and runs past it is hidden to where the search stopped.
   */
  shown?: number
}

/** How far past what is shown a line is searched: enough for every shape to be told by its beginning. */
const BEYOND_SHOWN = 2_048
/** The least a shape can begin with. A line that holds none of these holds no shape. A test keeps it in step with `LINE_SHAPES`. */
const BEGINNINGS = /eyJ|s1\.|sk-|AKIA|gh[pousr]_|github_pat_|xox[abprs]-|AIza|bearer|api_key|apikey|token|secret|password|passwd/gi
/** The characters a token is made of. Where a line is cut inside a run of 32 or more of them, the run is hidden. */
const TOKEN_CHARACTER = /[A-Za-z0-9_.+/=~:-]/
const CUT_RUN = 32
const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/y
const END_KEY = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/y
const LINE_SEARCHES = LINE_SHAPES.map(({ pattern, keepsName }) => ({ search: new RegExp(pattern.source, pattern.flags), keepsName: keepsName === true }))

/** Private key blocks, each from its BEGIN line through its END line, or to the end of a text that has none. */
function keyBlocks(text: string, check: () => void): SecretRange[] {
  const found: SecretRange[] = []
  let from = 0
  for (;;) {
    check()
    const begin = text.indexOf('-----BEGIN ', from)
    if (begin < 0) break
    BEGIN_KEY.lastIndex = begin
    if (!BEGIN_KEY.test(text)) {
      from = begin + 1
      continue
    }
    let end = -1
    for (let at = BEGIN_KEY.lastIndex; end < 0;) {
      const close = text.indexOf('-----END ', at)
      if (close < 0) break
      END_KEY.lastIndex = close
      if (END_KEY.test(text)) end = END_KEY.lastIndex
      else at = close + 1
    }
    if (end < 0) {
      found.push([begin, text.length])
      break
    }
    found.push([begin, end])
    from = end
  }
  return found
}

/** Where the lines begin that hold the beginning of a shape, rising, each once. */
function linesWithShapes(text: string, check: () => void): number[] {
  const starts: number[] = []
  BEGINNINGS.lastIndex = 0
  for (let match = BEGINNINGS.exec(text); match !== null; match = BEGINNINGS.exec(text)) {
    check()
    starts.push(text.lastIndexOf('\n', match.index) + 1)
    const end = text.indexOf('\n', match.index)
    if (end < 0) break
    BEGINNINGS.lastIndex = end + 1
  }
  BEGINNINGS.lastIndex = 0
  return starts
}

/** The shapes of one line, searched as far as `reach` characters. */
function lineShapes(text: string, start: number, reach: number, found: SecretRange[], check: () => void): void {
  const stop = text.indexOf('\n', start)
  const end = stop < 0 ? text.length : stop
  const cut = end - start > reach
  const piece = text.slice(start, cut ? start + reach : end)
  for (const { search, keepsName } of LINE_SEARCHES) {
    search.lastIndex = 0
    for (let match = search.exec(piece); match !== null; match = search.exec(piece)) {
      check()
      found.push([start + match.index + (keepsName ? match[1]!.length : 0), start + match.index + match[0].length])
      search.lastIndex = match.index + 1
    }
  }
  if (!cut) return
  // The search stopped inside this line. A token it stopped in is hidden from where it began.
  let from = piece.length
  while (from > 0 && TOKEN_CHARACTER.test(piece[from - 1] as string)) from -= 1
  if (piece.length - from >= CUT_RUN) found.push([start + from, start + piece.length])
}

/** A name that says its value is a secret. */
const NAMED = /key|token|secret|password|passwd|auth|credential|cookie|private/i
/** `NAME=value`, with or without `export`. */
const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=[ \t]*)(.*)$/
/** A name with what sets it off from its value: `name: `, `"name": `, `name = `. Found wherever it stands in a line. */
const PAIR = /(?<![A-Za-z0-9_.$-])(["']?)([A-Za-z0-9_.$-]+)\1\s*[:=]\s*/g
/** One unbroken run of 32 or more letters, digits, `-`, `_`, `+` or `=`. */
const RUN = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g
/** A value that names no secret: a plain yes, no or nothing. */
const PLAIN_WORD = /^(?:true|false|null|~)$/i
/** A YAML block begins: `|`, `>`, with or without its marks, and nothing else but a comment. */
const BLOCK_BEGINS = /^[|>][+-]?[1-9]?[+-]?[ \t]*(?:#.*)?$/
/** An item of a list that is a name with a value of its own, not a plain value. */
const ITEM_PAIR = /^(?:"(?:[^"\\]|\\.)*"\s*:|'[^']*'\s*:|[A-Za-z0-9_.$-]+\s*:(?:\s|$))/

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

/** The same for a value whose name says it is a secret: a plain yes, no or nothing is none. */
function namedRange(start: number, raw: string): SecretRange | null {
  const range = valueRange(start, raw)
  return range === null || PLAIN_WORD.test(raw.slice(range[0] - start, range[1] - start)) ? null : range
}

/** Where the quote that closes a string is, looked for from `from`; -1 when the line has none. */
function closingQuote(line: string, from: number, quote: string): number {
  for (let at = from; at < line.length; at += 1) {
    const character = line[at]
    if (character === '\\' && quote === '"') at += 1
    else if (character === quote) {
      // YAML writes a single quote inside single quotes twice.
      if (quote === "'" && line[at + 1] === "'") at += 1
      else return at
    }
  }
  return -1
}

/** One call per line of `text`, with the offset the line starts at and whether a line ending follows it. */
function eachLine(text: string, take: (line: string, start: number, ended: boolean) => void): void {
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const stop = end < 0 ? text.length : end
    take(text.slice(start, stop), start, end >= 0)
    if (end < 0) break
    start = end + 1
  }
}

/**
 * A value that goes on over the lines that follow: a quoted string not yet closed, a TOML string between three
 * quotes, a YAML block, or the items of a list. `column` is where its name stands: a line that is not set in
 * deeper than that is no longer part of it.
 */
interface Open { kind: 'quote' | 'fence' | 'block' | 'items'; close: string; column: number }

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The plain values between `[` at `open` and its `]` on this line. Returns where to go on, or -1 when the list is not closed here. */
function listValues(line: string, open: number, start: number, found: SecretRange[]): number {
  let at = open + 1
  for (;;) {
    while (line[at] === ' ' || line[at] === '\t') at += 1
    const character = line[at]
    if (character === undefined) return -1
    if (character === ']') return at + 1
    if (character === ',') {
      at += 1
      continue
    }
    // A list or a map inside the list: its own names decide.
    if (character === '[' || character === '{') return at
    if (character === '"' || character === "'") {
      const close = closingQuote(line, at + 1, character)
      if (close < 0) {
        found.push([start + at + 1, start + line.length])
        return line.length
      }
      if (close > at + 1) found.push([start + at + 1, start + close])
      at = close + 1
      continue
    }
    let end = at
    while (end < line.length && line[end] !== ',' && line[end] !== ']') end += 1
    const range = namedRange(start + at, line.slice(at, end))
    if (range) found.push(range)
    at = end
  }
}

/**
 * The values of one line of a config file whose names say so, wherever the name stands: at the start of the
 * line, or inside a map written on one line (`{"key":"abc"}`, `auth = { token = "x" }`). A value that goes on
 * over the next lines is put on `open`.
 */
function namedValues(line: string, start: number, through: number, reach: number, open: Open[], found: SecretRange[]): void {
  const piece = line.length > reach ? line.slice(0, reach) : line
  PAIR.lastIndex = 0
  for (let match = PAIR.exec(piece); match !== null; match = PAIR.exec(piece)) {
    let lead = match.index - 1
    while (lead >= 0 && (piece[lead] === ' ' || piece[lead] === '\t')) lead -= 1
    const before = lead < 0 ? '' : (piece[lead] as string)
    const first = before === '' || (before === '-' && /^\s*(?:-\s+)+$/.test(piece.slice(0, match.index)))
    const inside = before === '{' || before === ',' || before === '['
    if (!first && !inside) continue
    const at = match.index + match[0].length
    const character = line[at]
    if (!NAMED.test(match[2] as string)) {
      // Not a secret by its name. A quoted value is passed over whole, so nothing in it is taken for a name.
      if (character === '"' || character === "'") {
        const close = closingQuote(line, at + 1, character)
        PAIR.lastIndex = close < 0 ? piece.length : close + 1
      }
      continue
    }
    const column = match.index
    if (character === undefined) {
      // Nothing after the name: its value is on the lines below, set in deeper.
      if (first) open.push({ kind: 'items', close: '', column })
      break
    }
    if (character === '"' || character === "'") {
      const three = character.repeat(3)
      if (first && line.startsWith(three, at)) {
        const close = line.indexOf(three, at + 3)
        if (close < 0) {
          found.push([start + at + 3, through])
          open.push({ kind: 'fence', close: three, column })
          break
        }
        found.push([start + at + 3, start + close])
        PAIR.lastIndex = close + 3
        continue
      }
      const close = closingQuote(line, at + 1, character)
      if (close < 0) {
        found.push([start + at + 1, first ? through : start + line.length])
        if (first) open.push({ kind: 'quote', close: character, column })
        break
      }
      found.push([start + at + 1, start + close])
      PAIR.lastIndex = close + 1
      continue
    }
    if (character === '{') continue
    if (character === '[') {
      const next = listValues(line, at, start, found)
      if (next < 0) {
        if (first) open.push({ kind: 'items', close: '', column })
        break
      }
      PAIR.lastIndex = next
      continue
    }
    if (first) {
      const raw = line.slice(at)
      if (BLOCK_BEGINS.test(raw)) open.push({ kind: 'block', close: '', column })
      else if (raw.startsWith('#')) open.push({ kind: 'items', close: '', column })
      else {
        const range = namedRange(start + at, raw)
        if (range) found.push(range)
      }
      break
    }
    // Inside a map on one line: the value ends at the next comma or bracket.
    let end = at
    while (end < piece.length && piece[end] !== ',' && piece[end] !== '}' && piece[end] !== ']') end += 1
    const range = namedRange(start + at, piece.slice(at, end))
    if (range) found.push(range)
    PAIR.lastIndex = end
  }
  PAIR.lastIndex = 0
}

/**
 * A line while a value from an earlier line is still open. Returns true when the line was all that value's;
 * false when the line is to be read as any other (the value ended above it, or the line is an item with a name
 * of its own).
 */
function continued(line: string, start: number, through: number, open: Open[], found: SecretRange[]): boolean {
  for (let top = open.at(-1); top !== undefined; top = open.at(-1)) {
    const indent = indentOf(line)
    const blank = indent === line.length
    if (top.kind === 'quote' || top.kind === 'fence') {
      // A quoted YAML value goes on only on lines set in deeper than its name; a `.env` value has no such rule.
      if (top.kind === 'quote' && top.column >= 0 && !blank && indent <= top.column) {
        open.pop()
        continue
      }
      const close = top.kind === 'quote' ? closingQuote(line, 0, top.close) : line.indexOf(top.close)
      if (close < 0) found.push([start, through])
      else {
        found.push([start, start + close])
        open.pop()
      }
      return true
    }
    if (blank) return true
    let at = indent
    while (line[at] === '-' && (line[at + 1] === ' ' || at + 1 === line.length)) {
      at += 1
      while (line[at] === ' ') at += 1
    }
    if (indent < top.column || (indent === top.column && (top.kind === 'block' || at === indent))) {
      open.pop()
      continue
    }
    if (top.kind === 'block') {
      found.push([start + indent, start + line.length])
      return true
    }
    const rest = line.slice(at)
    if (rest === '' || rest.startsWith('#') || rest.startsWith(']') || rest.startsWith('}')) return true
    if (rest.startsWith('{') || rest.startsWith('[') || ITEM_PAIR.test(rest)) return false
    const range = namedRange(start + at, rest)
    if (range) found.push(range)
    return true
  }
  return false
}

/**
 * Where the secret values of a file's text are, by the file's name (R67-NFR7): in a `.env` file every value;
 * in a config file a value whose name says so, one with a known shape, and one unbroken run of 32 or more
 * letters, digits, `-`, `_`, `+` or `=` (a lock file is spared that last part, or every checksum would go);
 * in any other text the known shapes. A value is taken whole wherever it stands and however far it goes: a
 * map written on one line, a quoted value over several lines, a YAML block, a TOML string between three
 * quotes, the items of a list under such a name, and a key block of many lines. The work is bounded: see
 * `SecretSearchOptions`.
 */
export function secretRanges(path: string, text: string, options: SecretSearchOptions = {}): SecretRange[] {
  const kind = secretFileKind(path)
  const check = options.check ?? ((): void => undefined)
  const reach = options.shown === undefined ? Number.POSITIVE_INFINITY : options.shown + BEYOND_SHOWN
  const found = keyBlocks(text, check)
  const hot = linesWithShapes(text, check)
  if (kind === 'text') {
    for (const start of hot) lineShapes(text, start, reach, found, check)
    return merged(found)
  }
  const open: Open[] = []
  let next = 0
  let seen = 0
  eachLine(text, (line, start, ended) => {
    seen += 1
    if ((seen & 255) === 0) check()
    while (next < hot.length && (hot[next] as number) < start) next += 1
    if (hot[next] === start) lineShapes(text, start, reach, found, check)
    // A value that goes on takes its line ending with it, so the lines of one value are one range.
    const through = start + line.length + (ended ? 1 : 0)
    if (open.length > 0 && continued(line, start, through, open, found)) return
    if (kind !== 'env') {
      namedValues(line, start, through, reach, open, found)
      return
    }
    if (line.trimStart().startsWith('#')) return
    const match = ENV_LINE.exec(line.length > reach ? line.slice(0, reach) : line)
    if (!match) return
    const at = (match[1] as string).length
    const quote = line[at]
    if ((quote === '"' || quote === "'") && closingQuote(line, at + 1, quote) < 0) {
      // A quoted value that goes on over the next lines, to the quote that closes it.
      found.push([start + at + 1, through])
      open.push({ kind: 'quote', close: quote, column: -1 })
      return
    }
    const range = valueRange(start + at, line.slice(at))
    if (range) found.push(range)
  })
  if (kind === 'config') {
    RUN.lastIndex = 0
    for (let match = RUN.exec(text); match !== null; match = RUN.exec(text)) {
      check()
      found.push([match.index, match.index + match[0].length])
    }
    RUN.lastIndex = 0
  }
  return merged(found)
}
