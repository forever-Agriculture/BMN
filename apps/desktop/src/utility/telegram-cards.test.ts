// MODULE: telegram-cards.test.ts - the Telegram cards checked against the Story 30.3 mock-ups, the escaper and the length rule
import { describe, expect, it } from 'vitest'
import type { AttentionPermissionPrompt, AttentionQuestionsPrompt } from '@bmn/protocol'
import {
  TELEGRAM_TEXT_LIMIT,
  clip,
  endedCard,
  endingLine,
  endingReply,
  escapeHtml,
  exitCard,
  noticeCard,
  permissionCard,
  plainText,
  questionCard,
  requestCard,
  type CardHeader
} from './telegram-cards'

const CLAUDE: CardHeader = { session: 'api-server', agent: 'claude', flag: '🇺🇸' }

const AUTH = {
  id: null,
  header: 'Auth method',
  text: 'Which auth method should the API use?',
  multiSelect: false,
  options: [
    { label: 'JWT', description: 'Stateless tokens, no session store.' },
    { label: 'Session cookies', description: 'Server-side sessions in Redis.' },
    { label: 'OAuth only', description: 'Delegate sign-in to Google and GitHub.' }
  ]
}
const DATABASE = {
  id: null,
  header: 'Database',
  text: 'Which database should store users?',
  multiSelect: false,
  options: [
    { label: 'Postgres', description: 'Already used by the billing service.' },
    { label: 'SQLite', description: 'One file, no server to run.' }
  ]
}
const TESTS = {
  id: null,
  header: 'Tests',
  text: 'Add integration tests now?',
  multiSelect: false,
  options: [{ label: 'Yes', description: null }, { label: 'Later', description: null }]
}

