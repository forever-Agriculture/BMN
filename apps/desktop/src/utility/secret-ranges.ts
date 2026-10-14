// MODULE: secret-ranges.ts - where secret values are in a text: the known shapes, and the wider rule that goes by a file's name (R67-NFR7); shared by what BMN sends to Telegram and what it shows of a file's difference
//
// Masking is a courtesy on screen, not detection: a value none of this finds is shown, and nothing that
// uses these ranges may say or imply that unmasked text is safe.
//
// A file's text is read by loops over its characters that ask their caller again and again, never by a
// pattern left alone with a whole file: a pattern cannot be stopped, and one of them runs out of stack on
// a run of ten million characters. Patterns are used on short pieces only.

/** One stretch of a text, from `start` up to and not including `end`. */
export type SecretRange = [start: number, end: number]

interface Shape { pattern: RegExp; keepsName?: true }

/** A PEM private key, through its END line, or to the end of the text when the text was cut short. */
const KEY_BLOCK: Shape = { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g }

/** The words that make a name a secret's in running text (Story 34.2). */
const NAME_WORDS = 'api_key|apikey|token|secret|password|passwd'

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
  { pattern: new RegExp(`\\b([A-Za-z0-9_-]*(?:${NAME_WORDS})["']?\\s*[:=]\\s*)[^\\s]{8,}`, 'gi'), keepsName: true }
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

/** The file's own name, in small letters. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase()

export function secretFileKind(path: string): SecretFileKind {
  const name = nameOf(path)
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'env'
  if (name.endsWith('.lock') || name === 'npm-shrinkwrap.json' || /[-_.]lock\.(?:json|jsonc|ya?ml|toml)$/.test(name)) return 'lock'
  if (/\.(?:json|jsonc|ya?ml|toml)$/.test(name)) return 'config'
  return 'text'
}

export interface SecretSearchOptions {
  /** Called again and again while the search runs. It stops the search by throwing. */
  check?: () => void
  /**
   * How many characters of a line a reader is ever shown. With it a line is searched for the known shapes
   * that far and a little beyond, so one long line cannot hold the search up, and the ranges are right for
   * the part that is shown: a value that begins there and runs past it is hidden to where the search
   * stopped. What a file's own form says (names, quotes, brackets) is read over the whole line whatever
   * this is: a value named far out in a line can go on into lines that are shown.
   */
  shown?: number
}

/** How far past what is shown a line is searched: enough for every shape to be told by its beginning. */
const BEYOND_SHOWN = 2_048
/** The least a shape can begin with. A line that holds none of these holds no shape. A test keeps it in step with `LINE_SHAPES`. */
const BEGINNINGS = new RegExp(`eyJ|s1\\.|sk-|AKIA|gh[pousr]_|github_pat_|xox[abprs]-|AIza|bearer|${NAME_WORDS}`, 'gi')
/** The longest of those beginnings. */
const LONGEST_BEGINNING = 16
/** How much of a text the beginnings are looked for in at a time, so that the caller is asked in between. */
const WINDOW = 256 * 1024
/** The characters a token is made of. Where a line is cut inside a run of 32 or more of them, the run is hidden. */
const TOKEN_CHARACTER = /[A-Za-z0-9_.+/=~:-]/
const CUT_RUN = 32
const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/y
const END_KEY = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/y
const LINE_SEARCHES = LINE_SHAPES.map(({ pattern, keepsName }) => ({ search: new RegExp(pattern.source, pattern.flags), keepsName: keepsName === true }))

const TAB = 9
const LINE_END = 10
const RETURN = 13
const SPACE = 32
const BANG = 33
const QUOTE = 34
const HASH = 35
const AMPERSAND = 38
const APOSTROPHE = 39
const STAR = 42
const COMMA = 44
const DASH = 45
const SLASH = 47
const COLON = 58
const EQUALS = 61
const GREATER = 62
const QUESTION = 63
const OPEN_SQUARE = 91
const BACKSLASH = 92
const CLOSE_SQUARE = 93
const OPEN_CURLY = 123
const PIPE = 124
const CLOSE_CURLY = 125
const BYTE_ORDER_MARK = 0xfeff
/** How often a loop over characters asks its caller: every so many characters. */
const ASK_EVERY = 0xffff

/** A space or a tab. */
const inline = (code: number): boolean => code === SPACE || code === TAB
/** What counts for nothing at either end of a line: a space, a tab, the `\r` of a `\r\n` ending, a byte order mark. */
const blank = (code: number): boolean => code === SPACE || code === TAB || code === RETURN || code === BYTE_ORDER_MARK
/** What `\s` is to a pattern. */
const space = (code: number): boolean =>
  code === SPACE || (code >= TAB && code <= RETURN) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === BYTE_ORDER_MARK

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

/** Where the lines begin that hold the beginning of a shape, rising, each once. The text is looked through a window at a time. */
function linesWithShapes(text: string, check: () => void): number[] {
  const starts: number[] = []
  for (let from = 0; from < text.length;) {
    check()
    const to = Math.min(text.length, from + WINDOW)
    const piece = text.slice(from, Math.min(text.length, to + LONGEST_BEGINNING))
    let next = to
    BEGINNINGS.lastIndex = 0
    for (let match = BEGINNINGS.exec(piece); match !== null && from + match.index < to; match = BEGINNINGS.exec(piece)) {
      const at = from + match.index
      starts.push(text.lastIndexOf('\n', at) + 1)
      const end = text.indexOf('\n', at)
      if (end < 0) return starts
      if (end + 1 >= to) {
        next = end + 1
        break
      }
      BEGINNINGS.lastIndex = end + 1 - from
    }
    from = next
  }
  BEGINNINGS.lastIndex = 0
  return starts
}

