// MODULE: quick-look-config-edit.test.ts - a hidden value as one piece in a config draft (caret, replace, delete, a multi-line value), each format's escapes, the paste rule, undo, and the changed, added and removed lines, compared byte for byte on made-up values (Story 68.2)
import { history, undo, redo } from '@codemirror/commands'
import { EditorSelection, EditorState, Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { secretRanges } from '@bmn/protocol'
import {
  LINE_BREAK_REFUSED,
  MULTI_LINE_REFUSED,
  configMasks,
  draftChanges,
  lineEndingOf,
  lineMarks,
  lineSummary,
  maskField,
  pasteLandsMasked,
  quotedValue,
  rebaseConfigDraft,
  refusedEdit,
  valueSpan
} from './quick-look-config-edit'
import { maskedDraft } from './quick-look-config-view'
import { checkSyntax, type ConfigFormat } from './quick-look-syntax'

const CANARY = 'madeupQL68canary0123456789'

function draft(format: ConfigFormat, path: string, text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [history(), configMasks(format, secretRanges(path, text)), draftChanges] })
}

/** Applies a transaction as his keys would, returning the new state and anything refused. */
function act(state: EditorState, spec: TransactionSpec): { state: EditorState; refused: string[] } {
  const tr = state.update(spec)
  return { state: tr.state, refused: tr.effects.flatMap((effect) => (effect.is(refusedEdit) ? [effect.value] : [])) }
}

const masked = (state: EditorState): string[] => state.field(maskField).masks.map((mask) => state.sliceDoc(mask.from, mask.to))
const first = (state: EditorState) => state.field(maskField).masks[0]!

/** Runs a history command and returns the state it dispatched. */
function command(state: EditorState, run: typeof undo): EditorState {
  let next = state
  run({ state, dispatch: (tr: Transaction) => { next = tr.state } })
  return next
}

