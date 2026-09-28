// MODULE: secret-mask.test.ts - the secret shapes hidden on text sent to Telegram, and what stays readable (Story 34.2)
import { describe, expect, it } from 'vitest'
import { SECRET_MASK, maskSecrets } from './secret-mask'

// Synthetic values in each shape; none is a real credential.
const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----'
].join('\n')

describe('maskSecrets', () => {
  it.each([
    ['an sk- key', 'key sk-abcdefghijklmnopqrstuvwxyz0123 here', `key ${SECRET_MASK} here`],
    ['an sk-ant- key', 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx_yz-0', `use ${SECRET_MASK}`],
    ['an sk-proj- key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345', SECRET_MASK],
    ['an AWS access key id', 'id AKIAABCDEFGHIJKLMNOP.', `id ${SECRET_MASK}.`],
    ['a bearer token', 'Authorization: Bearer abc.DEF-ghi_jkl~mno+pq/r=', `Authorization: Bearer ${SECRET_MASK}`],
    ['a lower-case bearer token', 'bearer 0123456789abcdefXYZ', `bearer ${SECRET_MASK}`],
    ['a classic GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', SECRET_MASK],
    ['a GitHub OAuth token', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12', SECRET_MASK],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', SECRET_MASK],
    ['a Slack token', 'xoxb-1234567890-abcdefghij', SECRET_MASK],
    ['a Google API key', 'AIzaSyA-1234567890abcdefghijklmnopqrstu', SECRET_MASK],
    ['a JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ok', `jwt ${SECRET_MASK} ok`],
    ['a PEM private key', `key:\n${PEM}\ndone`, `key:\n${SECRET_MASK}\ndone`],
    ['a PEM private key cut short', `key:\n${PEM.split('\n').slice(0, 2).join('\n')}`, `key:\n${SECRET_MASK}`],
    ['a BMN session token', 'token s1.session-1.incarnation-1.0123456789abcdef0123', `token ${SECRET_MASK}`],
    ['a password assignment', 'password=hunter2hunter2', `password=${SECRET_MASK}`],
    ['an API key assignment with a prefix', 'OPENAI_API_KEY: abcd1234efgh', `OPENAI_API_KEY: ${SECRET_MASK}`],
    ['a quoted JSON token', '{"token": "abcdefgh12345678"}', `{"token": ${SECRET_MASK}`],
    ['an apikey assignment', 'apikey = 12345678', `apikey = ${SECRET_MASK}`],
    ['a secret assignment', 'secret:swordfish99', `secret:${SECRET_MASK}`],
    ['a passwd assignment', 'PASSWD=correcthorse', `PASSWD=${SECRET_MASK}`]
  ])('hides %s', (_label, text, masked) => {
    expect(maskSecrets(text)).toBe(masked)
  })

  it.each([
    ['a 40-hex git SHA', 'commit 69f0fd50a5a2a390bca40e417b68e5e1a167def7 is on main'],
    ['a UUID', 'session 01a0b657-21a8-7f00-addd-b73646828f5b started'],
    ['a short token value', 'token: 5'],
    ['a path', 'see secrets/readme.md for the setup'],
    ['ordinary prose', 'Should I keep the token refresh logic, or is the secret rotation enough?'],
    ['a longer name that ends elsewhere', 'tokenizer=bert-base-uncased max_tokens=4096'],
    ['a short bearer word', 'Bearer of bad news'],
    ['sk- inside a word', 'task-abcdefghijklmnopqrstuvwxyz'],
    ['an emoji and right-to-left text', 'שלום \u{1F468}‍\u{1F469} مرحبا']
  ])('keeps %s', (_label, text) => {
    expect(maskSecrets(text)).toBe(text)
  })
})
