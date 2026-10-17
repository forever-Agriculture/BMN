// MODULE: quick-look-secrets.test.ts - Quick look's masks on made-up values: the rule per kind of file, copy, find and the ten-second reveal (Story 67.3)
import { describe, expect, it } from 'vitest'
import { SECRET_MASK } from '@bmn/protocol'
import { findMatches } from './quick-look-find'
import {
  REVEAL_SECONDS,
  maskedSlice,
  outsideSecrets,
  quickLookSecretRanges,
  reveal,
  revealSecondsLeft,
  secretOnLine,
  viewText
} from './quick-look-secrets'

/** The hidden stretches of a made-up file, as text. */
const hidden = (path: string, text: string, canonical = path): string[] =>
  quickLookSecretRanges(path, canonical, text).map(([start, end]) => text.slice(start, end))

const RUN = 'Q7wq2ZpX9vLm4Kd8RtYb3NcF6hJs1GaE5uWx'

describe('what Quick look hides, by kind of file', () => {
  it('hides every value of a .env file', () => {
    expect(hidden('/p/.env', 'PORT=3000\n# a comment\nNAME=made-up\n')).toEqual(['3000', 'made-up'])
    expect(hidden('/p/.env.local', 'A=1\n')).toEqual(['1'])
    expect(hidden('/p/deploy/prod.env', 'A=1\n')).toEqual(['1'])
  })

  it.each(['key', 'token', 'secret', 'password', 'passwd', 'auth', 'credential', 'cookie', 'private'])('hides a config value whose name holds "%s"', (word) => {
    expect(hidden('/p/settings.json', `{ "my_${word}_here": "made-up-value", "plain": "shown" }\n`)).toEqual(['made-up-value'])
  })

  it('hides a run of 32 such characters in a config file and not one of 31, a path, or anything in a lock file', () => {
    expect(hidden('/p/config.yaml', `a: ${RUN.slice(0, 32)}\nb: ${RUN.slice(0, 31)}\nc: /usr/local/share/made-up/${RUN.slice(0, 20)}/bin\n`)).toEqual([RUN.slice(0, 32)])
    expect(hidden('/p/pnpm-lock.yaml', `integrity: ${RUN}\n`)).toEqual([])
  })

  it('hides a commit id in a config file by its length, and not in other text', () => {
    const commit = '3f786850e387550fdab836ed7e6dc881de23001b'
    expect(hidden('/p/deps.toml', `rev = "${commit}"\n`)).toEqual([commit])
    expect(hidden('/p/notes.md', `Fixed in ${commit}.\n`)).toEqual([])
  })

  it('hides known shapes in any other text, a value over several lines too', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMADEUPMADEUPMADEUP\nMADEUP\n-----END PRIVATE KEY-----'
    expect(hidden('/p/notes.md', `key:\n${pem}\nafter\n`)).toEqual([pem])
    expect(hidden('/p/app.ts', 'const name = "made-up"\n')).toEqual([])
  })

  it('goes by whichever name of a link hides more', () => {
    expect(hidden('/p/settings.txt', 'A=1\n', '/p/.env')).toEqual(['1'])
    expect(hidden('/p/.env', 'A=1\n', '/p/stored.txt')).toEqual(['1'])
  })

  it('counts a line ending as one character, as the view does', () => {
    expect(viewText('A=1\r\nB=2\rC=3\n')).toBe('A=1\nB=2\nC=3\n')
    expect(hidden('/p/.env', viewText('A=1\r\nB=22\r\n'))).toEqual(['1', '22'])
  })
})

describe('a hidden value off the screen', () => {
  // In a .env file a line that is neither a comment nor NAME=value is hidden whole, so the line between is a comment.
  const text = 'token=made-up-one\n# plain line\ntoken=made-up-two\n'
  const ranges = quickLookSecretRanges('/p/.env', '/p/.env', text)

  it('copies as "[secret hidden]", except the value that is shown', () => {
    expect(maskedSlice(text, ranges, 0, text.length)).toBe(`token=${SECRET_MASK}\n# plain line\ntoken=${SECRET_MASK}\n`)
    expect(maskedSlice(text, ranges, 0, text.length, 1)).toBe(`token=${SECRET_MASK}\n# plain line\ntoken=made-up-two\n`)
    // A selection that begins inside a value still hides all of it.
    expect(maskedSlice(text, ranges, 9, 20)).toBe(`${SECRET_MASK}\n# `)
    expect(maskedSlice(text, ranges, 18, 30)).toBe('# plain line')
  })

  it('is neither found nor counted by find, unless it is shown', () => {
    const all = findMatches(text, 'made', false)
    expect(all).toHaveLength(2)
    expect(outsideSecrets(all, ranges)).toEqual([])
    expect(outsideSecrets(all, ranges, 0)).toHaveLength(1)
    expect(outsideSecrets(findMatches(text, 'token', false), ranges)).toHaveLength(2)
    expect(outsideSecrets(findMatches(text, 'plain', false), [])).toHaveLength(1)
  })

  it('is found by the line the caret is on', () => {
    expect(secretOnLine(ranges, 0, 17)).toBe(0)
    expect(secretOnLine(ranges, 18, 30)).toBeNull()
    expect(secretOnLine(ranges, 31, 48)).toBe(1)
  })
})

describe('the reveal', () => {
  it('shows one value for ten seconds, counting down, and a second reveal replaces the first', () => {
    expect(REVEAL_SECONDS).toBe(10)
    const first = reveal(0, 1_000)
    expect(revealSecondsLeft(first, 1_000)).toBe(10)
    expect(revealSecondsLeft(first, 3_100)).toBe(8)
    expect(revealSecondsLeft(first, 11_000)).toBe(0)
    const second = reveal(1, 2_000)
    expect(second).toEqual({ index: 1, until: 12_000 })
    expect(revealSecondsLeft(null, 0)).toBe(0)
    // The sheet's clock may have been read before the reveal; the countdown still starts at ten.
    expect(revealSecondsLeft(first, 400)).toBe(10)
  })
})