describe('a hidden value in a config draft', () => {
  it('replaces the whole value when he types or pastes on it, double-quoted with the format\'s escapes, and keeps it masked', () => {
    const json = '{\n  "apiKey": "madeupOldValue123",\n  "n": 1\n}\n'
    let state = draft('json', '/p/a.json', json)
    const mask = first(state)
    const pasted = act(state, { changes: { from: mask.from, to: mask.to, insert: `${CANARY}"\\` }, selection: EditorSelection.cursor(mask.from), userEvent: 'input.paste' })
    state = pasted.state
    expect(state.doc.toString()).toBe(`{\n  "apiKey": "${CANARY}\\"\\\\",\n  "n": 1\n}\n`)
    expect(masked(state)).toEqual([`${CANARY}\\"\\\\`])
    expect(first(state).pasted).toBe(true)
    expect(checkSyntax('json', state.doc.toString())).toEqual({ status: 'valid' })
    expect(JSON.parse(state.doc.toString()).apiKey).toBe(`${CANARY}"\\`)

    const yaml = 'model: made-up\ntoken: madeupYamlToken42\n'
    state = draft('yaml', '/p/a.yaml', yaml)
    const typed = act(state, { changes: { from: first(state).from, to: first(state).to, insert: 'x' }, userEvent: 'input.type' }).state
    expect(typed.doc.toString()).toBe('model: made-up\ntoken: "x"\n')
    // The caret is at the value's end, inside its quotes, and more typing goes on adding to it.
    const more = act(typed, { changes: { from: typed.selection.main.head, insert: 'y\u007f' }, userEvent: 'input.type' }).state
    expect(more.doc.toString()).toBe('model: made-up\ntoken: "xy\\u007f"\n')
    expect(masked(more)).toEqual(['xy\\u007f'])

    const toml = "name = \"made-up\"\napi_key = 'madeupLiteral99'\n"
    state = draft('toml', '/p/a.toml', toml)
    const replaced = act(state, { changes: { from: first(state).from + 2, to: first(state).from + 4, insert: 'a\u0085b' }, userEvent: 'input.type' }).state
    expect(replaced.doc.toString()).toBe('name = "made-up"\napi_key = "a\\u0085b"\n')
  })

  it('leaves an empty string on Backspace or Delete, and steps over the value as one piece', () => {
    const json = '{"password": "madeupSecretWord1"}'
    const state = draft('json', '/p/a.json', json)
    const mask = first(state)
    const deleted = act(state, { changes: { from: mask.from, to: mask.to }, userEvent: 'delete.backward' }).state
    expect(deleted.doc.toString()).toBe('{"password": ""}')
    expect(masked(deleted)).toEqual([])
    expect(deleted.selection.main.head).toBe('{"password": "'.length)
    // Backspace on the closing quote takes the value too, never a part of it.
    const quote = valueSpan('json', json, mask.from, mask.to).to
    expect(act(state, { changes: { from: quote - 1, to: quote }, userEvent: 'delete.backward' }).state.doc.toString()).toBe('{"password": ""}')
  })

  it('takes the whole value with an edit that crosses its edge, and leaves edits elsewhere as they are', () => {
    const json = '{"a": 1, "token": "madeupTokenValue77", "b": 2}'
    const state = draft('json', '/p/a.json', json)
    const mask = first(state)
    const crossed = act(state, { changes: { from: json.indexOf('"token"'), to: mask.from + 3, insert: '' }, userEvent: 'delete.selection' }).state
    expect(crossed.doc.toString()).toBe('{"a": 1, , "b": 2}')
    expect(crossed.doc.toString()).not.toContain('madeup')
    const elsewhere = act(state, { changes: { from: json.indexOf('2'), to: json.indexOf('2') + 1, insert: '3' }, userEvent: 'input.type' }).state
    expect(elsewhere.doc.toString()).toBe(json.replace('"b": 2', '"b": 3'))
    expect(masked(elsewhere)).toEqual(masked(state))
  })

  it('refuses to replace a multi-line value, and a line break in a value', () => {
    const yaml = 'key: |\n  madeup line one\n  madeup line two\nother: 1\n'
    const state = draft('yaml', '/p/a.yaml', yaml)
    const mask = first(state)
    const multi = act(state, { changes: { from: mask.from, to: mask.to, insert: 'x' }, userEvent: 'input.paste' })
    expect(multi.refused).toEqual([MULTI_LINE_REFUSED])
    expect(multi.state.doc.toString()).toBe(yaml)
    const json = draft('json', '/p/a.json', '{"secret": "madeupSingleLine1"}')
    const broken = act(json, { changes: { from: first(json).from, to: first(json).to, insert: 'a\nb' }, userEvent: 'input.paste' })
    expect(broken.refused).toEqual([LINE_BREAK_REFUSED])
    expect(broken.state.doc.toString()).toBe('{"secret": "madeupSingleLine1"}')
  })

  it('masks a pasted single line of 8 or more characters with no space, and not a shorter one or one with a space', () => {
    expect([pasteLandsMasked('12345678'), pasteLandsMasked('1234567'), pasteLandsMasked('made up words'), pasteLandsMasked(CANARY)]).toEqual([true, false, false, true])
    const state = draft('json', '/p/a.json', '{"model": ""}')
    const at = '{"model": "'.length
    const pasted = act(state, { changes: { from: at, insert: CANARY }, userEvent: 'input.paste' }).state
    expect(masked(pasted)).toEqual([CANARY])
    expect(act(state, { changes: { from: at, insert: 'made up' }, userEvent: 'input.paste' }).state.field(maskField).masks).toEqual([])
  })

  it('brings a mask back with an undo, so an undone edit never shows the old value, and takes the new one away again with a redo', () => {
    const json = '{"apiKey": "madeupOldValue123"}'
    const state = draft('json', '/p/a.json', json)
    const replaced = act(state, { changes: { from: first(state).from, to: first(state).to, insert: CANARY }, userEvent: 'input.paste' }).state
    const undone = command(replaced, undo)
    expect(undone.doc.toString()).toBe(json)
    expect(masked(undone)).toEqual(masked(state))
    const redone = command(undone, redo)
    expect(redone.doc.toString()).toBe(`{"apiKey": "${CANARY}"}`)
    expect(masked(redone)).toEqual([CANARY])
  })
})

