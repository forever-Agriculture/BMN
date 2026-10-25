// MODULE: secret-ranges.test.ts - where secret values are found in a text, by shape and by the rule that goes by a file's name (R67-NFR7): a value under a name that says so is hidden whole, an uncertain file hides more, and the work is bounded and can be stopped; on made-up values
import { describe, expect, it } from 'vitest'
import { secretFileKind, secretRanges, secretShapeRanges, sortedByStart, type SecretRange } from './secret-ranges'

/** The stretches a rule hides, as text. */
const hidden = (path: string, text: string): string[] => secretRanges(path, text).map(([start, end]) => text.slice(start, end))
/** The text as it may be read: every hidden stretch replaced by one mark. */
function readable(path: string, text: string, shown?: number): string {
  let out = ''
  let at = 0
  for (const [start, end] of secretRanges(path, text, shown === undefined ? {} : { shown })) {
    out += `${text.slice(at, start)}\u2022`
    at = end
  }
  return out + text.slice(at)
}
const RUN = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MTIzNDU2'
const OPENAI = 'sk-madeupmadeupmadeupmadeup1234'
const PEM = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', '-----END OPENSSH PRIVATE KEY-----'].join('\n')

describe('the kind of a file', () => {
  it.each([
    ['.env', 'env'], ['.env.local', 'env'], ['deploy/prod.env', 'env'],
    ['package.json', 'config'], ['tsconfig.jsonc', 'config'], ['ci/build.yaml', 'config'], ['a.yml', 'config'], ['Cargo.toml', 'config'],
    ['package-lock.json', 'lock'], ['pnpm-lock.yaml', 'lock'], ['yarn.lock', 'lock'], ['Cargo.lock', 'lock'], ['npm-shrinkwrap.json', 'lock'],
    ['README.md', 'text'], ['src/app.ts', 'text'], ['env', 'text'],
    ['plan/status.yaml', 'text'], ['/home/o/code/BMN/plan/status.yaml', 'text'], ['_bmad-output/implementation-artifacts/sprint-status.yaml', 'text'],
    ['other/status.yaml', 'config']
  ] as const)('%s is %s', (path, kind) => {
    expect(secretFileKind(path)).toBe(kind)
  })
})

describe('known shapes', () => {
  it('are found wherever they stand, merged and in order, with the name of an assignment kept', () => {
    const text = `first ${OPENAI} then password=hunter2hunter2 and AKIAABCDEFGHIJKLMNOP.`
    expect(secretShapeRanges(text).map(([start, end]) => text.slice(start, end))).toEqual([OPENAI, 'hunter2hunter2', 'AKIAABCDEFGHIJKLMNOP'])
  })

  it('take a private key block as one range over all its lines', () => {
    const block = '-----BEGIN PRIVATE KEY-----\nMADEUPLINEONE\nMADEUPLINETWO\n-----END PRIVATE KEY-----'
    expect(hidden('notes.txt', `before\n${block}\nafter\n`)).toEqual([block])
  })

  // The search of a file's text looks only at lines that hold the beginning of a shape. Every shape must be
  // found by it exactly as the search of a whole short text finds it.
  it.each([
    'key sk-abcdefghijklmnopqrstuvwxyz0123 here',
    'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx_yz-0',
    'id AKIAABCDEFGHIJKLMNOP.',
    'Authorization: Bearer abc.DEF-ghi_jkl~mno+pq/r=',
    'bearer 0123456789abcdefXYZ',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    'ghs_ABCDEFGHIJ_KLMNOPQRSTUVWXYZabcdefghij',
    'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ok',
    `key:\n${PEM}\ndone`,
    `key:\n${PEM.split('\n').slice(0, 2).join('\n')}`,
    'token s1.session-1.incarnation-1.0123456789abcdef0123',
    'password=hunter2hunter2',
    'OPENAI_API_KEY: abcd1234efgh',
    '{"token": "abcdefgh12345678"}',
    'apikey = 12345678',
    'secret:swordfish99',
    'PASSWD=correcthorse',
    'backupAKIAABCDEFGHIJKLMNOP',
    `AIza${'_'.repeat(10)}AIza${'B'.repeat(35)}`,
    'sk-abcdefghijklmnopqrstuvwxyz_token=abcdefgh12',
    `two lines\nfirst ${OPENAI}\nplain\nthen AKIAABCDEFGHIJKLMNOP and ${OPENAI}\n`,
    'commit 69f0fd50a5a2a390bca40e417b68e5e1a167def7 is on main',
    'tokenizer=bert-base-uncased max_tokens=4096',
    'Bearer of bad news'
  ])('are the same in a file\'s text as in a short text: %s', (text) => {
    expect(secretRanges('notes.txt', text)).toEqual(secretShapeRanges(text))
  })

  // Two shapes hold a space in their pattern and so go on over a line ending in a short text. A file's text is
  // searched line by line, and finds them all the same: over `\r\n`, over any number of empty lines, and
  // whatever stands before them.
  it.each([
    'Authorization: Bearer\nabcdefghijklmnop1234\n',
    'Authorization: Bearer\r\n\r\n   abc.DEF-ghi_jkl~mno+pq/r=  tail\r\n',
    'bearer\n\n\n\n\t0123456789abcdefXYZ',
    'Bearer\nshort\n0123456789abcdefXYZ\n',
    'xBearer\n0123456789abcdefXYZ\n',
    'password:\n  hunter2hunter2\n',
    'password:\r\n\r\n\r\n  hunter2hunter2\r\nnext\r\n',
    'the api_key =\n\n"abcdefgh12345678"\n',
    '"token":\n"abcdefgh"\n',
    'my secret\n: swordfish99\n',
    'my secret\n\n=\n\n  swordfish99 and more\n',
    'PASSWD"\n   =swordfish99\n',
    'password:\nshort\nlonger-than-eight\n',
    'token: =\nabcdefgh12345678\n',
    'token\nabcdefgh12345678\n',
    'a token\n',
    'password:',
    `${'word '.repeat(2_000)}password:\n${'\n'.repeat(300)}hunter2hunter2 ${OPENAI}\n`,
    `first ${OPENAI} and a secret:\nsk-madeupmadeupmadeupmadeup5678 Bearer\n\nabcdefghijklmnop1234 token=\nabcdefgh\n`
  ])('are found over a line ending as in a short text: %j', (text) => {
    expect(secretRanges('notes.txt', text)).toEqual(secretShapeRanges(text))
  })

  it('are found over a line ending however long the line before is, also past what is searched of it', () => {
    const far = `${'x '.repeat(40_000)}Authorization: Bearer\n\nabcdefghijklmnop1234\nthe password =\nhunter2hunter2\n`
    const read = readable('notes.txt', far, 2_000)
    expect(read).not.toContain('abcdefghijklmnop1234')
    expect(read).not.toContain('hunter2hunter2')
    expect(read).toContain('the password =')
  })
})