/** The shapes of one line, searched as far as `reach` characters, in order. Returns where the line ends. */
function lineShapes(text: string, start: number, reach: number, found: SecretRange[], check: () => void): number {
  const stop = text.indexOf('\n', start)
  const end = stop < 0 ? text.length : stop
  const cut = end - start > reach
  const piece = text.slice(start, cut ? start + reach : end)
  const mine: SecretRange[] = []
  for (const { search, keepsName } of LINE_SEARCHES) {
    search.lastIndex = 0
    for (let match = search.exec(piece); match !== null; match = search.exec(piece)) {
      check()
      mine.push([start + match.index + (keepsName ? match[1]!.length : 0), start + match.index + match[0].length])
      search.lastIndex = match.index + 1
    }
  }
  if (cut) {
    // The search stopped inside this line. A token it stopped in is hidden from where it began.
    let from = piece.length
    while (from > 0 && TOKEN_CHARACTER.test(piece[from - 1] as string)) from -= 1
    if (piece.length - from >= CUT_RUN) mine.push([start + from, start + piece.length])
  }
  if (mine.length > 1) mine.sort((a, b) => a[0] - b[0])
  for (const range of mine) found.push(range)
  return end
}

// Two shapes hold `\s` and so go on over a line ending in a short text: `Bearer` with its token on the
// next line, and a name with its `:` or `=` or its value there. What a line leaves open at its end:
/** Nothing. */
const NOTHING = 0
/** `Bearer`: its token comes. */
const TOKEN = 1
/** A name with its `:` or `=`: its value comes. */
const VALUE = 2
/** A name: its `:` or `=` comes, and then its value. */
const SIGN = 3
const NAME_ENDS = new RegExp(`(?:${NAME_WORDS})$`, 'i')
const BEARER_ENDS = /(?:^|[^A-Za-z0-9_])bearer$/i
const BEARER_TOKEN = 16
const ASSIGNED_VALUE = 8
/** The longest of `NAME_WORDS`. */
const LONGEST_NAME_WORD = 8

/** What the line from `start` to `end` leaves open, read at its end however long the line is. */
function leftOpen(text: string, start: number, end: number, check: () => void): number {
  let to = end
  while (to > start && space(text.charCodeAt(to - 1))) {
    to -= 1
    if ((to & ASK_EVERY) === 0) check()
  }
  if (to === start) return NOTHING
  let at = to - 1
  const signed = text.charCodeAt(at) === COLON || text.charCodeAt(at) === EQUALS
  if (signed) {
    at -= 1
    while (at >= start && space(text.charCodeAt(at))) {
      at -= 1
      if ((at & ASK_EVERY) === 0) check()
    }
  }
  const bare = at === to - 1
  if (at >= start && (text.charCodeAt(at) === QUOTE || text.charCodeAt(at) === APOSTROPHE)) at -= 1
  if (at < start) return NOTHING
  if (NAME_ENDS.test(text.slice(Math.max(start, at + 1 - LONGEST_NAME_WORD), at + 1))) return signed ? VALUE : SIGN
  return bare && BEARER_ENDS.test(text.slice(Math.max(start, to - 7), to)) ? TOKEN : NOTHING
}

const bearerCharacter = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
  code === 46 || code === 95 || code === 126 || code === 43 || code === SLASH || code === EQUALS || code === DASH

/** What a line left open, found after it: over any number of lines that hold nothing, at the start of the next that does. */
function carriedOver(text: string, from: number, open: number, found: SecretRange[], check: () => void): void {
  let at = from
  let state = open
  for (;;) {
    while (at < text.length && space(text.charCodeAt(at))) {
      at += 1
      if ((at & ASK_EVERY) === 0) check()
    }
    if (at >= text.length) return
    if (state !== SIGN) break
    if (text.charCodeAt(at) !== COLON && text.charCodeAt(at) !== EQUALS) return
    at += 1
    state = VALUE
  }
  let to = at
  if (state === TOKEN) while (to < text.length && bearerCharacter(text.charCodeAt(to))) to += 1
  else {
    while (to < text.length && !space(text.charCodeAt(to))) {
      to += 1
      if ((to & ASK_EVERY) === 0) check()
    }
  }
  if (to - at >= (state === TOKEN ? BEARER_TOKEN : ASSIGNED_VALUE)) found.push([at, to])
}