function questions(...list: AttentionQuestionsPrompt['questions']): AttentionQuestionsPrompt {
  return { type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_1', questions: list }
}

const BASH: AttentionPermissionPrompt = {
  type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null,
  tool: 'Bash', command: 'pnpm test --filter api', cwd: '/home/owner/code/api'
}

describe('escaping and clipping', () => {
  it('escapes the three characters Telegram HTML reserves, and nothing else', () => {
    expect(escapeHtml('<b>a & b</b> "q" \'s\'')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt; "q" \'s\'')
  })

  it('clips by characters with an ellipsis and never splits an emoji', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('turns a card back into plain words for the fallback', () => {
    expect(plainText('<b>a &lt;tag&gt; &amp; b</b>\n<i>x</i>')).toBe('a <tag> & b\nx')
  })

  it('escapes every agent string on the card, including the session name and labels', () => {
    const card = questionCard({
      header: { session: '<evil>&', agent: 'codex', flag: null },
      prompt: questions({ ...AUTH, header: '<h>', text: 'Pick <one> & go', options: [{ label: '<script>', description: 'a&b' }] }),
      step: 0,
      chosen: [],
      tokens: ['t1']
    })
    expect(card.text).toBe([
      '❓ <b>&lt;evil&gt;&amp;</b> · Codex',
      '<i>&lt;h&gt;</i>',
      '',
      '<b>Pick &lt;one&gt; &amp; go</b>',
      '',
      '<b>1. &lt;script&gt;</b>',
      'a&amp;b'
    ].join('\n'))
    expect(card.keyboard).toEqual([[{ text: '1 · <script>', callback_data: 't1' }]])
  })
})

describe('the mock-ups (Fable consult, epics.md Story 30.3)', () => {
  it('1. a single question, one button per row because the labels are long', () => {
    const card = questionCard({ header: CLAUDE, prompt: questions(AUTH), step: 0, chosen: [], tokens: ['a', 'b', 'c'] })
    expect(card.text).toBe(`❓ <b>api-server</b> · Claude 🇺🇸
<i>Auth method</i>

<b>Which auth method should the API use?</b>

<b>1. JWT</b>
Stateless tokens, no session store.

<b>2. Session cookies</b>
Server-side sessions in Redis.

<b>3. OAuth only</b>
Delegate sign-in to Google and GitHub.`)
    expect(card.keyboard).toEqual([
      [{ text: '1 · JWT', callback_data: 'a' }],
      [{ text: '2 · Session cookies', callback_data: 'b' }],
      [{ text: '3 · OAuth only', callback_data: 'c' }]
    ])
  })

  it('2. step 2 of 3 quotes the earlier answer and keeps short buttons on one row', () => {
    const card = questionCard({
      header: CLAUDE, prompt: questions(AUTH, DATABASE, TESTS), step: 1, chosen: ['JWT'], tokens: ['p', 's']
    })
    expect(card.text).toBe(`❓ <b>api-server</b> · Claude 🇺🇸
<i>Question 2 of 3 · Database</i>

<blockquote>Auth method: <b>JWT</b></blockquote>

<b>Which database should store users?</b>

<b>1. Postgres</b>
Already used by the billing service.

<b>2. SQLite</b>
One file, no server to run.`)
    expect(card.keyboard).toEqual([[{ text: '1 · Postgres', callback_data: 'p' }, { text: '2 · SQLite', callback_data: 's' }]])
  })

  it('2. the last step says nothing is sent until it is answered', () => {
    const card = questionCard({
      header: CLAUDE, prompt: questions(AUTH, DATABASE, TESTS), step: 2, chosen: ['JWT', 'Postgres'], tokens: ['y', 'l']
    })
    expect(card.text).toContain('<blockquote>Auth method: <b>JWT</b>\nDatabase: <b>Postgres</b></blockquote>')
    expect(card.text.endsWith('<b>2. Later</b>\n\n<i>Nothing is sent until this answer.</i>')).toBe(true)
  })

  it('3. a permission with phone answers on shows what runs and where, with Allow once and Deny on one row', () => {
    const card = permissionCard({
      header: CLAUDE, prompt: BASH, tokens: { allow: 'al', deny: 'de' }, closedBecause: null, home: '/home/owner'
    })
    expect(card.text).toBe(`🔐 <b>api-server</b> · Claude 🇺🇸
<i>Wants to run a command</i>

<pre>pnpm test --filter api</pre>
in <code>~/code/api</code>`)
    expect(card.keyboard).toEqual([[{ text: 'Allow once', callback_data: 'al' }, { text: 'Deny', callback_data: 'de' }]])
  })

  it('3. offers no Deny when a deny would answer more than this request', () => {
    const card = permissionCard({ header: CLAUDE, prompt: BASH, tokens: { allow: 'al', deny: null }, closedBecause: null, home: null })
    expect(card.keyboard).toEqual([[{ text: 'Allow once', callback_data: 'al' }]])
    expect(card.text).toContain('in <code>/home/owner/code/api</code>')
  })

  it('4. a permission with phone answers off says to answer at the laptop and has no buttons', () => {
    const card = permissionCard({ header: CLAUDE, prompt: BASH, tokens: null, closedBecause: 'permissions-off', home: '/home/owner' })
    expect(card.text).toBe(`🔐 <b>api-server</b> · Claude 🇺🇸
<i>Wants to run a command</i>

<pre>pnpm test --filter api</pre>
in <code>~/code/api</code>

<i>Answer this at the laptop.</i>`)
    expect(card.keyboard).toBeNull()
  })

  it('5. every outcome replaces the options under the question, and only confirmed answers carry a tick', () => {
    const base = questionCard({ header: CLAUDE, prompt: questions(AUTH), step: 0, chosen: [], tokens: ['a', 'b', 'c'] }).base
    expect(endedCard(base, { type: 'outcome', outcome: { state: 'confirmed', sent: ['JWT'] }, permission: false }))
      .toBe(`❓ <b>api-server</b> · Claude 🇺🇸
<b>Which auth method should the API use?</b>

✓ <i>Sent: JWT</i>`)
    const line = (ending: Parameters<typeof endingLine>[0]): string => endingLine(ending)
    expect(line({ type: 'outcome', outcome: { state: 'sent-unconfirmed', sent: ['JWT'] }, permission: false }))
      .toBe('⚠ <i>Sent: JWT — not confirmed, check the laptop.</i>')
    expect(line({ type: 'outcome', outcome: { state: 'partial', sent: ['JWT'], total: 3 }, permission: false }))
      .toBe('⚠ <i>Sent 1 of 3 — stopped: the dialog changed. Check the laptop.</i>')
    expect(line({ type: 'laptop' })).toBe('<i>Answered at the laptop.</i>')
    expect(line({ type: 'closed' })).toBe('<i>No longer open.</i>')
    expect(line({ type: 'restarted' })).toBe('<i>BMN restarted — answer at the laptop.</i>')
    expect(line({ type: 'restarted-sending' })).toBe('⚠ <i>Sent — not confirmed, check the laptop.</i>')
    expect(line({ type: 'outcome', outcome: { state: 'confirmed', sent: ['Allow once'] }, permission: true })).toBe('✓ <i>Allowed once</i>')
    expect(line({ type: 'outcome', outcome: { state: 'confirmed', sent: ['Deny'] }, permission: true })).toBe('✓ <i>Denied</i>')
    expect(line({ type: 'outcome', outcome: { state: 'confirmed', sent: ['JWT', 'Postgres', 'Yes'] }, permission: false }))
      .toBe('✓ <i>Sent: JWT · Postgres · Yes</i>')
    expect(line({ type: 'outcome', outcome: { state: 'refused', reason: 'changed' }, permission: false }))
      .toBe('⚠ <i>Nothing was sent: the dialog changed on the laptop.</i>')
    expect(line({ type: 'sending', labels: ['JWT'] })).toBe('<i>Sending: JWT…</i>')
  })

  it('5. a finished permission keeps the command, so the record shows what was allowed', () => {
    const base = permissionCard({ header: CLAUDE, prompt: BASH, tokens: { allow: 'a', deny: 'd' }, closedBecause: null, home: '/home/owner' }).base
    expect(endedCard(base, { type: 'outcome', outcome: { state: 'confirmed', sent: ['Allow once'] }, permission: true }))
      .toBe(`🔐 <b>api-server</b> · Claude 🇺🇸
<i>Wants to run a command</i>

<pre>pnpm test --filter api</pre>
in <code>~/code/api</code>

✓ <i>Allowed once</i>`)
  })

  it('5. only uncertain, partial and refused outcomes send a reply that sounds', () => {
    expect(endingReply({ state: 'confirmed', sent: ['JWT'] })).toBeNull()
    expect(endingReply({ state: 'sent-unconfirmed', sent: ['JWT'] })).toBe('Sent, but not confirmed. Check the laptop.')
    expect(endingReply({ state: 'partial', sent: ['JWT'], total: 3 })).toBe('Sent 1 of 3, then the dialog changed. Check the laptop.')
    expect(endingReply({ state: 'refused', reason: 'not-on-screen' })).toBe('Nothing was sent: that dialog is not on the screen.')
  })

  it('6. a shape without buttons is drawn the same and says to answer at the laptop', () => {
    const card = questionCard({
      header: { session: 'api-server', agent: 'codex', flag: '🇺🇸' },
      prompt: {
        ...questions({
          id: null, header: 'Features', text: 'Which features should the first release include?', multiSelect: true,
          options: [
            { label: 'Rate limiting', description: 'Per-key request caps.' },
            { label: 'Audit log', description: 'Record every admin action.' }
          ]
        }),
        harness: 'codex',
        shape: 'multi-select'
      },
      step: 0,
      chosen: [],
      tokens: null
    })
    expect(card.text).toBe(`❓ <b>api-server</b> · Codex 🇺🇸
<i>Features · choose any</i>

<b>Which features should the first release include?</b>

<b>1. Rate limiting</b>
Per-key request caps.

<b>2. Audit log</b>
Record every admin action.

<i>No buttons for this kind yet. Answer at the laptop.</i>`)
    expect(card.keyboard).toBeNull()
  })

  it('7. a finished turn folds a long summary into an expandable quote and invites a reply', () => {
    const card = noticeCard(CLAUDE, {
      requestKey: 'turn',
      title: 'Claude finished its turn',
      body: 'Added JWT middleware and 14 tests; all pass.\nChanged: src/auth/jwt.ts, src/routes/login.ts.\nNot done: refresh tokens.\nNext: expiry <decision>.'
    })
    expect(card.text).toBe(`✓ <b>api-server</b> · Claude 🇺🇸 finished

<blockquote expandable>Added JWT middleware and 14 tests; all pass.
Changed: src/auth/jwt.ts, src/routes/login.ts.
Not done: refresh tokens.
Next: expiry &lt;decision&gt;.</blockquote>
<i>Reply to this message to continue.</i>`)
  })

  it('7. clips a very long summary on a paragraph break and says where the rest is', () => {
    const paragraph = `${'word '.repeat(150).trim()}`
    const card = noticeCard(CLAUDE, { requestKey: 'turn', title: 't', body: Array(8).fill(paragraph).join('\n\n') })
    expect(card.text).toContain('\n… continues at the laptop</blockquote>')
    expect(card.text.length).toBeLessThan(3300)
  })

  it('uses the same header for a plain request, another notice and an exit', () => {
    expect(requestCard(CLAUDE, { kind: 'question', title: 'Pick a branch', body: null }).text)
      .toBe('❓ <b>api-server</b> · Claude 🇺🇸\n<b>Pick a branch</b>\n\n<i>Reply to this message to answer.</i>')
    expect(requestCard({ session: 's', agent: null, flag: null }, { kind: 'permission', title: 'Wants Bash', body: null }).text)
      .toBe('🔐 <b>s</b>\n<b>Wants Bash</b>\n\n<i>Reply to this message to answer.</i>')
    expect(noticeCard(CLAUDE, { requestKey: 'error', title: 'OpenCode reported an error', body: 'x' }).text)
      .toBe('⚠ <b>api-server</b> · Claude 🇺🇸\n<b>OpenCode reported an error</b>\n\nx\n\n<i>Reply to this message to answer.</i>')
    expect(exitCard({ session: 'a-very-long-session-name-over-24', agent: 'opencode', flag: null }))
      .toBe('■ <b>a-very-long-session-nam…</b> · OpenCode exited')
  })
})

describe('the length rule', () => {
  const long = (seed: string, count: number): string => `${seed} `.repeat(count).trim()
  const heavy = (index: number) => ({
    id: null,
    header: `H${index}`,
    text: long(`Question${index} <&>`, 90),
    multiSelect: false,
    options: Array.from({ length: 4 }, (_, option) => ({
      label: `Label ${index}.${option} <kept>`,
      description: long(`desc${index}.${option}`, 60)
    }))
  })

  it('fits four long questions by clipping descriptions first, then questions, never labels', () => {
    const prompt = { ...questions(heavy(1), heavy(2), heavy(3), heavy(4)), shape: 'multi-select' as const }
    const card = questionCard({ header: CLAUDE, prompt, step: 0, chosen: [], tokens: null })
    expect(card.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    for (const question of prompt.questions) {
      for (const option of question.options) expect(card.text).toContain(`. ${escapeHtml(option.label)}</b>`)
    }
    expect(card.text).toContain('…')
  })

  it('leaves questions whole while clipping descriptions is enough', () => {
    const question = { ...heavy(1), text: 'Short question?' }
    const card = questionCard({ header: CLAUDE, prompt: questions(question, heavy(2), heavy(3)), step: 0, chosen: [], tokens: ['a', 'b', 'c', 'd'] })
    expect(card.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    expect(card.text).toContain('<b>Short question?</b>')
  })

  it('clips buttons at 28 characters, number included', () => {
    const card = questionCard({
      header: CLAUDE,
      prompt: questions({ ...TESTS, options: [{ label: 'A label that is far too long for a button', description: null }] }),
      step: 0,
      chosen: [],
      tokens: ['t']
    })
    expect(card.keyboard?.[0]?.[0]?.text).toBe('1 · A label that is far too…')
    expect([...card.keyboard![0]![0]!.text]).toHaveLength(28)
  })
})