describe('a .env file', () => {
  it('hides every value, whatever its name or shape, and nothing of a comment or a name', () => {
    const text = '# PORT=1\nPORT=5173\nexport NAME = "shop api"\nEMPTY=\nURL=http://localhost:5173/x\nDEBUG=true\n'
    expect(hidden('.env', text)).toEqual(['5173', 'shop api', 'http://localhost:5173/x', 'true'])
  })

  it('hides a quoted value that goes on over several lines, to the quote that closes it', () => {
    expect(hidden('.env', 'CERT="line one\nline two"\nNEXT=1\n')).toEqual(['line one\nline two', '1'])
    expect(hidden('.env', "NOTE='a\n\nb'\nPORT=2\n")).toEqual(['a\n\nb', '2'])
  })
})

describe('a .env file, however it is written', () => {
  it('reads a name wherever it stands in its line, also past what is shown of it', () => {
    const text = `${' '.repeat(4_049)}CERT="first-part\nsecond-part"\nNEXT=plain\n`
    expect(hidden('.env', text)).toEqual(['first-part\nsecond-part', 'plain'])
    expect(secretRanges('.env', text, { shown: 2_000 })).toEqual(secretRanges('.env', text))
  })

  it('hides a line that is neither a comment nor NAME=value whole, and what follows a quote that closed', () => {
    expect(hidden('.env', 'just words\nexport NAME\nA=1\n')).toEqual(['just words', 'export NAME', '1'])
    // A quote that was never closed closes at the next one: what follows on that line is not certain.
    expect(readable('.env', 'A="never closed\nB="hunter2"\nC=plain\n')).toBe('A="•"•\nC=•\n')
  })

  it('hides the rest of the file after a quote that is never closed', () => {
    expect(readable('.env', "A='never closed\nB=two\nC=three\n")).toBe("A='•\n")
  })
})

