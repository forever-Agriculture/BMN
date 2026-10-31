// MODULE: attention-mirror.test.ts - one decision, one phone message: an agent's own question and its `bmn ask` card page once
import type { AttentionRecord } from '@bmn/protocol'
import { expect, it } from 'vitest'
import { LEFT_WITHIN_MS, MIRROR_WINDOW_MS, askedTwice, createAttentionPager, mirrorOf } from './attention-pager'

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 31, 10, 20, 0) + seconds * 1000).toISOString()
function request(id: string, change: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    requestId: id, sessionId: 'session-1', incarnationId: null, requestKey: id, kind: 'question', title: 'Synthetic decision',
    body: null, state: 'open', resolution: null, openedAt: at(0), expiresAt: null, resolvedAt: null, seenAt: null, revision: 1,
    openedBy: null, resolvedBy: null, prompt: null, ...change
  }
}
// Shaped like BMN's 2026-10-31 pair: the agent's question tool through its hook, then its `bmn ask` card 13 seconds later.
const asked = 'Authorize ONE additional synthetic gallery round by pushing prepared commit 1a2b3c4d after the current sample jobs pass? It removes twenty rejected sample comments; local style checks pass.'
const native = request('native', { openedBy: 'hook:codex:PreToolUse', requestKey: 'codex:question', title: `Codex asks: ${asked.slice(0, 80)}`, body: `1. ${asked}` })
const card = request('card', { openedBy: 'cli', kind: 'permission', openedAt: at(13), requestKey: 'synthetic-decision', title: 'One additional synthetic gallery round',
  body: `${asked} Keep no further sample run after this round.`,
  manualChoices: { options: [{ label: 'Authorize one additional gallery round (Recommended)', description: null }, { label: 'Keep current gallery limit', description: null }], allowOther: true } })

it('the later of an agent question and its card is the mirror, whichever came first', () => {
  expect(mirrorOf(card, [native, card])?.requestId).toBe('native')
  expect(mirrorOf(native, [native, card])).toBeNull()
  const cardFirst = { ...card, openedAt: at(-5) }
  expect(mirrorOf(native, [native, cardFirst])?.requestId).toBe('card')
  expect(mirrorOf(cardFirst, [native, cardFirst])).toBeNull()
})

it('pairs only an open native question and an open card of the same session within the window', () => {
  expect(mirrorOf(card, [{ ...native, state: 'answered' }, card])).toBeNull()
  expect(mirrorOf(card, [{ ...native, sessionId: 'session-2' }, card])).toBeNull()
  expect(mirrorOf({ ...card, openedAt: at(MIRROR_WINDOW_MS / 1000 + 1) }, [native, card])).toBeNull()
  // A tool approval is a different decision from the card the agent opened before it.
  expect(mirrorOf(card, [{ ...native, kind: 'permission', requestKey: 'codex:permission' }, card])).toBeNull()
  // Two cards, or two native questions, are separate questions asked together.
  expect(mirrorOf(card, [request('card-2', { openedBy: 'cli', title: native.title, body: native.body }), card])).toBeNull()
  expect(mirrorOf(native, [request('native-2', { openedBy: 'hook:claude:PreToolUse', openedAt: at(-1), title: native.title, body: native.body }), native])).toBeNull()
  // Close in time but another decision, as in his history (a ticket card beside a story question): both still page.
  const other = request('other', { openedBy: 'hook:claude:PreToolUse', openedAt: at(5), title: 'Claude asks: Lane one needs its synthetic story written before it can run. Shall I draft it now?' })
  expect(mirrorOf(other, [card, other])).toBeNull()
  expect(mirrorOf({ ...card, openedAt: at(6) }, [other, { ...card, openedAt: at(6) }])).toBeNull()
  // Another agent conversation (or a restarted one) in the same pane asks its own decision.
  const producer = { agentCli: 'codex' as const, conversationReference: '01a18e8b-9319-7991-b9f7-bc5219bdae5b', generation: 'f9ff5a9c-dc0c-4ac6-82b8-d254a26ffee4' }
  expect(mirrorOf({ ...card, producer }, [{ ...native, producer }, card])?.requestId).toBe('native')
  expect(mirrorOf({ ...card, producer: { ...producer, generation: '00000000-0000-4000-8000-000000000001' } }, [{ ...native, producer }, card])).toBeNull()
  expect(mirrorOf({ ...card, producer: { ...producer, conversationReference: '01a18e8b-0000-7991-b9f7-bc5219bdae5b' } }, [{ ...native, producer }, card])).toBeNull()
  // A notice from the CLI is no question.
  expect(mirrorOf({ ...card, kind: 'notice' }, [native, card])).toBeNull()
})

