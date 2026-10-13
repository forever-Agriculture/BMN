// MODULE: secret-ranges.test.ts - where secret values are found in a text, by shape and by the rule that goes by a file's name (R67-NFR7), wherever a value stands and however far it goes, inside bounded work; on made-up values
import { describe, expect, it } from 'vitest'
import { secretFileKind, secretRanges, secretShapeRanges } from './secret-ranges'

/** The stretches a rule hides, as text. */
const hidden = (path: string, text: string): string[] => secretRanges(path, text).map(([start, end]) => text.slice(start, end))
const RUN = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MTIzNDU2'
const OPENAI = 'sk-madeupmadeupmadeupmadeup1234'
const PEM = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', '-----END OPENSSH PRIVATE KEY-----'].join('\n')

describe('the kind of a file', () => {
  it.each([
    ['.env', 'env'], ['.env.local', 'env'], ['deploy/prod.env', 'env'],
    ['package.json', 'config'], ['tsconfig.jsonc', 'config'], ['ci/build.yaml', 'config'], ['a.yml', 'config'], ['Cargo.toml', 'config'],
    ['package-lock.json', 'lock'], ['pnpm-lock.yaml', 'lock'], ['yarn.lock', 'lock'], ['Cargo.lock', 'lock'], ['npm-shrinkwrap.json', 'lock'],
    ['README.md', 'text'], ['src/app.ts', 'text'], ['env', 'text']
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

describe('a config file', () => {
  it('hides a value whose name says so, in JSON, YAML and TOML, and keeps the quotes and the comma', () => {
    expect(hidden('config.json', '{\n  "apiKey": "abc",\n  "port": 5173,\n  "auth_cookie": "c1"\n}\n')).toEqual(['abc', 'c1'])
    expect(hidden('config.yaml', 'provider: stripe\nwebhook_secret: whsec\n- token: t1\n')).toEqual(['whsec', 't1'])
    expect(hidden('config.toml', 'region = "eu"\nsigning_key = \'k9\'\n')).toEqual(['k9'])
  })

  it('hides it wherever the name stands in a line: a map written on one line, however deep', () => {
    expect(hidden('a.json', '{"key":"abc"}')).toEqual(['abc'])
    expect(hidden('a.json', '{"a":{"key":"t1","n":1},"b":2,"cookie":c2}\n')).toEqual(['t1', 'c2'])
    expect(hidden('a.toml', 'auth = { token = "x1", user = "bob" }\n')).toEqual(['x1'])
    expect(hidden('a.yaml', 'database: { host: db, password: p-1 }\n')).toEqual(['p-1'])
  })

  it('takes nothing inside another value for a name', () => {
    expect(hidden('a.json', '{\n  "description": "use key: value, token: later",\n  "url": "https://example.test/a?b=1"\n}\n')).toEqual([])
  })

  it('hides a YAML block under such a name, every line of it', () => {
    expect(hidden('a.yaml', 'private_key: |\n  line one\n  line two\nport: 1\n')).toEqual(['line one', 'line two'])
    expect(hidden('a.yaml', 'items:\n  - secret: >-\n      abc\n\n      def\n  - name: x\n')).toEqual(['abc', 'def'])
  })

  it('hides a TOML string between three quotes, on one line or over several', () => {
    expect(hidden('a.toml', 'signing_key = """abc"""\nname = "x"\n')).toEqual(['abc'])
    expect(hidden('a.toml', 'token = """\nabc\ndef\n"""\nname = "x"\n')).toEqual(['\nabc\ndef\n'])
    expect(hidden('a.toml', "password = '''\nabc'''\n")).toEqual(['\nabc'])
  })

  it('hides a quoted value that goes on over lines set in deeper, and stops where a line is not', () => {
    expect(hidden('a.yaml', 'password: "abc\n  def"\nport: 1\n')).toEqual(['abc\n  def'])
    // A string that was never closed does not swallow what follows it.
    expect(hidden('a.json', '{\n  "token": "abc\n  "next": "v"\n}\n')).toEqual(['abc\n'])
  })

  it('hides the items of a list under such a name, on one line or below it', () => {
    expect(hidden('a.yaml', 'tokens: ["t1", \'t2\', t3]\nname: x\n')).toEqual(['t1', 't2', 't3'])
    expect(hidden('a.yaml', 'api_keys:\n  - k1\n  - k2\nother: 1\n')).toEqual(['k1', 'k2'])
    expect(hidden('a.yaml', 'tokens:\n- t1\n- t2\nname: x\n')).toEqual(['t1', 't2'])
    expect(hidden('a.json', '{\n  "tokens": [\n    "t1",\n    "t2"\n  ],\n  "n": 1\n}\n')).toEqual(['t1', 't2'])
    expect(hidden('a.yaml', 'password:\n  hunter2\nport: 1\n')).toEqual(['hunter2'])
  })

  it('leaves what stands under such a name with a name of its own to that name', () => {
    expect(hidden('a.yaml', 'auth:\n  user: bob\n  token: t9\nport: 1\n')).toEqual(['t9'])
    expect(hidden('a.yaml', 'secrets:\n  - name: db\n    password: p1\n  - name: api\n')).toEqual(['p1'])
    expect(hidden('package.json', '{\n  "auth": {\n    "user": "bob"\n  }\n}\n')).toEqual([])
  })

  it('does not hide a plain yes, no or nothing', () => {
    expect(hidden('package.json', '{\n  "private": true,\n  "token": null\n}\n')).toEqual([])
    expect(hidden('a.yaml', 'password: ~\nsecret: false\n')).toEqual([])
  })

  it('hides one unbroken run of 32 or more letters, digits, -, _, + or =, and a shorter one not', () => {
    expect(hidden('config.yaml', `checksum: ${RUN}\nshort: ${RUN.slice(0, 31)}\npath: a/b/${RUN.slice(0, 20)}/c\n`)).toEqual([RUN])
  })

  it('still hides a known shape under any name', () => {
    expect(hidden('settings.json', `{ "note": "${OPENAI}" }\n`)).toEqual([OPENAI])
  })
})

describe('a lock file', () => {
  it('is spared the rule of the long run, and keeps the other two', () => {
    const text = `{\n  "integrity": "${RUN}",\n  "authToken": "t-1",\n  "resolved": "${OPENAI}"\n}\n`
    expect(hidden('package-lock.json', text)).toEqual(['t-1', OPENAI])
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
  })

  it('asks its caller often: text made to be slow to search never runs long between two calls', () => {
    const texts = [
      'sk-'.repeat(400_000),
      `${'eyJ'.repeat(300_000)}.a.b`,
      'a-'.repeat(600_000),
      `${'-----BEGIN PRIVATE KEY-----\n'.repeat(40_000)}`,
      `${'token: "'.repeat(100_000)}`,
      'k: v\n'.repeat(400_000)
    ]
    for (const path of ['notes.txt', 'a.yaml', '.env']) {
      for (const text of texts) {
        let last = performance.now()
        let longest = 0
        const began = last
        secretRanges(path, text, { shown: 2_000, check: () => {
          const now = performance.now()
          longest = Math.max(longest, now - last)
          last = now
        } })
        longest = Math.max(longest, performance.now() - last)
        // A cancel is heard within 100 ms: no stretch between two calls comes near it, and the whole search is short.
        expect(longest).toBeLessThan(90)
        expect(performance.now() - began).toBeLessThan(1_500)
      }
    }
  })
})