/** A name that says its value is a secret. */
const NAMED = /key|token|secret|password|passwd|auth|credential|cookie|private/i
/** A value that names no secret: a plain yes, no or nothing. */
const PLAIN_WORD = /^(?:true|false|null|~)$/i
/** A YAML block begins: `|`, `>`, with or without its marks, and nothing else but a comment. */
const BLOCK_BEGINS = /^[|>][+-]?[1-9]?[+-]?[ \t]*(?:#.*)?$/
/** A TOML table's header, `[name]` or `[[name]]`, with nothing after it but a comment. */
const TABLE_HEADER = /^\[{1,2}([^[\]{},=]+)\]{1,2}[ \t]*(?:#.*)?$/
/** No name is longer than this; YAML's own bound for a name written on one line. A longer one is taken to say "secret". */
const NAME_LIMIT = 1_024
/** No file nests its brackets this deep. One that does is not read further. */
const DEEPEST = 1_024
/** One unbroken run of so many letters, digits, `-`, `_`, `+` or `=` is hidden in a config file. */
const LONG_RUN = 32

/** A quoted name as it reads once its escapes are taken out: `"token"` is `token`. */
function unescaped(raw: string): string {
  if (!raw.includes('\\')) return raw
  return raw.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|U([0-9a-fA-F]{8})|([\s\S]))/g, (_all, braced?: string, four?: string, two?: string, eight?: string, other?: string) => {
    const hex = braced ?? four ?? two ?? eight
    if (hex === undefined) return other ?? ''
    const point = Number.parseInt(hex, 16)
    return point <= 0x10ffff ? String.fromCodePoint(point) : ''
  })
}

const says = (name: string): boolean => name.length > NAME_LIMIT || NAMED.test(name)

/** What a name is made of where a value is itself written as `NAME=value`: a letter, a digit, `_`, `.` or `-`. */
const nameCharacter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 46 || code === DASH

/**
 * How a file is written, as far as this reading goes.
 * - `lines`: a name stands at the start of its line and what is set in deeper belongs to it (YAML, TOML, a
 *   lock file, `.env`). Without it everything stands in brackets and a name is wherever a `:` follows (JSON).
 * - `colon`: `name: value`. In a file read by lines the colon ends the line, has a space after it or
 *   follows a quoted name.
 * - `tables`: TOML's `[table]` lines, strings between three quotes and `name = value` inside brackets.
 */
interface Dialect { lines: boolean; colon: boolean; tables: boolean }

const JSON_FILE: Dialect = { lines: false, colon: true, tables: false }
const YAML_FILE: Dialect = { lines: true, colon: true, tables: false }
const TOML_FILE: Dialect = { lines: true, colon: false, tables: true }
/** A lock file with a form of its own (`yarn.lock`, `Cargo.lock`, `composer.lock`): read as all of them at once. */
const OTHER_LOCK: Dialect = { lines: true, colon: true, tables: true }
const ENV_FILE: Dialect = { lines: true, colon: false, tables: false }

function dialectOf(path: string): Dialect {
  const name = nameOf(path)
  if (/\.jsonc?$/.test(name)) return JSON_FILE
  if (/\.ya?ml$/.test(name)) return YAML_FILE
  if (name.endsWith('.toml')) return TOML_FILE
  return OTHER_LOCK
}

/**
 * The values a file's own form says are secrets: in a `.env` file every value, in a config or lock file what
 * stands under a name that says so.
 *
 * The rule of this reading is: certain, or hidden. It follows quotes, brackets and comments character by
 * character and keeps its place over line endings, but it is no parser of any of these formats. Wherever a
 * file leaves it unsure where a value ends, it hides more and never goes on as if nothing had happened:
 * - under a name that says so, all of the value is hidden: a plain value (a plain yes, no or nothing is
 *   spared), a quoted one, everything inside its brackets whatever names stand there, and, in YAML and
 *   what is written like it, every line set in deeper below it, with whatever a quote or a bracket opened
 *   on those lines goes on to;
 * - a quoted value that goes on over a line ending is hidden whole, whatever its name: nothing tells a
 *   long value from a quote that was never closed;
 * - what follows a closed value and is neither a comma, a bracket nor a comment is hidden: inside brackets
 *   with the rest of the file, on a line of its own to the line's end;
 * - a bracket that closes nothing hides the rest of the file, and so does a quote that is never closed;
 *   a bracket that is never closed hides all that follows it where names also stand at the start of lines.
 */
class Reading {
  readonly found: SecretRange[] = []
  private readonly text: string
  private readonly n: number
  private readonly d: Dialect
  private readonly check: () => void
  /** The brackets that are open, each as the character that closes it. */
  private readonly stack: number[] = []
  private steps = 0
  private lineFrom = 0
  private lineTo = -1
  /** From where the rest of the text was hidden as uncertain; -1 while it was not. Nothing is read after that. */
  private restFrom = -1

  constructor(text: string, dialect: Dialect, check: () => void) {
    this.text = text
    this.n = text.length
    this.d = dialect
    this.check = check
  }

  /** Asks the caller now and then; called at every line and every value. */
  private tick(): void {
    this.steps += 1
    if ((this.steps & 255) === 0) this.check()
  }

  /** Where the line that holds `at` ends. Remembered, so that many values on one long line cost one search. */
  private lineEnd(at: number): number {
    if (at < this.lineFrom || at > this.lineTo) {
      const stop = this.text.indexOf('\n', at)
      this.lineFrom = at
      this.lineTo = stop < 0 ? this.n : stop
    }
    return this.lineTo
  }

  /** Past spaces, tabs and what else counts for nothing in a line, from `at` and not beyond `end`. */
  private past(at: number, end: number): number {
    const { text } = this
    let to = at
    while (to < end && blank(text.charCodeAt(to))) {
      to += 1
      if ((to & ASK_EVERY) === 0) this.check()
    }
    return to
  }