it('a question asked the other way round is another decision; a constraint beside the same question still pairs', () => {
  const ask = 'Should I publish the synthetic gallery report page privately now and open it for review after the sample checks pass?'
  const plain = request('plain', { openedBy: 'hook:codex:PreToolUse', title: `Codex asks: ${ask.slice(0, 80)}`, body: `1. ${ask}` })
  const turned = request('turned', { openedBy: 'cli', kind: 'permission', openedAt: at(10), title: 'Synthetic gallery report page',
    body: ask.replace('Should I publish', 'Should I not publish') })
  expect(mirrorOf(turned, [plain, turned])).toBeNull()
  expect(askedTwice(plain, { ...turned, body: ask.replace('Should I publish', 'Shouldn\'t I publish') })).toBe(false)
  // Short verbs turn too.
  const run = 'May I run the synthetic gallery sample job once more for the preview build and its report checks?'
  const runs = request('runs', { openedBy: 'hook:claude:PreToolUse', title: `Claude asks: ${run}`, body: run })
  expect(askedTwice(runs, request('stays', { openedBy: 'cli', openedAt: at(10), title: 'Synthetic gallery sample job', body: run.replace('May I run', 'May I not run') }))).toBe(false)
  expect(askedTwice(runs, request('stays', { openedBy: 'cli', openedAt: at(10), title: 'Synthetic gallery sample job', body: run }))).toBe(true)
  // His cards state limits beside the question; those negations are no turned question.
  const constrained = { ...turned, body: `${ask} Do not publish any other page; never open the owner's browser profile.` }
  expect(mirrorOf(constrained, [plain, constrained])?.requestId).toBe('plain')
})

it('a card asking another action is another decision: it pages, and an answer to the question leaves it open', () => {
  const ask = 'Should I publish the synthetic gallery report page privately now and open it for review after the sample checks pass?'
  const question = request('question', { openedBy: 'hook:codex:PreToolUse', title: `Codex asks: ${ask.slice(0, 80)}`, body: `1. ${ask}` })
  const same = request('same', { openedBy: 'cli', kind: 'permission', openedAt: at(10), title: 'Synthetic gallery report page', body: ask })
  const other = { ...same, requestId: 'other', body: ask.replace('Should I publish', 'Should I delete') }
  expect(askedTwice(question, same)).toBe(true)
  expect(mirrorOf(same, [question, same])?.requestId).toBe('question')
  expect(askedTwice(question, other)).toBe(false)
  expect(mirrorOf(other, [question, other])).toBeNull()
})

it('a card worded apart from the question but offering its same specific answers is the same decision', () => {
  // Shaped like his 2026-10-31 19:27Z pair: the card retells the question in its own words and offers the same two answers.
  const ask = 'May I send the prepared synthetic compatibility request from qa@example.test to vendor support at help@vendor.example? It asks whether they can supply the sample features the epic needs, includes no key or source code, and authorizes no charges.'
  const prompt = (labels: string[][], text = ask) => ({ type: 'questions' as const, harness: 'codex' as const, shape: 'async-choice' as const, requestRef: null, toolUseId: 'tool',
    questions: labels.map((set, index) => ({ id: null, header: null, text: index === 0 ? text : 'Which sample size should the follow-up use?', multiSelect: false,
      options: set.map(label => ({ label, description: null })) })) })
  const question = request('question', { openedBy: 'hook:codex:PreToolUse', title: `Codex asks: ${ask.slice(0, 80)}`, body: `1. ${ask}`,
    prompt: prompt([['Send the vendor email', 'Keep it unsent']]) })
  const choices = (labels: string[]) => ({ options: labels.map(label => ({ label, description: null })), allowOther: true as const })
  const retold = request('retold', { openedBy: 'cli', kind: 'permission', openedAt: at(26), title: 'Send prepared vendor support email?',
    body: 'Send exactly the request in the synthetic delivery file, from the connected test mailbox to the vendor. Subject: hosted sample kernel. No other message is authorized by this card.',
    manualChoices: choices(['Send the vendor email (Recommended)', 'Keep it unsent']) })
  expect(askedTwice(question, retold)).toBe(true)
  expect(mirrorOf(retold, [question, retold])?.requestId).toBe('question')
  // One answer list of a several-question prompt is enough.
  expect(askedTwice({ ...question, prompt: prompt([['Ten samples', 'Fifty samples'], ['Send the vendor email', 'Keep it unsent']]) }, retold)).toBe(true)
  // Answers that name no action say nothing about which decision they answer.
  const generic = (labels: string[]): [AttentionRecord, AttentionRecord] => [{ ...question, prompt: prompt([labels]) }, { ...retold, manualChoices: choices(labels) }]
  expect(askedTwice(...generic(['Yes', 'No']))).toBe(false)
  expect(askedTwice(...generic(['Approve (Recommended)', 'Deny']))).toBe(false)
  // Other answers, or the same answers to a question asked the other way round, keep them apart.
  expect(askedTwice(question, { ...retold, manualChoices: choices(['Send the partner email', 'Keep it unsent']) })).toBe(false)
  expect(askedTwice(question, { ...retold, title: 'Should I not send the prepared vendor support email?' })).toBe(false)
  // Answers with four naming words settle it even when each retelling names something the other does not.
  expect(askedTwice(question, { ...retold, title: 'Kernel outreach: send the prepared message now?' })).toBe(true)
  // Fewer naming words, as value answers, still need the questions to ask about the same thing ("border" is not "color").
  const color = 'Which synthetic gallery color should the sample banner use for the preview build?'
  const colorQuestion = request('color', { openedBy: 'hook:codex:PreToolUse', title: `Codex asks: ${color}`, body: `1. ${color}`,
    prompt: prompt([['Gold', 'Black']], color) })
  const colorCard = request('color-card', { openedBy: 'cli', kind: 'permission', openedAt: at(20), title: 'Banner color for the preview build?', manualChoices: choices(['Gold (Recommended)', 'Black']) })
  expect(askedTwice(colorQuestion, colorCard)).toBe(true)
  expect(askedTwice(colorQuestion, { ...colorCard, title: 'Which synthetic gallery border should the sample banner use?' })).toBe(false)
})