describe('a config file', () => {
  it('hides a value whose name says so, in JSON, YAML and TOML, and keeps the quotes and the comma', () => {
    expect(hidden('config.json', '{\n  "apiKey": "abc",\n  "port": 5173,\n  "auth_cookie": "c1"\n}\n')).toEqual(['abc', 'c1'])
    expect(hidden('config.yaml', 'provider: stripe\nwebhook_secret: whsec\n- token: t1\n')).toEqual(['whsec', 't1'])
    expect(hidden('config.toml', 'region = "eu"\nsigning_key = \'k9\'\n')).toEqual(['k9'])
  })

  it('hides it wherever the name stands in a line: a map written on one line, however deep', () => {
    expect(hidden('a.json', '{"key":"abc"}')).toEqual(['abc'])
    expect(hidden('a.json', '{"a":{"key":"t1","n":1},"b":2,"cookie":c2}\n')).toEqual(['t1', 'c2'])
    expect(hidden('a.toml', 'server = { token = "x1", user = "bob" }\n')).toEqual(['x1'])
    expect(hidden('a.yaml', 'database: { host: db, password: p-1 }\n')).toEqual(['p-1'])
  })

  it('takes nothing inside another value for a name', () => {
    expect(hidden('a.json', '{\n  "description": "use key: value, token: later",\n  "url": "https://example.test/a?b=1"\n}\n')).toEqual([])
    expect(hidden('a.yaml', 'description: use key: value, token: later\nurl: https://example.test/a?b=1\n')).toEqual([])
    expect(hidden('a.toml', 'description = "token = later"\nat = 07:32:00\n')).toEqual([])
  })

  it('hides all that stands in brackets under such a name, whatever names stand there and wherever the brackets close', () => {
    expect(hidden('a.toml', 'auth = { token = "x1", user = "bob" }\n')).toEqual(['token = "x1", user = "bob"'])
    expect(hidden('a.yaml', 'tokens: ["t1", \'t2\', t3]\nname: x\n')).toEqual(['"t1", \'t2\', t3'])
    expect(hidden('package.json', '{\n  "auth": {\n    "user": "bob"\n  }\n}\n')).toEqual(['"user": "bob"'])
    // A list begun inside a map written on one line.
    expect(hidden('config.json', '{"tokens": [\n  "short-secret"\n]}\n')).toEqual(['"short-secret"'])
    expect(hidden('config.json', '"tokens": [\n  "short-secret"\n]\n')).toEqual(['"short-secret"'])
    // A value on the line after its name, a list whose items are not set in, a map before a plain item.
    expect(hidden('a.json', '{"token":\n"abc"}\n')).toEqual(['abc'])
    expect(hidden('a.toml', 'tokens = [\n"a",\n"b"\n]\nname = "x"\n')).toEqual(['"a",\n"b"'])
    expect(hidden('a.yaml', 'tokens: [\n"a",\n"b"\n]\nname: x\n')).toEqual(['"a",\n"b"'])
    expect(hidden('a.json', '{"tokens": [{"a": 1}, "plain"], "n": 1}\n')).toEqual(['{"a": 1}, "plain"'])
    // Brackets and quotes inside it do not end it early.
    expect(hidden('a.json', '{"keys": ["]", {"x": "}"}, [1, [2]]], "n": 1}\n')).toEqual(['"]", {"x": "}"}, [1, [2]]'])
  })

  it('reads a name written with escapes, and comments and a comma before a closing bracket in JSONC', () => {
    expect(hidden('a.json', '{"to\\u006ben": "t1", "\\u0061uth": {"a": "b"}, "pa\\x73sword": "p1", "n\\u0061me": "x"}\n')).toEqual(['t1', '"a": "b"', 'p1'])
    expect(hidden('a.yaml', '"to\\u006ben": t1\n"n\\u0061me": x\n')).toEqual(['t1'])
    expect(hidden('settings.jsonc', '{\n  // "token": "in a comment"\n  "name": "x", /* "key": "y" */\n  "token": "t1", // the "token"\n  "keys": ["a", /* ] */ "b",],\n}\n')).toEqual(['t1', '"a", /* ] */ "b",'])
  })

  it('hides every line set in deeper below such a name, whatever stands there', () => {
    expect(hidden('a.yaml', 'private_key: |\n  line one\n  line two\nport: 1\n')).toEqual(['line one\n  line two'])
    expect(hidden('a.yaml', 'items:\n  - secret: >-\n      abc\n\n      def\n  - name: x\n')).toEqual(['abc\n\n      def'])
    expect(hidden('a.yaml', 'api_keys:\n  - k1\n  - k2\nother: 1\n')).toEqual(['- k1\n  - k2'])
    expect(hidden('a.yaml', 'tokens:\n- t1\n- t2\nname: x\n')).toEqual(['- t1\n- t2'])
    expect(hidden('a.yaml', 'password:\n  hunter2\nport: 1\n')).toEqual(['hunter2'])
    expect(hidden('a.yaml', 'password: abc\n  def\nport: 1\n')).toEqual(['abc', 'def'])
    expect(hidden('a.yaml', 'auth:\n  user: bob\n  token: t9\nport: 1\n')).toEqual(['user: bob\n  token: t9'])
    expect(hidden('a.yaml', 'secrets:\n  - name: db\n    password: p1\n  - name: api\nport: 1\n')).toEqual(['- name: db\n    password: p1\n  - name: api'])
    // A name beside it, at its own column, is no part of it.
    expect(hidden('a.yaml', '- token: t1\n  user: bob\n- tokens:\n  - t2\n  user: eve\n')).toEqual(['t1', '- t2'])
    // A comment ends nothing, at whatever column it stands.
    expect(hidden('a.yaml', 'password:\n# a comment\n  hunter2\nport: 1\n')).toEqual(['hunter2'])
    // A bracket or a quote opened on such a line is followed to where it closes, however the lines between are set in.
    expect(readable('a.yaml', 'secrets:\n  list: [\n"a",\n"b"\n]\nport: 1\n')).toBe('secrets:\n  •\nport: 1\n')
    expect(readable('a.yaml', 'secrets:\n  note: "a\nb" c\n  more: m\nport: 1\n')).toBe('secrets:\n  •\nport: 1\n')
    expect(readable('a.yaml', 'secrets:\n  text: |\n    [ no list\n    "no quote\n  more: m\nport: 1\n')).toBe('secrets:\n  •\nport: 1\n')
    expect(readable('a.yaml', 'secrets:\n  list: [\n"a"\nport: 1\n')).toBe('secrets:\n  •\n')
    // TOML does not go by how deep a line is set in.
    expect(hidden('a.toml', 'api_key = "x"\n  port = 5\n')).toEqual(['x'])
    // YAML's marks before a value do not hide what the value is.
    expect(hidden('a.yaml', 'password: !!str "abc\n def"\nsecret: &s [\n"x"\n]\nvault_key: !vault |\n  3132\nport: 1\n')).toEqual(['abc\n def', '"x"', '3132'])
  })

  it('hides every value of a TOML table whose header says so, to the next header', () => {
    expect(hidden('a.toml', '[server]\nhost = "h"\n[server.auth]\nuser = "bob"\nport = 5\nlist = [\n1,\n2\n]\n[other]\nname = "x"\n')).toEqual(['bob', '5', '1,\n2'])
    expect(hidden('a.toml', '[[tokens]]\nvalue = "t1"\n[[tokens]]\nvalue = "t2"\n\n[plain] # the rest\nvalue = "v"\n')).toEqual(['t1', 't2'])
  })

  it('hides a TOML string between three quotes, on one line or over several', () => {
    expect(hidden('a.toml', 'signing_key = """abc"""\nname = "x"\n')).toEqual(['abc'])
    expect(hidden('a.toml', 'token = """\nabc\ndef\n"""\nname = "x"\n')).toEqual(['abc\ndef'])
    expect(hidden('a.toml', "password = '''\nabc'''\n")).toEqual(['abc'])
    // A quote behind a backslash closes nothing, and up to two quotes may stand before the three that close.
    expect(hidden('a.toml', 'signing_key = """a\\"""b"" """\nname = "x"\n')).toEqual(['a\\"""b""'])
    expect(hidden('a.toml', 'signing_key = """a""""\nname = "x"\n')).toEqual(['a"'])
  })

  it('hides a quoted value that goes on over a line ending, whatever its name: nothing tells it from a quote never closed', () => {
    expect(hidden('a.yaml', 'password: "abc\n  def"\nport: 1\n')).toEqual(['abc\n  def'])
    expect(hidden('a.yaml', 'title: "one\n  two"\nport: 1\n')).toEqual(['one\n  two'])
    expect(hidden('a.toml', 'about = """\nline one\nline two"""\nname = "x"\n')).toEqual(['line one\nline two'])
    // On one line it is certain, and is read.
    expect(hidden('a.toml', 'about = """one line"""\ntitle = "t"\n')).toEqual([])
    // A quote that was never closed closes at the next one: what follows there is not certain either.
    expect(readable('a.yaml', 'title: "never closed\nnext: "hunter2"\nport: 1\n')).toBe('title: "• "•\nport: 1\n')
    expect(readable('a.toml', 'title = "never closed\nnext = "hunter2"\nport = 1\n')).toBe('title = "• "•\nport = 1\n')
    expect(readable('a.toml', 'about = """never closed\nname = "x"\nlater = """\nhunter2\n"""\n')).toBe('about = """• """\n•\n')
  })

  it('hides the rest of the file where it is no longer certain what a value is', () => {
    // A string never closed, in a file where brackets hold everything.
    expect(readable('a.json', '{\n  "token": "abc\n  "next": "v",\n  "password": "p"\n}\n')).toBe('{\n  "token": "•\n  "•\n')
    expect(readable('a.json', '{\n  "name": "abc\n  "next": "v",\n  "password": "p"\n}\n')).toBe('{\n  "name": "•\n  "•\n')
    expect(readable('a.json', '{"name": "never closed, "password": 5}\n')).toBe('{"name": "never closed, "•\n')
    // A value right after a value.
    expect(readable('a.json', '{"a": "x" "password": "p"}\n')).toBe('{"a": "x" •\n')
    expect(readable('a.yaml', 'list: [a, "b" c, d]\npassword: p\n')).toBe('list: [a, "b" •\n')
    // A bracket that closes nothing, or the wrong one.
    expect(readable('a.json', '{"a": [1, 2}}, "password": "p"]\n')).toBe('{"a": [1, 2•\n')
    expect(readable('a.json', '{"a": 1}}\n{"password": "p"}\n')).toBe('{"a": 1}•\n')
    expect(readable('a.yaml', 'a: 1\n]\npassword: p\n')).toBe('a: 1\n•\n')
    expect(readable('a.yaml', 'a: }\npassword: p\n')).toBe('a: •\n')
    // A quote, three quotes or a bracket never closed.
    expect(readable('a.yaml', "a: 'never closed\npassword: p\n")).toBe("a: '•\n")
    expect(readable('a.toml', 'a = """never closed\npassword = "p"\n')).toBe('a = """•\n')
    expect(readable('a.toml', 'tokens = [\n"a",\n"b"\n')).toBe('tokens = [\n•\n')
    expect(readable('a.yaml', 'list: [a, b\nauth:\n  user: bob\n')).toBe('list: [a, b\n•\n')
    expect(readable('a.yaml', 'list: [a,\nb,\n')).toBe('list: [•\n')
    // TOML has no line without a name; YAML's `? name` puts a name where this reading does not look.
    expect(readable('a.toml', 'a = 1\njust words\npassword = "p"\n')).toBe('a = 1\n•\n')
    expect(readable('a.yaml', 'a: 1\n? password\n: p\n')).toBe('a: 1\n•\n')
    // Brackets nested deeper than any file nests them.
    expect(readable('a.json', `${'['.repeat(2_000)}"password"`)).toBe(`${'['.repeat(1_024)}•`)
  })

  it('hides what follows a closed value on its line and is no comment', () => {
    expect(readable('a.yaml', 'a: "x" password: p\nb: [1] rest\nc: "y" # said\nd: {e: 1}, # said\n')).toBe('a: "x" •\nb: [1] •\nc: "y" # said\nd: {e: 1}, # said\n')
  })

  it('reads a block of text under another name for names only: brackets and quotes in it open nothing', () => {
    const text = 'run: |\n  if [ -f x ; then echo "it\'s\n  password: abc\n  TOKEN=t1\nprivate_key: |\n  line one\nname: x\n'
    expect(hidden('ci.yaml', text)).toEqual(['abc', 't1', 'line one'])
    expect(hidden('map.yaml', 'data:\n  app.yaml: |\n    db:\n      password: p1\n      host: h\n  other: "o"\n')).toEqual(['p1'])
    expect(hidden('a.yaml', '- |\n  token: t1\n  [ not a list\n- name: x\n')).toEqual(['t1'])
  })

  it('takes NAME=value in a YAML list for a name and its value, and no name out of words with a space', () => {
    expect(hidden('compose.yaml', 'environment:\n  - POSTGRES_PASSWORD=example\n  - POSTGRES_USER=shop\n')).toEqual(['example'])
    expect(hidden('a.yaml', 'note: a token = b\n- a secret thing = x\n')).toEqual([])
  })

  it('reads a name with its escapes taken out wherever it is written: a TOML table header, a dotted name, a name partly in quotes', () => {
    expect(hidden('a.toml', '["to\\u006ben"]\nvalue = "abc"\n[other]\nn = "v"\n')).toEqual(['abc'])
    expect(hidden('a.toml', '[[a."pass\\u0077ord".b]]\nvalue = "abc"\n[other]\nn = "v"\n')).toEqual(['abc'])
    expect(hidden('a.toml', 'a."to\\u006ben" = "abc"\nn = "v"\n')).toEqual(['abc'])
    expect(hidden('a.toml', 'k = { a."to\\u006ben" = "abc", n = "v" }\n')).toEqual(['abc'])
    expect(hidden('a.yaml', '"to\\x6ben": abc\nouter:\n  "pass\\u0077ord": def\nn: v\n')).toEqual(['abc', 'def'])
    expect(hidden('Cargo.lock', '["to\\u006ben"]\nvalue = "abc"\n')).toEqual(['abc'])
  })

  it('hides what a value written as NAME=value sets when that name says so: quoted in a list, after another name, and inside brackets', () => {
    expect(hidden('compose.yaml', 'environment:\n  - "DB_PASSWORD=p1"\n  - \'APP_SECRET=s1\'\n  - "DB_USER=shop"\n')).toEqual(['p1', 's1'])
    expect(hidden('ci.yaml', 'steps:\n  - run: API_TOKEN=t1 make\n  - run: MODE=fast make\n')).toEqual(['t1 make'])
    expect(hidden('a.yaml', 'env: ["API_KEY=k1", MODE=fast, DB_PASSWORD=p1]\nargs: "--auth=basic"\n')).toEqual(['k1', 'p1', 'basic'])
    expect(hidden('a.json', '{"Env": ["PATH=/bin", "API_TOKEN=t1"], "n": "API_KEY=k1"}')).toEqual(['t1', 'k1'])
    expect(hidden('a.toml', 'args = ["DB_PASSWORD=p1", "MODE=fast"]\nrun = "API_TOKEN=t1"\n')).toEqual(['p1', 't1'])
    // A name is letters, digits, `_`, `.` and `-`: a longer text with a sign in it sets nothing, and neither does a checksum's end.
    expect(hidden('a.yaml', 'note: "the token = b"\nurl: "https://example.com/?page=2"\nsum: "sha1-keyAUTHtoken0=="\n')).toEqual([])
    // What a `:` or `=` follows is a name, whatever it holds: nothing of it is hidden.
    expect(hidden('a.json', '{"API_TOKEN=x": true, "n": 2}')).toEqual([])
  })

  it('takes name:value with nothing after the colon for a name where the word says so: YAML takes it for none, so the line is not certain', () => {
    expect(hidden('a.yaml', 'token:t1\nhost:h\nport: 1\n')).toEqual(['t1'])
    expect(hidden('a.yaml', 'list:\n  - password:p1\n  - http://example.com/token\n  - [secret:s1, plain:x]\n')).toEqual(['p1', 's1'])
    expect(hidden('a.yaml', 'image: registry.example.com:5000/app:1.2\n')).toEqual([])
  })

  it('hides all that follows a line ending written as a return alone: where the lines end from there on is not certain', () => {
    expect(readable('a.yaml', 'n: v\rtoken: t1\rm: w\r')).toBe('n: v\r•\r')
    expect(readable('a.toml', 'n = "v"\rtoken = "t1"\r')).toBe('n = "v"\r•\r')
    // `\r\n` is a line ending like any other, also at the end of the text.
    expect(readable('a.yaml', 'n: v\r\ntoken: t1\r\nm: w\r\n')).toBe('n: v\r\ntoken: •\r\nm: w\r\n')
    expect(readable('a.yaml', 'n: v\r')).toBe('n: v\r')
  })

  it('does not hide a plain yes, no or nothing', () => {
    expect(hidden('package.json', '{\n  "private": true,\n  "token": null\n}\n')).toEqual([])
    expect(hidden('a.yaml', 'password: ~\nsecret: false\n')).toEqual([])
  })

  it('reads one value after another where brackets hold everything, and a file that begins with a byte order mark', () => {
    expect(hidden('log.json', '{"a": 1}\n{"token": "t1"}\n{"b": [2]}\n["c"]\n"d"\n{"key": "k1"}\n')).toEqual(['t1', 'k1'])
    expect(hidden('a.json', '﻿{"token": "t1"}\n')).toEqual(['t1'])
  })

  it('hides one unbroken run of 32 or more letters, digits, -, _, + or =, and a shorter one not', () => {
    expect(hidden('config.yaml', `checksum: ${RUN}\nshort: ${RUN.slice(0, 31)}\npath: a/b/${RUN.slice(0, 20)}/c\n`)).toEqual([RUN])
    expect(hidden('config.yaml', `${RUN}\n${RUN}.${RUN.slice(0, 32)} ${RUN.slice(0, 31)}`)).toEqual([RUN, RUN, RUN.slice(0, 32)])
  })

  it('never hides a long name, only a long value (owner 2026-10-18: story names shown as dots)', () => {
    const slug = '77-4-drafts-for-installed-skills-and-agents'
    expect(hidden('board.yaml', `development_status:\n  ${slug}: done # note\n  ${slug}:\n    nested: ${RUN}\n`)).toEqual([RUN])
    expect(hidden('a.json', `{"${slug}": "done", "x": "${RUN}"}`)).toEqual([RUN])
    expect(hidden('a.toml', `${slug} = "done"\nvalue = "${RUN}"\n`)).toEqual([RUN])
    // A value followed by a colon that does not end it as a name stays hidden.
    expect(hidden('a.yaml', `host: ${RUN}:8080\n`)).toEqual([RUN])
  })

  it('reads a planning board as text: story names and their notes stay readable, known shapes still hide', () => {
    const board = `development_status:\n  34-2-hide-secret-shaped-text-sent-to-telegram: done\n  55-3-browse-waiting-requests-with-arrow-keys: done # keys\n  x: ${RUN}\n  y: ${OPENAI}\n`
    expect(hidden('plan/status.yaml', board)).toEqual([OPENAI])
    expect(hidden('elsewhere/status.yaml', board)).not.toEqual([OPENAI])
  })

  it('still hides a known shape under any name', () => {
    expect(hidden('settings.json', `{ "note": "${OPENAI}" }\n`)).toEqual([OPENAI])
  })
})