  /** Back over the same from `end`, not beyond `start`: where what a line holds ends. */
  private back(start: number, end: number): number {
    const { text } = this
    let to = end
    while (to > start && blank(text.charCodeAt(to - 1))) {
      to -= 1
      if ((to & ASK_EVERY) === 0) this.check()
    }
    return to
  }

  /** Hides `from` up to `to`, without the spaces and line endings at either end. */
  private hide(from: number, to: number): void {
    const { text } = this
    let start = from
    let end = to
    while (start < end && space(text.charCodeAt(start))) {
      start += 1
      if ((start & ASK_EVERY) === 0) this.check()
    }
    while (end > start && space(text.charCodeAt(end - 1))) {
      end -= 1
      if ((end & ASK_EVERY) === 0) this.check()
    }
    if (end > start) this.found.push([start, end])
  }

  /** How many backslashes stand right before `hit`, counted back as far as `from`: an odd number takes the character at `hit` with it. */
  private slashes(from: number, hit: number): number {
    const { text } = this
    let count = 0
    for (let back = hit - 1; back >= from && text.charCodeAt(back) === BACKSLASH; back -= 1) {
      count += 1
      if ((back & ASK_EVERY) === 0) this.check()
    }
    return count
  }

  /** Hides all from `from` on: what follows is not certain. Returns the end of the text, where nothing more is read. */
  private rest(from: number): number {
    if (this.restFrom < 0) this.restFrom = from
    this.hide(from, this.n)
    return this.n
  }

  /**
   * Where the quote that closes a string is, looked for from `from` up to `limit`; -1 when there is none.
   * A backslash takes the next character with it; in a file read by lines a single quote is written twice
   * inside single quotes instead.
   */
  private closing(from: number, limit: number, quote: number): number {
    const { text } = this
    const mark = quote === QUOTE ? '"' : "'"
    const doubled = quote === APOSTROPHE && this.d.lines
    for (let at = from; ;) {
      const hit = text.indexOf(mark, at)
      if (hit < 0 || hit >= limit) return -1
      this.tick()
      if (doubled) {
        if (hit + 1 >= limit || text.charCodeAt(hit + 1) !== APOSTROPHE) return hit
        at = hit + 2
        continue
      }
      if ((this.slashes(from, hit) & 1) === 0) return hit
      at = hit + 1
    }
  }

  /** Where the three quotes are that close a TOML string begun with three, looked for from `from`; -1 when there are none. */
  private fenced(from: number, quote: number): number {
    const { text } = this
    const fence = quote === QUOTE ? '"""' : "'''"
    for (let at = from; ;) {
      let hit = text.indexOf(fence, at)
      if (hit < 0) return -1
      this.tick()
      if (quote === QUOTE && (this.slashes(from, hit) & 1) === 1) {
        at = hit + 1
        continue
      }
      // Up to two quotes may stand before the three that close.
      for (let more = 0; more < 2 && text.charCodeAt(hit + 3) === quote; more += 1) hit += 1
      return hit
    }
  }

  /** Over spaces, line endings and comments, to what comes next. */
  private gap(from: number): number {
    const { text, n, d } = this
    let at = from
    for (;;) {
      while (at < n) {
        const code = text.charCodeAt(at)
        if (code !== SPACE && code !== LINE_END && code !== TAB && code !== RETURN && code !== BYTE_ORDER_MARK) break
        at += 1
        if ((at & ASK_EVERY) === 0) this.check()
      }
      if (at >= n) return n
      const code = text.charCodeAt(at)
      if (d.lines ? code === HASH : code === SLASH && text.charCodeAt(at + 1) === SLASH) {
        at = this.lineEnd(at)
        continue
      }
      if (!d.lines && code === SLASH && text.charCodeAt(at + 1) === STAR) {
        const close = text.indexOf('*/', at + 2)
        if (close < 0) return n
        at = close + 2
        continue
      }
      return at
    }
  }

  /** Where a value without quotes ends that begins at `from`: before a comma, a bracket, a line ending, a comment, or the `:` or `=` that makes it a name. */
  private word(from: number): number {
    const { text, n, d } = this
    let end = from
    for (let at = from; at < n; at += 1) {
      if ((at & ASK_EVERY) === 0) this.check()
      const code = text.charCodeAt(at)
      if (code === LINE_END || code === COMMA || code === CLOSE_CURLY || code === CLOSE_SQUARE || code === OPEN_CURLY || code === OPEN_SQUARE) break
      if (blank(code)) {
        // In JSON a word ends at a space; elsewhere a plain value may hold spaces.
        if (!d.lines) break
        continue
      }
      if (code === EQUALS && d.tables) break
      if (code === COLON && d.colon) {
        if (!d.lines) break
        const after = text.charCodeAt(at + 1)
        if (Number.isNaN(after) || blank(after) || after === LINE_END || after === COMMA || after === CLOSE_CURLY || after === CLOSE_SQUARE) break
      }
      if (code === HASH && d.lines && at > from && blank(text.charCodeAt(at - 1))) break
      if (code === SLASH && !d.lines && (text.charCodeAt(at + 1) === SLASH || text.charCodeAt(at + 1) === STAR)) break
      end = at + 1
    }
    return end
  }

