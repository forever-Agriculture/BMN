// MODULE: quick-look-env-view.test.ts - a .env draft: what the Save bar says, a new key's name, and the draft carried onto the file as it is now after a blocked save (Story 68.1)
import { describe, expect, it } from 'vitest'
import { readEnvFile, type EnvModel } from './quick-look-env'
import { EMPTY_ENV_DRAFT, envDraftDirty, envDraftSummary, envDraftText, rebaseEnvDraft } from './quick-look-env-view'

const rows = (text: string): Extract<EnvModel, { status: 'rows' }> => {
  const model = readEnvFile(text)
  if (model.status !== 'rows') throw new Error(model.reason)
  return model
}
const TEXT = '# made-up\nA=1\nB="two"\n\nC=3\n'

describe('a .env draft', () => {
  it('says what changed: values of the file\'s keys, and keys added', () => {
    const model = rows(TEXT)
    expect(envDraftDirty(EMPTY_ENV_DRAFT)).toBe(false)
    expect(envDraftSummary(model, { changed: new Map([[3, 'madeup']]), added: [] })).toBe('1 of 3 values changed')
    expect(envDraftSummary(model, { changed: new Map(), added: [{ id: 1, name: 'D', value: '' }] })).toBe('1 key added')
    expect(envDraftSummary(model, { changed: new Map([[2, 'x'], [5, 'y']]), added: [{ id: 1, name: 'D', value: '' }, { id: 2, name: 'E', value: '' }] }))
      .toBe('2 of 3 values changed · 2 keys added')
  })

  it('writes only the changed value and the added line, and refuses a new key without a good name', () => {
    const model = rows(TEXT)
    expect(envDraftText(TEXT, model, { changed: new Map([[3, 'madeup-new']]), added: [{ id: 1, name: 'D', value: 'madeup' }] }))
      .toEqual({ status: 'ready', text: '# made-up\nA=1\nB="madeup-new"\n\nC=3\nD=madeup\n' })
    expect(envDraftText(TEXT, model, { changed: new Map(), added: [{ id: 1, name: 'A', value: '' }] })).toMatchObject({ status: 'refused', message: expect.stringMatching(/^New key 1: /u) })
    expect(envDraftText(TEXT, model, { changed: new Map(), added: [{ id: 1, name: '1X', value: '' }] })).toMatchObject({ status: 'refused' })
    expect(envDraftText(TEXT, model, { changed: new Map(), added: [{ id: 1, name: 'D', value: '' }, { id: 2, name: 'D', value: '' }] })).toMatchObject({ status: 'refused' })
  })

  it('carries a draft onto the file as it is now by key name, and gives up when a changed key is gone', () => {
    const before = rows(TEXT)
    const draft = { changed: new Map([[3, 'madeup']]), added: [{ id: 1, name: 'D', value: 'x' }] }
    const moved = rows('# made-up\nNEW=0\nA=1\nC=agent\nB="two"\n')
    const carried = rebaseEnvDraft(before, moved, draft)
    expect(carried?.changed).toEqual(new Map([[5, 'madeup']]))
    expect(carried?.added).toBe(draft.added)
    expect(envDraftText('# made-up\nNEW=0\nA=1\nC=agent\nB="two"\n', moved, carried!)).toEqual({ status: 'ready', text: '# made-up\nNEW=0\nA=1\nC=agent\nB="madeup"\nD=x\n' })
    expect(rebaseEnvDraft(before, rows('A=1\nC=3\n'), draft)).toBeNull()
  })
})