// A file of JSON made from a seed, written four ways, read back by JSON.parse: that says which values stand
// under a name that says "secret", however deep. None of those may be readable, and every other one must be.
describe('JSON made from a seed', () => {
  // The first four are also words of the known shapes, which hide on their own whatever follows such a name
  // up to the next space: with them in a file, a value beside a secret can be hidden too.
  const SECRET_NAMES = ['token', 'apiKey', 'client_secret', 'PASSWORD', 'auth', 'cookies', 'private', 'credentials', 'signing_key', 'Keys']
  const PLAIN_NAMES = ['name', 'port', 'items', 'hosts', 'retries', 'mode', 'tags', 'region']
  const says = /key|token|secret|password|passwd|auth|credential|cookie|private/i

  function seeded(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
    }
  }

  function made(random: () => number, depth: number, next: { id: number; names: readonly string[] }): unknown {
    const roll = random()
    if (depth >= 5 || roll < 0.45) {
      next.id += 1
      if (roll < 0.25) return `v${next.id}q`
      if (roll < 0.35) return 7_000_000 + next.id
      return [true, false, null][Math.floor(random() * 3)]
    }
    const size = Math.floor(random() * 4)
    if (roll < 0.65) return Array.from({ length: size }, () => made(random, depth + 1, next))
    const map: Record<string, unknown> = {}
    for (let index = 0; index <= size; index += 1) {
      const names = random() < 0.35 ? next.names : PLAIN_NAMES
      map[`${names[Math.floor(random() * names.length)] as string}${random() < 0.5 ? '' : `_${index}`}`] = made(random, depth + 1, next)
    }
    return map
  }

  /** Every string and number of a value, sorted by whether a name above it says "secret". */
  function sorted(value: unknown, below: boolean, into: { secret: string[]; plain: string[] }): void {
    if (typeof value === 'string' || typeof value === 'number') (below ? into.secret : into.plain).push(String(value))
    else if (Array.isArray(value)) for (const item of value) sorted(item, below, into)
    else if (value !== null && typeof value === 'object') for (const [name, item] of Object.entries(value)) sorted(item, below || says.test(name), into)
  }

  it('hides every value under a name that says so and no other, on one line, set in, not set in and with \\r\\n, with names written with escapes', () => {
    let secrets = 0
    let plains = 0
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seeded(seed)
      // Half the seeds keep to names no known shape goes by: there every other value must be readable.
      const exact = seed % 2 === 0
      const names = exact ? SECRET_NAMES.slice(4) : SECRET_NAMES
      const value = { root: made(random, 0, { id: seed * 1_000, names }), list: made(random, 1, { id: seed * 1_000 + 500, names }) }
      // One character of some names is written as an escape.
      const escaped = (text: string): string => text.replace(/"([A-Za-z_0-9]+)"(?=\s*:)/g, (all, name: string) => {
        if (random() < 0.6) return all
        const at = Math.floor(random() * name.length)
        return `"${name.slice(0, at)}\\u${name.charCodeAt(at).toString(16).padStart(4, '0')}${name.slice(at + 1)}"`
      })
      const setIn = escaped(JSON.stringify(value, null, 2))
      const written = {
        'on one line': escaped(JSON.stringify(value)),
        'set in': setIn,
        'not set in': setIn.split('\n').map((line) => line.trimStart()).join('\n'),
        'with \\r\\n': setIn.replaceAll('\n', '\r\n')
      }
      const expected = { secret: [] as string[], plain: [] as string[] }
      sorted(value, false, expected)
      secrets += expected.secret.length
      plains += expected.plain.length
      for (const [how, text] of Object.entries(written)) {
        expect(JSON.parse(text), `seed ${seed} ${how}`).toEqual(value)
        // The same text in a file read as JSON, as YAML and as a lock file of a form of its own.
        for (const path of ['made.json', 'made.yaml', 'made.lock']) {
          const read = readable(path, text)
          for (const marker of expected.secret) {
            if (read.includes(marker)) throw new Error(`seed ${seed}, ${how}, ${path}: ${marker} is readable in\n${text}`)
          }
          for (const marker of exact ? expected.plain : []) {
            if (!read.includes(marker)) throw new Error(`seed ${seed}, ${how}, ${path}: ${marker} is hidden in\n${text}`)
          }
        }
      }
    }
    // The seeds made plenty of both.
    expect(secrets).toBeGreaterThan(500)
    expect(plains).toBeGreaterThan(500)
  })
})