describe('a paste or a selection that meets more than one value', () => {
  const finder = (path: string) => (text: string) => secretRanges(path, text)
  const withFinder = (format: ConfigFormat, path: string, text: string): EditorState =>
    EditorState.create({ doc: text, extensions: [history(), configMasks(format, secretRanges(path, text), finder(path)), draftChanges] })

  it('masks what a select-all paste brings in, by the file\'s rule and the paste rule, through undo and redo', () => {
    const json = '{\n  "apiKey": "madeupOldValue123",\n  "token": "madeupOldToken456"\n}\n'
    const state = withFinder('json', '/p/a.json', json)
    const one = act(state, { changes: { from: 0, to: json.length, insert: `{"token":"${CANARY}"}` }, userEvent: 'input.paste' }).state
    expect(one.doc.toString()).toBe(`{"token":"${CANARY}"}`)
    expect(maskedDraft(one)).not.toContain(CANARY)
    const page = `{\n  "model": "made-up",\n  "password": "${CANARY}"\n}\n`
    const many = act(state, { changes: { from: 0, to: json.length, insert: page }, userEvent: 'input.paste' }).state
    expect(many.doc.toString()).toBe(page)
    expect(masked(many)).toEqual([CANARY])
    const undone = command(many, undo)
    expect(undone.doc.toString()).toBe(json)
    expect(masked(undone)).toEqual(masked(state))
    expect(masked(command(undone, redo))).toEqual([CANARY])
  })

  it('replaces a pasted piece as it is and leaves the text around it', () => {
    const state = draft('json', '/p/a.json', '{"model":"prefixSUFFIX"}')
    const at = '{"model":"prefix'.length
    const pasted = act(state, { changes: { from: at, insert: CANARY }, userEvent: 'input.paste' }).state
    expect(masked(pasted)).toEqual([CANARY])
    const piece = first(pasted)
    const replaced = act(pasted, { changes: { from: piece.from, to: piece.to, insert: 'NEW' }, userEvent: 'input.type' }).state
    expect(replaced.doc.toString()).toBe('{"model":"prefixNEWSUFFIX"}')
    expect(JSON.parse(replaced.doc.toString()).model).toBe('prefixNEWSUFFIX')
    expect(masked(replaced)).toEqual(['NEW'])
    // Typing on at its end goes on adding to the piece, hidden.
    const more = act(replaced, { changes: { from: replaced.selection.main.head, insert: 'X' }, userEvent: 'input.type' }).state
    expect(more.doc.toString()).toBe('{"model":"prefixNEWXSUFFIX"}')
    expect(masked(more)).toEqual(['NEWX'])
  })

  it('takes every value a selection meets whole, and refuses one that meets a multi-line value anywhere', () => {
    const json = '{"a": "madeupFirstSecret1", "token": "madeupSecondSecret2", "b": 1}'
    const state = draft('json', '/p/x.json', json.replace('"a"', '"apiKey"'))
    const text = state.doc.toString()
    const [one, two] = state.field(maskField).masks
    const partial = act(state, { changes: { from: one!.from + 2, to: two!.from + 3, insert: '' }, userEvent: 'delete.selection' }).state
    expect(partial.doc.toString()).toBe(`{"apiKey": , "b": 1}`)
    expect(partial.doc.toString()).not.toContain('madeup')
    expect(text).toContain('madeupSecondSecret2')
    const yaml = 'token: madeupYamlToken42\nkey: |\n  madeup line one\n  madeup line two\nother: 1\n'
    const block = draft('yaml', '/p/a.yaml', yaml)
    const typed = act(block, { changes: { from: 0, to: yaml.length, insert: 'x' }, userEvent: 'input.type' })
    expect(typed.refused).toEqual([MULTI_LINE_REFUSED])
    expect(typed.state.doc.toString()).toBe(yaml)
  })
})

describe('quoting and line endings', () => {
  it('writes a value each format reads back as the same value', () => {
    const value = `${CANARY} "q" \\ \t \u0001 \u007f \u2028 é`
    const quoted = quotedValue('json', value)
    expect(JSON.parse(quoted)).toBe(value)
    expect([...quoted].some((char) => char.charCodeAt(0) < 0x20 || char === '\u007f' || char === '\u2028')).toBe(false)
  })

  it('keeps the line endings a file has, and names a mix', () => {
    expect([lineEndingOf('a\nb\n'), lineEndingOf('a\r\nb\r\n'), lineEndingOf('a\r\nb\n'), lineEndingOf('a\rb'), lineEndingOf('one line')]).toEqual(['\n', '\r\n', 'mixed', 'mixed', '\n'])
  })
})

describe('changed, added and removed lines', () => {
  it('pairs changed lines, then counts the added and removed ones', () => {
    let state = EditorState.create({ doc: 'a\nb\nc\nd\n', extensions: [draftChanges] })
    const edit = (spec: TransactionSpec): void => { state = state.update(spec).state }
    edit({ changes: { from: 2, to: 3, insert: 'B' } })
    edit({ changes: { from: state.doc.line(4).to, insert: '\nnew one\nnew two' } })
    edit({ changes: { from: 0, to: 2 } })
    const { original, changes } = state.field(draftChanges)
    const marks = lineMarks(original, changes, state.doc)
    expect(state.doc.toString()).toBe('B\nc\nd\nnew one\nnew two\n')
    expect([...marks.changed]).toEqual([1])
    expect([...marks.added]).toEqual([4, 5])
    expect(marks.removed).toBe(1)
    expect(lineSummary(marks)).toBe('1 line changed · 2 added · 1 removed')
  })

  it('counts nothing once an edit is typed back as it was', () => {
    let state = EditorState.create({ doc: 'a\nb\n', extensions: [draftChanges] })
    state = state.update({ changes: { from: 0, to: 1, insert: 'x' } }).state
    state = state.update({ changes: { from: 0, to: 1, insert: 'a' } }).state
    const { original, changes } = state.field(draftChanges)
    expect(lineSummary(lineMarks(original, changes, state.doc))).toBe('No lines changed')
  })
})