  private named(from: number, to: number, quoted: boolean): boolean {
    if (to - from > NAME_LIMIT) return true
    const name = this.text.slice(from, to)
    return NAMED.test(quoted ? unescaped(name) : name)
  }

  /**
   * Reads what stands in brackets from `start` on. A string or a word that a `:` (or `=`) follows is a name
   * wherever it stands, with no account kept of maps and lists. With `through` the whole text is read this
   * way (JSON); without it the reading ends after the bracket that closes the one at `start`. With `secret`
   * what begins at `start` stands under a name that says so. Returns where to go on; the end of the text
   * when it is used up or its rest was hidden.
   */
  private flow(start: number, through: boolean, secret: boolean): number {
    const { text, n, d, stack } = this
    let at = start
    // A value was read and nothing has parted it from what comes next. Followed by a `:` or `=` it was a name.
    let pending = false
    let nameFrom = -1
    let nameTo = -1
    let nameQuoted = false
    // What comes next stands under a name that says so.
    let next = secret
    // Inside brackets under such a name: all of it is hidden, to the bracket that closes them.
    let hideFrom = -1
    let hideDepth = -1
    const uncertain = (where: number): number => this.rest(hideFrom >= 0 ? hideFrom : where)
    /** Whether the sign that makes a name of what ended at `after` comes next: then it is no value. */
    const signFollows = (after: number): boolean => {
      const code = text.charCodeAt(this.gap(after))
      return code === COLON ? d.colon : code === EQUALS && d.tables
    }
    for (;;) {
      at = this.gap(at)
      if (at >= n) break
      this.tick()
      const code = text.charCodeAt(at)
      if (code === COMMA) {
        pending = false
        next = false
        at += 1
        continue
      }
      if (code === COLON ? d.colon : code === EQUALS && d.tables) {
        next = pending && hideFrom < 0 && nameFrom >= 0 && this.named(nameFrom, nameTo, nameQuoted)
        pending = false
        at += 1
        continue
      }
      if (code === OPEN_CURLY || code === OPEN_SQUARE) {
        if ((pending && stack.length > 0) || stack.length >= DEEPEST) return uncertain(at)
        if (next) {
          hideFrom = at + 1
          hideDepth = stack.length
        }
        // `}` is two after `{`, and `]` two after `[`.
        stack.push(code + 2)
        pending = false
        next = false
        at += 1
        continue
      }
      if (code === CLOSE_CURLY || code === CLOSE_SQUARE) {
        if (stack.length === 0 || stack[stack.length - 1] !== code) return uncertain(at)
        stack.pop()
        if (stack.length === hideDepth) {
          this.hide(hideFrom, at)
          hideFrom = -1
          hideDepth = -1
        }
        at += 1
        if (stack.length === 0 && !through) return at
        pending = true
        nameFrom = -1
        next = false
        continue
      }
      // A value. Inside brackets one value cannot follow another: outside them (JSON, one value after another) it can.
      if (pending && stack.length > 0) return uncertain(at)
      if (code === QUOTE || code === APOSTROPHE) {
        let from = at + 1
        let width = 1
        let close: number
        let long: boolean
        if (d.tables && text.charCodeAt(at + 1) === code && text.charCodeAt(at + 2) === code) {
          from = at + 3
          width = 3
          const end = this.lineEnd(from)
          close = this.fenced(from, code)
          long = close >= end
        } else {
          close = this.closing(from, this.lineEnd(from), code)
          long = close < 0
          if (long) close = this.closing(from, n, code)
        }
        if (close < 0) return uncertain(from)
        if (hideFrom < 0 && (next || long)) this.hide(from, close)
        else if (hideFrom < 0 && width === 1 && !signFollows(close + 1)) this.assigned(from, close, false)
        nameFrom = long ? -1 : from
        nameTo = close
        nameQuoted = true
        at = close + width
      } else {
        const to = this.word(at)
        if (hideFrom < 0 && next && !(to - at <= 5 && PLAIN_WORD.test(text.slice(at, to)))) this.hide(at, to)
        else if (hideFrom < 0 && !next && !signFollows(to)) this.assigned(at, to, d.lines && d.colon)
        nameFrom = at
        nameTo = to
        nameQuoted = false
        at = Math.max(to, at + 1)
      }
      pending = true
      next = false
    }
    // The text ended inside brackets. Where names also stand at the start of lines, the lines that came
    // after a bracket nobody closed were perhaps never meant to stand in it: all of it is hidden.
    if (!through && stack.length > 0) return this.rest(hideFrom >= 0 ? hideFrom : start + 1)
    if (hideFrom >= 0) this.hide(hideFrom, n)
    return n
  }

  /**
   * A value that is itself written as `NAME=value`, as an environment list has it (`- "DB_PASSWORD=…"`,
   * `run: API_TOKEN=… make`): when the name says so, what stands after the sign is hidden. With `colon` a
   * `name:value` with nothing between counts too. The name is letters, digits, `_`, `.` and `-` and nothing else.
   */
  private assigned(from: number, to: number, colon: boolean): void {
    const { text } = this
    const limit = Math.min(to, from + NAME_LIMIT)
    for (let p = from; p < limit; p += 1) {
      const code = text.charCodeAt(p)
      if (code === EQUALS || (colon && code === COLON)) {
        // `==` ends a checksum and sets nothing.
        if (p > from && p + 1 < to && text.charCodeAt(p + 1) !== EQUALS && NAMED.test(text.slice(from, p))) this.hide(p + 1, to)
        return
      }
      if (!nameCharacter(code)) return
    }
  }

