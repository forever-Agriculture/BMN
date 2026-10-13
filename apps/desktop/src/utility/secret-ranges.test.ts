// MODULE: secret-ranges.test.ts - where secret values are found in a text, by shape and by the rule that goes by a file's name (R67-NFR7), on made-up values
import { describe, expect, it } from 'vitest'
import { secretFileKind, secretRanges, secretShapeRanges } from './secret-ranges'

/** The stretches a rule hides, as text. */
const hidden = (path: string, text: string): string[] => secretRanges(path, text).map(([start, end]) => text.slice(start, end))
const RUN = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MTIzNDU2'
const OPENAI = 'sk-madeupmadeupmadeupmadeup1234'

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
})

describe('a .env file', () => {
  it('hides every value, whatever its name or shape, and nothing of a comment or a name', () => {
    const text = '# PORT=1\nPORT=5173\nexport NAME = "shop api"\nEMPTY=\nURL=http://localhost:5173/x\n'
    expect(hidden('.env', text)).toEqual(['5173', 'shop api', 'http://localhost:5173/x'])
  })
})

describe('a config file', () => {
  it('hides a value whose name says so, in JSON, YAML and TOML, and keeps the quotes and the comma', () => {
    expect(hidden('config.json', '{\n  "apiKey": "abc",\n  "port": 5173,\n  "auth_cookie": "c1"\n}\n')).toEqual(['abc', 'c1'])
    expect(hidden('config.yaml', 'provider: stripe\nwebhook_secret: whsec\n- token: t1\n')).toEqual(['whsec', 't1'])
    expect(hidden('config.toml', 'region = "eu"\nsigning_key = \'k9\'\n')).toEqual(['k9'])
  })

  it('does not hide a map, a list, a block that begins there, or a plain yes, no or nothing', () => {
    expect(hidden('package.json', '{\n  "private": true,\n  "keywords": ["a"],\n  "auth": {\n  },\n  "token": null\n}\n')).toEqual([])
    expect(hidden('a.yaml', 'private_key: |\n  line\npassword: ~\n')).toEqual([])
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