describe('a blocked save', () => {
  it('carries his edits onto the file another program changed elsewhere, masks and all, and not onto lines both changed', () => {
    const json = '{\n  "model": "made-up",\n  "apiKey": "madeupOldValue123",\n  "n": 1\n}\n'
    let state = draft('json', '/p/a.json', json)
    state = act(state, { changes: { from: first(state).from, to: first(state).to, insert: CANARY }, userEvent: 'input.paste' }).state
    const { original, changes } = state.field(draftChanges)
    const latest = Text.of('{\n  "model": "agent-changed",\n  "apiKey": "madeupOldValue123",\n  "n": 1\n}\n'.split('\n'))
    const carried = rebaseConfigDraft(original, changes, state.field(maskField).masks, latest)
    expect(carried?.text.toString()).toBe(`{\n  "model": "agent-changed",\n  "apiKey": "${CANARY}",\n  "n": 1\n}\n`)
    expect(carried!.masks.map((mask) => carried!.text.sliceString(mask.from, mask.to))).toEqual([CANARY])
    const clash = Text.of('{\n  "model": "made-up",\n  "apiKey": "other",\n  "n": 1\n}\n'.split('\n'))
    expect(rebaseConfigDraft(original, changes, state.field(maskField).masks, clash)).toBeNull()
  })

  it('carries his line between two changes another program made above and below it, and onto added and removed lines elsewhere', () => {
    const json = '{\n  "model": "made-up",\n  "n": 1,\n  "apiKey": "madeupOldValue123",\n  "m": 2,\n  "last": true\n}\n'
    let state = draft('json', '/p/a.json', json)
    state = act(state, { changes: { from: first(state).from, to: first(state).to, insert: CANARY }, userEvent: 'input.paste' }).state
    const { original, changes } = state.field(draftChanges)
    const masks = state.field(maskField).masks
    const both = Text.of('{\n  "model": "agent-changed",\n  "n": 1,\n  "apiKey": "madeupOldValue123",\n  "m": 2,\n  "last": false\n}\n'.split('\n'))
    const carried = rebaseConfigDraft(original, changes, masks, both)
    expect(carried?.text.toString()).toBe(`{\n  "model": "agent-changed",\n  "n": 1,\n  "apiKey": "${CANARY}",\n  "m": 2,\n  "last": false\n}\n`)
    expect(carried!.masks.map((mask) => carried!.text.sliceString(mask.from, mask.to))).toEqual([CANARY])
    const moved = Text.of('{\n  "added": 0,\n  "model": "made-up",\n  "apiKey": "madeupOldValue123",\n  "m": 2,\n  "last": true,\n  "tail": 3\n}\n'.split('\n'))
    expect(rebaseConfigDraft(original, changes, masks, moved)?.text.toString())
      .toBe(`{\n  "added": 0,\n  "model": "made-up",\n  "apiKey": "${CANARY}",\n  "m": 2,\n  "last": true,\n  "tail": 3\n}\n`)
    // Removing his line is still both changing it.
    expect(rebaseConfigDraft(original, changes, masks, Text.of('{\n  "model": "made-up",\n  "n": 1,\n  "m": 2,\n  "last": true\n}\n'.split('\n')))).toBeNull()
  })
})

describe('a file with Windows line endings', () => {
  it('is saved with them, a pasted line with bare line breaks included', () => {
    const state = EditorState.create({ doc: 'a = 1\nb = 2\n' })
    const edited = state.update({ changes: { from: state.doc.line(2).to, insert: '0\nc = 3\r\nd = 4' }, userEvent: 'input.paste' }).state
    expect(edited.doc.lines).toBe(5)
    expect(edited.doc.sliceString(0, undefined, '\r\n')).toBe('a = 1\r\nb = 20\r\nc = 3\r\nd = 4\r\n')
  })
})