describe('a lock file', () => {
  it('is spared the rule of the long run, and keeps the other two', () => {
    const text = `{\n  "integrity": "${RUN}",\n  "authToken": "t-1",\n  "resolved": "${OPENAI}"\n}\n`
    expect(hidden('package-lock.json', text)).toEqual(['t-1', OPENAI])
  })

  it('is read in its own form, whichever that is, and a checksum that ends in = names nothing', () => {
    const yarn = `# yarn lockfile v1\n\n"@scope/a@^1.0.0", "@scope/a@^1.1.0":\n  version "1.1.0"\n  resolved "https://registry.example/a/-/a-1.1.0.tgz#f4ad435a"\n  integrity sha512-${RUN}Key+token/x==\n  dependencies:\n    "@scope/b" "^2.0.0"\n\nb@^2.0.0:\n  version "2.0.0"\n`
    expect(hidden('yarn.lock', yarn)).toEqual([])
    const cargo = '# made by Cargo\nversion = 3\n\n[[package]]\nname = "a"\nchecksum = "b2969dcb958b36655471fc61f7e416fa76033bdd4bfed0678d9fee1e2ed7a1c0"\ndependencies = [\n "b",\n]\n\n[package.auth]\nuser = "bob"\n'
    expect(hidden('Cargo.lock', cargo)).toEqual(['bob'])
    const composer = '{\n    "content-hash": "0123",\n    "packages": [\n        {\n            "name": "a/b",\n            "authToken": "t-1",\n            "require": {"php": ">=8.1"}\n        }\n    ]\n}\n'
    expect(hidden('composer.lock', composer)).toEqual(['t-1'])
    const pnpm = `lockfileVersion: '9.0'\npackages:\n  'a@1.0.0':\n    resolution: {integrity: sha512-${RUN}==}\n    engines: {node: '>=18'}\n  'js-tokens@4.0.0':\n    resolution: {integrity: sha512-${RUN}==}\nsnapshots: {}\n`
    // A package whose name holds one of the words is a name that says so, and all it holds is hidden.
    expect(hidden('pnpm-lock.yaml', pnpm)).toEqual([`resolution: {integrity: sha512-${RUN}==}`])
  })
})