  /** Where the first `\r` stands that no `\n` follows; -1 when every line ends as `\n` or `\r\n`. */
  private loneReturn(): number {
    const { text } = this
    for (let at = text.indexOf('\r'); at >= 0; at = text.indexOf('\r', at + 1)) {
      this.tick()
      if (text.charCodeAt(at + 1) !== LINE_END) return at
    }
    return -1
  }

  /** After a quoted or bracketed value that closed at `after`, on a line of its own: what follows it and is no comment is hidden. Returns where the next line begins. */
  private afterValue(after: number): number {
    const { text } = this
    const end = this.lineEnd(after)
    let at = this.past(after, end)
    if (at < end && text.charCodeAt(at) === COMMA) at = this.past(at + 1, end)
    if (at < end && text.charCodeAt(at) !== HASH) this.hide(at, end)
    return end + 1
  }

  /** A quoted value that begins at `v`, on a line that ends at `last`. Returns where the next line begins. */
  private quoted(v: number, last: number, secret: boolean): number {
    const { text, n } = this
    const quote = text.charCodeAt(v)
    if (this.d.tables && text.charCodeAt(v + 1) === quote && text.charCodeAt(v + 2) === quote) {
      const close = this.fenced(v + 3, quote)
      if (close < 0) return this.rest(v + 3)
      if (secret || close >= last) this.hide(v + 3, close)
      return this.afterValue(close + 3)
    }
    let close = this.closing(v + 1, last, quote)
    if (close < 0) {
      close = this.closing(v + 1, n, quote)
      if (close < 0) return this.rest(v + 1)
      this.hide(v + 1, close)
    } else if (secret) this.hide(v + 1, close)
    else this.assigned(v + 1, close, false)
    return this.afterValue(close + 1)
  }

  /** A value in brackets that begins at `v`. Returns where the next line begins. */
  private bracketed(v: number, secret: boolean): number {
    const after = this.flow(v, false, secret)
    return after >= this.n ? this.n + 1 : this.afterValue(after)
  }

  /** A plain value under a name that says so, from `v` to the end of its line at `last`: without the comma that ends a line, and not a plain yes, no or nothing. */
  private plain(v: number, last: number): void {
    const { text } = this
    let to = last
    if (to > v && text.charCodeAt(to - 1) === COMMA) {
      to -= 1
      while (to > v && blank(text.charCodeAt(to - 1))) to -= 1
    }
    if (to <= v || (to - v <= 5 && PLAIN_WORD.test(text.slice(v, to)))) return
    this.found.push([v, to])
  }