it('the pager sends the first of a mirrored pair and records the second as mirrored, unsent', async () => {
  const stored = new Map([native, card].map(item => [item.requestId, item]))
  const sent: string[] = [], phases: Array<[string, string]> = []
  let due: Array<() => void> = []
  const pager = createAttentionPager({
    current: async id => stored.get(id) ?? null,
    send: async value => { sent.push(value.requestId) },
    schedule: callback => { due.push(callback); return () => { due = due.filter(item => item !== callback) } },
    ownerAway: () => true,
    now: () => 0,
    mirrorOf: async value => mirrorOf(value, [...stored.values()]),
    observeDelivery: event => { phases.push([event.requestId, event.phase]) }
  })
  pager.opened(native); pager.opened(card)
  for (const fire of due.splice(0)) fire()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent).toEqual(['native'])
  expect(phases).toContainEqual(['card', 'request-mirrored'])
  // Once the first is answered, a card still open alone pages as before (a later revision is a new page).
  stored.set('native', { ...native, state: 'answered' })
  const revised = { ...card, revision: 2 }
  stored.set('card', revised)
  pager.opened(revised)
  for (const fire of due.splice(0)) fire()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sent).toEqual(['native', 'card'])
})

const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

it('a mirror waits with the earlier copy and pages itself when that copy leaves the desk window unsent', async () => {
  const stored = new Map([native, card].map(item => [item.requestId, item]))
  const sent: string[] = [], phases: Array<[string, string]> = []
  let due: Array<() => void> = [], now = 0, away = false
  const pager = createAttentionPager({
    current: async id => stored.get(id) ?? null,
    send: async value => { sent.push(value.requestId) },
    schedule: callback => { due.push(callback); return () => { due = due.filter(item => item !== callback) } },
    ownerAway: () => away,
    now: () => now,
    holdQuiet: async () => false,
    mirrorOf: async value => mirrorOf(value, [...stored.values()]),
    observeDelivery: event => { phases.push([event.requestId, event.phase]) }
  })
  pager.opened(native); now = 13_000; pager.opened(card)
  for (const fire of due.splice(0)) fire()
  await settled()
  expect(phases).toContainEqual(['native', 'held-at-desk'])
  expect(phases).toContainEqual(['card', 'mirror-waiting'])
  expect(sent).toEqual([])
  // He leaves after the earlier copy's ten-minute window closed but inside the card's: the card is the one page.
  now = LEFT_WITHIN_MS + 5_000; away = true
  pager.ownerLeft()
  await settled()
  expect(phases).toContainEqual(['native', 'departure-window-expired'])
  expect(sent).toEqual(['card'])
})

it('a mirror that falls due first waits for the earlier copy, and is done once that copy is sent', async () => {
  const stored = new Map([native, card].map(item => [item.requestId, item]))
  const sent: string[] = [], phases: Array<[string, string]> = []
  const due = new Map<number, () => void>()
  const pager = createAttentionPager({
    current: async id => stored.get(id) ?? null,
    send: async value => { sent.push(value.requestId) },
    schedule: (callback, ms) => { due.set(ms, callback); return () => { due.delete(ms) } },
    ownerAway: () => true,
    saidAway: () => true,
    now: () => 0,
    mirrorOf: async value => mirrorOf(value, [...stored.values()]),
    observeDelivery: event => { phases.push([event.requestId, event.phase]) }
  })
  pager.opened(native); pager.opened(card)
  due.get(0)!()
  await settled()
  expect(phases).toContainEqual(['card', 'mirror-waiting'])
  expect(sent).toEqual([])
  due.get(15_000)!()
  await settled()
  expect(sent).toEqual(['native'])
  expect(phases).toContainEqual(['card', 'request-mirrored'])
})