describe('every other text', () => {
  it('hides known shapes only', () => {
    expect(hidden('README.md', `checksum: ${RUN}\napi_key: short\nkey ${OPENAI}\n`)).toEqual([OPENAI])
  })
})

describe('bounded work', () => {
  it('searches a line as far as it is shown and a little beyond, and hides a token the search stops in', () => {
    const text = `${'word '.repeat(4)}${'B'.repeat(6_000)} tail ${OPENAI}\nnext ${OPENAI}\n`
    const ranges = secretRanges('notes.txt', text, { shown: 100 })
    // The run the search stopped in, from where it begins; nothing of the line beyond the search; the next line as ever.
    const second = text.indexOf('\n') + 1 + 'next '.length
    expect(ranges).toEqual([[20, 100 + 2_048], [second, second + OPENAI.length]])
  })

  it('hides a value that begins in what is shown and runs past the search', () => {
    const text = `x sk-${'a'.repeat(9_000)}\n`
    expect(secretRanges('notes.txt', text, { shown: 50 })).toEqual([[2, 50 + 2_048]])
    const jwt = `x eyJ${'a'.repeat(9_000)}.b.c\n`
    expect(secretRanges('notes.txt', jwt, { shown: 50 })).toEqual([[2, 50 + 2_048]])
  })

  it('is stopped by its caller between lines and between matches', () => {
    let calls = 0
    const check = (): void => {
      calls += 1
      if (calls > 3) throw new Error('stopped')
    }
    expect(() => secretRanges('notes.txt', `${OPENAI}\n`.repeat(50), { check })).toThrow('stopped')
    calls = 0
    expect(() => secretRanges('a.yaml', 'name: x\n'.repeat(5_000), { check })).toThrow('stopped')
    // Every loop over a text or a line asks: a key block with many lines that begin like its end and are none, a
    // token after `Bearer` on the line before, comments one after another, YAML's marks before a value, list
    // dashes one after another, lines that begin like a shape and hold none, and a value with space before its comma.
    const slow: Array<[string, string]> = [
      ['notes.txt', `-----BEGIN PRIVATE KEY-----\n${'-----END \n'.repeat(5_000)}`],
      ['notes.txt', `Authorization: Bearer\n${'a'.repeat(2_000_000)}`],
      ['a.json', `{${'/**/'.repeat(5_000)}"a": 1}`],
      ['a.jsonc', `${'// c\n'.repeat(5_000)}{"a": 1}`],
      ['a.yaml', `k: ${'!a '.repeat(200_000)}v`],
      ['a.yaml', `${'- '.repeat(5_000)}v`],
      ['notes.txt', 'token\n'.repeat(5_000)],
      ['a.yaml', `token: x${' '.repeat(2_000_000)},`],
      ['.env', `export${' '.repeat(2_000_000)}A=b`]
    ]
    for (const [path, text] of slow) {
      // Asked many times on the way, not only between the parts of the search.
      let asked = 0
      secretRanges(path, text, { check: () => void (asked += 1) })
      expect(asked, `${path}: ${text.slice(0, 24)}`).toBeGreaterThan(12)
    }
  })

  it('puts a list that is not in order into it, asking its caller on the way', () => {
    let state = 7
    const next = (): number => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648)
    const list: SecretRange[] = Array.from({ length: 20_000 }, () => {
      const start = next() % 1_000_000
      return [start, start + 1 + (next() % 50)]
    })
    let calls = 0
    const sorted = sortedByStart([...list], () => void (calls += 1))
    expect(sorted.map((range) => range[0])).toEqual([...list].sort((a, b) => a[0] - b[0]).map((range) => range[0]))
    expect(sorted).toHaveLength(list.length)
    expect(calls).toBeGreaterThan(20)
    expect(sortedByStart([], () => undefined)).toEqual([])
    expect(sortedByStart([[3, 4]], () => undefined)).toEqual([[3, 4]])
  })

  it('reads a run of any length, and brackets nested however deep, without running out of stack', () => {
    const run = 'k'.repeat(10 * 1024 * 1024)
    expect(secretRanges('a.yaml', run, { shown: 2_000 })).toEqual([[0, run.length]])
    expect(secretRanges('.env', `A=${run}`, { shown: 2_000 })).toEqual([[2, run.length + 2]])
    expect(secretRanges('a.json', `{"a": ${'['.repeat(3_000_000)}`, { shown: 2_000 })).toEqual([[6 + 1_023, 6 + 3_000_000]])
  })

  it('reads one line of 8 MiB to its end, whatever the line holds and however its file is read', () => {
    const size = 8 * 1024 * 1024
    const lines = [
      `{"a": "${'x'.repeat(size)}`,
      `${' '.repeat(size)}token: abcdefgh`,
      '"a",'.repeat(size / 4),
      `"${'\\'.repeat(size)}"`,
      'token: "'.repeat(size / 8),
      `password:\n${'\n'.repeat(size)}hunter2hunter2`,
      'toke secre passwor beare api_ke '.repeat(size / 32)
    ]
    for (const path of ['notes.txt', 'a.json', 'a.yaml', 'a.toml', '.env', 'yarn.lock']) {
      for (const [index, text] of lines.entries()) {
        expect(() => secretRanges(path, text, { shown: 2_000 }), `${path}, line ${index}`).not.toThrow()
      }
    }
  }, 60_000)

  it('asks its caller often: text made to be slow to search never runs long between two calls', () => {
    const texts = [
      'sk-'.repeat(400_000),
      `${'eyJ'.repeat(300_000)}.a.b`,
      'a-'.repeat(600_000),
      `${'-----BEGIN PRIVATE KEY-----\n'.repeat(40_000)}`,
      `${'token: "'.repeat(100_000)}`,
      'k: v\n'.repeat(400_000),
      'KEY=value\n'.repeat(200_000),
      `{"a": "${'x'.repeat(2_000_000)}`,
      `${' '.repeat(2_000_000)}token: abcdefgh`,
      `"${'\\'.repeat(2_000_000)}"`,
      `${'['.repeat(1_000)}${'"a",'.repeat(400_000)}`,
      `password:\n${'\n'.repeat(2_000_000)}hunter2hunter2`,
      `-----BEGIN PRIVATE KEY-----\n${'-----END \n'.repeat(200_000)}`,
      `Authorization: Bearer\n${'a'.repeat(2_000_000)}`,
      `{${'/**/'.repeat(500_000)}"a": 1}`,
      `${'// c\n'.repeat(400_000)}{"a": 1}`,
      `k: ${'!a '.repeat(700_000)}v`,
      `${'- '.repeat(1_000_000)}v`,
      'token\n'.repeat(350_000),
      `token: x${' '.repeat(2_000_000)},`
    ]
    for (const path of ['notes.txt', 'a.json', 'a.yaml', 'a.toml', '.env', 'yarn.lock']) {
      for (const text of texts) {
        // Each stretch is timed in this thread's CPU time, the search's own work: on a busy machine the wall clock
        // also counts the time other processes had the CPU, which no call to the caller shortens (Story 91.6).
        const work = (): number => { const used = process.threadCpuUsage(); return (used.user + used.system) / 1000 }
        let last = work()
        let longest = 0
        const began = performance.now()
        secretRanges(path, text, { shown: 2_000, check: () => {
          const now = work()
          longest = Math.max(longest, now - last)
          last = now
        } })
        longest = Math.max(longest, work() - last)
        // A cancel is heard within 100 ms: no stretch between two calls comes near it, and the whole search is short.
        expect(longest).toBeLessThan(90)
        expect(performance.now() - began).toBeLessThan(1_500)
      }
    }
  }, 60_000)
})