  /** A file read by its lines: YAML, TOML, a lock file. */
  private byLines(): void {
    const { text, n, d } = this
    let at = 0
    // A name that says so, at this column: every line set in deeper below it is hidden. Such a line is read
    // all the same, so that a quote or a bracket it opens is followed to where it closes, however the lines
    // between are set in. Only YAML and what is written like it goes by how deep a line is set in.
    let under = -1
    // Whether lines that begin with a dash at that very column belong to it too: a list written at the column of its name.
    let dashes = false
    let from = -1
    let to = -1
    let mark = 0
    // A name at this column whose value is a block of text: deeper lines are read for a name and nothing else.
    let literal = -1
    // Inside a TOML table whose header says so: every value.
    let table = false
    const closeUnder = (): void => {
      under = -1
      if (from < 0) return
      // What was found on its lines lies inside it: one range, to the end of the text when a line of it left the rest uncertain.
      this.found.length = mark
      this.hide(from, this.restFrom >= 0 ? n : to)
      from = -1
    }
    while (at < n && this.restFrom < 0) {
      this.tick()
      const start = at
      const end = this.lineEnd(start)
      at = end + 1
      let i = this.past(start, end)
      if (i === end) continue
      const last = this.back(i, end)
      const indent = i - start
      let dashed = false
      while (text.charCodeAt(i) === DASH && (i + 1 === last || inline(text.charCodeAt(i + 1)))) {
        dashed = true
        i += 1
        while (i < last && inline(text.charCodeAt(i))) i += 1
      }
      // A comment on a line of its own ends nothing: YAML lets it stand at any column.
      const comment = !dashed && text.charCodeAt(i) === HASH
      let covered = false
      if (under >= 0) {
        covered = indent > under || (indent === under && dashes && dashed)
        if (covered) {
          if (from < 0) {
            from = start + indent
            mark = this.found.length
          }
          to = last
        } else if (!comment) closeUnder()
      }
      if (comment) continue
      if (literal >= 0 && indent <= literal) literal = -1
      if (i === last) continue
      const first = text.charCodeAt(i)
      const column = i - start
      if (literal < 0) {
        if (d.tables && !dashed && first === OPEN_SQUARE && last - i <= NAME_LIMIT) {
          const header = TABLE_HEADER.exec(text.slice(i, last))
          if (header) {
            table = says(header[1] as string)
            continue
          }
        }
        // A bracket that closes nothing, or a YAML name written as `? name` with its value on a line of its own.
        if (first === CLOSE_CURLY || first === CLOSE_SQUARE || (first === QUESTION && (i + 1 === last || inline(text.charCodeAt(i + 1))))) {
          this.rest(i)
          continue
        }
      }
      // The line's first name: what stands before its first `: ` or `=`, a quoted beginning passed over whole.
      let sign = -1
      let quoteEnd = -1
      if (first !== OPEN_CURLY && first !== OPEN_SQUARE) {
        let scan = i
        if (first === QUOTE || first === APOSTROPHE) {
          quoteEnd = this.closing(i + 1, last, first)
          scan = quoteEnd < 0 ? last : quoteEnd + 1
        }
        const limit = Math.min(last, i + NAME_LIMIT)
        // `=` makes a name only of what holds no space, as TOML and `NAME=value` write it: `integrity sha512-…==` names nothing.
        let parted = false
        let spaced = false
        for (let p = scan; p < limit; p += 1) {
          const code = text.charCodeAt(p)
          if (inline(code)) {
            spaced = true
            continue
          }
          if (code === EQUALS && !parted) {
            sign = p
            break
          }
          if (code === COLON && d.colon && (p + 1 === last || inline(text.charCodeAt(p + 1)) || (quoteEnd >= 0 && p === quoteEnd + 1))) {
            sign = p
            break
          }
          if (spaced) parted = true
        }
        // `name:value` with nothing after the colon names nothing in YAML. Where the word before it says so it is
        // taken for a name all the same: a line written like that is not certain.
        if (sign < 0 && quoteEnd < 0 && d.colon) {
          for (let p = i; p < limit && nameCharacter(text.charCodeAt(p)); p += 1) {
            if (text.charCodeAt(p + 1) === COLON) {
              if (says(text.slice(i, p + 1))) sign = p + 1
              break
            }
          }
        }
      }
      let v = i
      let secret = table
      if (sign >= 0) {
        let nameEnd = sign
        while (nameEnd > i && inline(text.charCodeAt(nameEnd - 1))) nameEnd -= 1
        secret = table || says(quoteEnd >= 0 && nameEnd === quoteEnd + 1 ? unescaped(text.slice(i + 1, quoteEnd)) : text.slice(i, nameEnd))
        v = this.past(sign + 1, last)
      } else if (literal >= 0) continue
      else if (d.tables && !d.colon) {
        // TOML has no line without a name: this is none of its lines.
        this.rest(i)
        continue
      } else if (quoteEnd >= 0 && !secret) {
        // A quoted word and more, with no name: a line of `yarn.lock`, of a longer text, or of a list (`- "NAME=value"`).
        this.assigned(i + 1, quoteEnd, false)
        continue
      }
      // What is set in deeper below this name is hidden with it. Inside what is hidden already, nothing changes.
      const deeper = secret && !covered && d.colon
      if (literal >= 0) {
        if (secret) this.plain(v, last)
        if (deeper) {
          under = column
          dashes = v >= last
        }
        continue
      }
      // YAML's marks before a value (`!!str`, `&anchor`) are passed over: what follows them is the value.
      if (d.colon) {
        while (v < last && (text.charCodeAt(v) === BANG || text.charCodeAt(v) === AMPERSAND)) {
          while (v < last && !inline(text.charCodeAt(v))) v += 1
          while (v < last && inline(text.charCodeAt(v))) v += 1
        }
      }
      if (v >= last || text.charCodeAt(v) === HASH) {
        // Nothing on this line: what is set in deeper below it is its value.
        if (deeper) {
          under = column
          dashes = true
        }
        continue
      }
      const code = text.charCodeAt(v)
      if (d.colon && (code === PIPE || code === GREATER) && last - v <= 256 && BLOCK_BEGINS.test(text.slice(v, last))) {
        literal = sign >= 0 ? column : dashed ? indent : indent - 1
        if (deeper) {
          under = column
          dashes = false
        }
        continue
      }
      if (code === QUOTE || code === APOSTROPHE) at = this.quoted(v, last, secret)
      else if (code === OPEN_CURLY || code === OPEN_SQUARE) at = this.bracketed(v, secret)
      else if (code === CLOSE_CURLY || code === CLOSE_SQUARE) this.rest(v)
      else if (secret) this.plain(v, last)
      else if (sign >= 0) this.assigned(v, last, false)
      // A value that went on over the next lines took them with it.
      if (covered && at - 1 > to) to = Math.min(n, at - 1)
      if (deeper) {
        under = column
        dashes = false
      }
    }
    closeUnder()
  }