describe('one long line, read once', () => {
  /** A seeded line of pieces that begin, end, overlap and nearly make the shapes. */
  const PIECES = ['password', 'PASSWORD', 'token', 'apikey', 'api_key', 'secret', 'passwd', '=', ':', ':=', ' ', '  ', '\t', '"', "'", 'madeupab', 'xy', '-', '--', '_', 'sk-',
    'aaaaaaaaaaaaaaaaaaaaaaaa', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'xoxp-', 'eyJ', 'eyJaa', '.', '.aa', '.bb', 'Bearer ', 's1.', '0123456789abcdef', 'AKIA',
    'AIza', 'ABCDEFGHIJKLMNOP', '#', '{', '}', ',', 'é', 'x']
  function seeded(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state
    }
  }

  it('hides what a search one character on from each match of each shape hides (the shapes of a Telegram card)', () => {
    const next = seeded(67)
    for (let index = 0; index < 4_000; index += 1) {
      let line = ''
      for (let length = 1 + (next() % 30); length > 0; length -= 1) line += PIECES[next() % PIECES.length]
      expect(secretRanges('/p/notes.md', line), JSON.stringify(line)).toEqual(secretShapeRanges(line))
    }
  })

  it('finds a value an embedded name leads to over a blank, and a token whose later header reaches past the first', () => {
    const embedded = 'token=madeupabpassword = madeupvalue2'
    expect(hidden('/p/notes.md', embedded)).toEqual(['madeupabpassword', 'madeupvalue2'])
    const reaching = 'eyJaa.bb.cceyJdd.ee.ff'
    expect(secretRanges('/p/notes.md', reaching)).toEqual(secretShapeRanges(reaching))
    expect(hidden('/p/notes.md', reaching)).toEqual([reaching])
  })

  it('takes tens of milliseconds, not minutes, for a line of a megabyte made of one shape again and again', () => {
    const megabyte = (unit: string): string => unit.repeat(Math.floor(1_048_576 / unit.length))
    for (const unit of ['"password":"x",', 'token=', `sk-${'a'.repeat(24)}`, `ghp_${'a'.repeat(36)}`, `xoxb-${'a'.repeat(10)}`, 'eyJaa', 'eyJaa.aa.bb']) {
      const text = megabyte(unit)
      for (const path of ['/p/notes.md', '/p/settings.json']) {
        const started = performance.now()
        secretRanges(path, text)
        // Read a character at a time once more per name, as before, this took from seconds to minutes.
        expect(performance.now() - started, `${unit} in ${path}`).toBeLessThan(1_500)
      }
    }
  })
})