  /** A `.env` file: every value. A line that is neither a comment nor `NAME=value` is hidden whole. */
  private env(): void {
    const { text, n } = this
    let at = 0
    while (at < n) {
      this.tick()
      const start = at
      const end = this.lineEnd(start)
      at = end + 1
      const i = this.past(start, end)
      if (i === end || text.charCodeAt(i) === HASH) continue
      const last = this.back(i, end)
      let p = i
      if (text.startsWith('export', p) && inline(text.charCodeAt(p + 6))) {
        p += 6
        while (p < last && inline(text.charCodeAt(p))) p += 1
      }
      const named = p
      for (; p < last; p += 1) {
        if ((p & ASK_EVERY) === 0) this.check()
        const code = text.charCodeAt(p)
        const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
        if (!letter && (p === named || !((code >= 48 && code <= 57) || code === 46 || code === DASH))) break
      }
      const nameEnd = p
      p = this.past(p, last)
      if (nameEnd === named || p >= last || text.charCodeAt(p) !== EQUALS) {
        this.found.push([i, last])
        continue
      }
      const v = this.past(p + 1, last)
      if (v >= last) continue
      const quote = text.charCodeAt(v)
      if (quote === QUOTE || quote === APOSTROPHE) {
        const close = this.closing(v + 1, last, quote)
        if (close < 0) {
          // A quoted value that goes on over the next lines, to the quote that closes it.
          const far = this.closing(v + 1, n, quote)
          if (far < 0) {
            this.rest(v + 1)
            return
          }
          this.hide(v + 1, far)
          at = this.afterValue(far + 1)
          continue
        }
        if (close === last - 1) {
          if (close > v + 1) this.found.push([v + 1, close])
          continue
        }
      }
      this.found.push([v, last])
    }
  }

  read(kind: SecretFileKind): SecretRange[] {
    if (kind === 'env') this.env()
    else if (this.d.lines) {
      this.byLines()
      // A line ending written as `\r` alone: where the lines end from there on is not certain.
      const lone = this.restFrom < 0 ? this.loneReturn() : -1
      if (lone >= 0) this.rest(lone)
    } else this.flow(0, true, false)
    return this.found
  }
}

/** Whether a character is one a long run is made of: a letter, a digit, `-`, `_`, `+` or `=`. */
const RUN_CHARACTER = new Uint8Array(128)
for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+=') RUN_CHARACTER[character.charCodeAt(0)] = 1

/** Every unbroken run of `LONG_RUN` or more of those characters. */
function longRuns(text: string, check: () => void): SecretRange[] {
  const found: SecretRange[] = []
  let from = -1
  for (let at = 0; at <= text.length; at += 1) {
    if ((at & ASK_EVERY) === 0) check()
    const code = text.charCodeAt(at)
    if (code < 128 && RUN_CHARACTER[code] === 1) {
      if (from < 0) from = at
    } else if (from >= 0) {
      if (at - from >= LONG_RUN) found.push([from, at])
      from = -1
    }
  }
  return found
}

/** A list in rising order of where its ranges begin. Each list is made in that order; one that is not is put in it. */
function ordered(list: SecretRange[]): SecretRange[] {
  for (let index = 1; index < list.length; index += 1) {
    if ((list[index] as SecretRange)[0] < (list[index - 1] as SecretRange)[0]) return list.sort((a, b) => a[0] - b[0])
  }
  return list
}

/** Several lists as one, in order, with ranges that touch or overlap made one. The caller is asked on the way. */
function mergedLists(lists: SecretRange[][], check: () => void): SecretRange[] {
  const sorted = lists.filter((list) => list.length > 0).map(ordered)
  const heads = sorted.map(() => 0)
  const ranges: SecretRange[] = []
  for (let taken = 0; ; taken += 1) {
    if ((taken & 4_095) === 0) check()
    let pick = -1
    let least = 0
    for (let index = 0; index < sorted.length; index += 1) {
      const head = (sorted[index] as SecretRange[])[heads[index] as number]
      if (head !== undefined && (pick < 0 || head[0] < least)) {
        pick = index
        least = head[0]
      }
    }
    if (pick < 0) break
    const [start, end] = (sorted[pick] as SecretRange[])[heads[pick] as number] as SecretRange
    heads[pick] = (heads[pick] as number) + 1
    if (end <= start) continue
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  return ranges
}

/**
 * Where the secret values of a file's text are, by the file's name (R67-NFR7): in a `.env` file every value;
 * in a config file a value whose name says so, one with a known shape, and one unbroken run of 32 or more
 * letters, digits, `-`, `_`, `+` or `=` (a lock file is spared that last part, or every checksum would go);
 * in any other text the known shapes. Under a name that says so a value is hidden whole, wherever it
 * stands and however far it goes, and where the file leaves it unsure the reading hides more: see
 * `Reading`. The work is bounded: see `SecretSearchOptions`.
 */
export function secretRanges(path: string, text: string, options: SecretSearchOptions = {}): SecretRange[] {
  const kind = secretFileKind(path)
  const check = options.check ?? ((): void => undefined)
  const reach = options.shown === undefined ? Number.POSITIVE_INFINITY : options.shown + BEYOND_SHOWN
  const keys = keyBlocks(text, check)
  const shaped: SecretRange[] = []
  const carried: SecretRange[] = []
  for (const start of linesWithShapes(text, check)) {
    const end = lineShapes(text, start, reach, shaped, check)
    const open = leftOpen(text, start, end, check)
    if (open !== NOTHING) carriedOver(text, end, open, carried, check)
  }
  if (kind === 'text') return mergedLists([keys, shaped, carried], check)
  const named = new Reading(text, kind === 'env' ? ENV_FILE : dialectOf(path), check).read(kind)
  return mergedLists([keys, shaped, carried, named, kind === 'config' ? longRuns(text, check) : []], check)
}
