// MODULE: away-skills-startup.mjs - 113.3 method 3: classify a native app's rendered startup screen and decide the allowed keys
// Pure: screens come from BMN's test-mode terminal snapshot (rendered buffer lines, not raw output). Each app's trust
// dialog is recognized from its real captured screen (native-m3/capture-*/result.json) and nothing looser.

/** The visible screen: the last `rows` rendered buffer lines, right-trimmed. */
export function visibleScreen(snapshot) {
  const lines = snapshot.bufferLines ?? []
  return lines.slice(Math.max(0, lines.length - snapshot.rows)).map(line => line.replace(/\s+$/u, ''))
}

/**
 * Each app's folder trust dialog as captured: header line, the fixture path block after it, the title, the option block
 * right above the footer, the selector glyph and which option is affirmative. `down`: the app's default selection is
 * the negative option, so one Down arrow is the only way to reach the affirmative one.
 */
export const TRUST_DIALOGS = {
  codex: { header: /^\s*Folder access$/u, title: /^\s*Trust this folder\? Codex can read, edit, and run files here/u, footer: /^\s*enter continue · esc back$/u, selector: '›', options: ['1. Trust and continue', '2. Back to Agent Command Center'], affirmative: 0, down: false },
  claude: { header: /^\s*Accessing workspace:$/u, title: /^\s*Quick safety check: Is this a project you created or one you trust\?/u, footer: /^\s*Enter to confirm · Esc to cancel$/u, selector: '❯', options: ['No, exit', 'Yes, I trust this folder'], affirmative: 1, down: true }
}

const BLOCKING = [
  [/Hooks need review/iu, 'hooks review'],
  [/\b(?:sign|log)\s?in\b|\blogin\b|authenticat|API key/iu, 'login'],
  [/update (?:available|now)|new version|upgrade (?:now|available)|restart to update/iu, 'update'],
  [/choose (?:the )?(?:text )?style|select (?:a )?theme|dark mode|welcome to claude code|let's get started/iu, 'onboarding'],
  [/do you want to|allow (?:this|once|always)|approve|permission/iu, 'permission'],
  [/trust (?:this|the) (?:folder|files|project)|one you trust/iu, 'trust']
]
const SELECTED = /^\s*[›❯>]\s*\S/u
const NUMBERED = /^\s*[›❯>]?\s*\d+\.\s/u

const blockAfter = (lines, from) => {
  let start = from
  while (start < lines.length && !lines[start].trim()) start++
  let end = start
  while (end < lines.length && lines[end].trim()) end++
  return { start, end, lines: lines.slice(start, end) }
}
const blockBefore = (lines, to) => {
  let end = to
  while (end > 0 && !lines[end - 1].trim()) end--
  let start = end
  while (start > 0 && lines[start - 1].trim()) start--
  return { start, end, lines: lines.slice(start, end) }
}
const lastIndex = (lines, pattern) => lines.findLastIndex(line => pattern.test(line))

/** The app's trust dialog read strictly from the screen, or null with the first mismatch. */
export function readTrustDialog(app, lines, fixture) {
  const spec = TRUST_DIALOGS[app]
  if (!spec) return { error: 'no trust dialog known for this app' }
  const headers = lines.filter(line => spec.header.test(line)).length
  if (headers !== 1) return { error: headers ? 'more than one trust dialog header' : 'no trust dialog header' }
  const header = lastIndex(lines, spec.header)
  const path = blockAfter(lines, header + 1)
  if (path.lines.map(line => line.trim()).join('') !== fixture) return { error: 'trust dialog without this fixture path' }
  const title = lines.findIndex((line, index) => index >= path.end && spec.title.test(line))
  if (title < 0) return { error: 'trust dialog title missing after the path' }
  const footer = lastIndex(lines, spec.footer)
  if (footer < title || lines.slice(footer + 1).some(line => line.trim())) return { error: 'trust dialog footer missing or not last' }
  const block = blockBefore(lines, footer)
  if (block.start <= title) return { error: 'trust dialog option block missing' }
  const selectorLines = lines.filter(line => line.trimStart().startsWith(spec.selector))
  const options = block.lines.map(line => line.trim())
  const selected = options.findIndex(line => line.startsWith(spec.selector))
  const labels = options.map(line => line.startsWith(spec.selector) ? line.slice(spec.selector.length).trim() : line)
  if (labels.length !== spec.options.length || labels.some((label, index) => label !== spec.options[index])) return { error: 'trust dialog options differ from the captured ones' }
  if (selectorLines.length !== 1 || selected < 0 || options.filter(line => line.startsWith(spec.selector)).length !== 1) return { error: 'trust dialog without exactly one selected option' }
  return { selected, affirmative: spec.affirmative, down: spec.down }
}

/**
 * One screen's state for an app: `trust` (its own trust dialog for this exact fixture, affirmative option selected),
 * `trust-negative` (the same dialog with its default negative option selected, only for an app whose spec allows
 * one Down), `dialog` (any other dialog or option list: never answered), `composer`, or `loading`.
 */
export function classifyScreen(app, lines, fixture) {
  const text = lines.join('\n')
  if (TRUST_DIALOGS[app] && lines.some(line => TRUST_DIALOGS[app].header.test(line) || TRUST_DIALOGS[app].title.test(line))) {
    const dialog = readTrustDialog(app, lines, fixture)
    if (dialog.error) return { state: 'dialog', detail: dialog.error }
    if (dialog.selected === dialog.affirmative) return { state: 'trust', detail: 'fixture trust dialog, affirmative option selected' }
    if (dialog.down && dialog.selected === dialog.affirmative - 1) return { state: 'trust-negative', detail: 'fixture trust dialog, default negative option selected' }
    return { state: 'dialog', detail: 'trust dialog with another selection' }
  }
  const options = lines.filter(line => NUMBERED.test(line))
  for (const [pattern, name] of BLOCKING) if (pattern.test(text)) return { state: 'dialog', detail: name }
  if (options.length > 0) return { state: 'dialog', detail: 'unknown option list' }
  if (/\bloading\b|starting|booting|connecting/iu.test(text)) return { state: 'loading', detail: 'loading marker' }
  if (lines.some(line => /enter to (?:confirm|continue|select)|esc (?:to )?(?:back|cancel)/iu.test(line))) return { state: 'dialog', detail: 'unknown dialog footer' }
  const prompt = app === 'codex' ? /^›(?:\s|$)/u : /^\s*[│|]?\s*[>❯](?:\s|$)/u
  // Codex 0.167's real composer (native-m4/qualify-codex): its header box and a status footer "<model> <effort> · <cwd>".
  // Header, then the one prompt, then the footer, in that order (Astra 144228 correction 1).
  const ready = app === 'codex'
    ? (screen, at) => { const header = screen.findIndex(line => /^\s*[│|]?\s*>_ OpenAI Codex \(v/u.test(line)), footer = screen.findLastIndex(line => /^\s{2}\S.* · ~?\//u.test(line)); return header >= 0 && header < at && at < footer }
    // Claude Code 2.1.319's real composer (native-m4/qualify-claude): its version header, the one prompt between two
    // horizontal rules, and a mode or shortcuts footer below the lower rule (the one Claude correction, Astra 144228).
    : (screen, at) => {
      const rule = line => /^─{20,}$/u.test(line ?? '')
      const header = screen.findIndex(line => /Claude Code v\d/u.test(line))
      const footer = screen.findIndex((line, index) => index > at + 1 && /⏵⏵|\? for shortcuts|accept edits|plan mode|bypass permissions|auto mode/iu.test(line))
      return header >= 0 && header < at - 1 && rule(screen[at - 1]) && rule(screen[at + 1]) && footer > at + 1
    }
  const prompts = lines.flatMap((line, index) => prompt.test(line) ? [index] : [])
  if (prompts.length === 1 && ready(lines, prompts[0]) && !lines.some(line => SELECTED.test(line) && NUMBERED.test(line))) return { state: 'composer', detail: 'composer with its ready footer, no dialog markers' }
  return { state: 'loading', detail: prompts.length > 1 ? 'more than one prompt line' : 'no recognized state' }
}

/**
 * The startup state machine over successive observations ({ at, state }). `downSent`/`answered` say which logical
 * keys were already sent (set before dispatch); `keys` counts them. It returns `down` once, only for a
 * `trust-negative` screen before any key; after that Down the very next observation must be `trust`, else `fail`
 * with no further key; `enter` once, only for a `trust` screen not answered before; `ready` only after two
 * consecutive composer observations at least `stableMs` apart with no dialog between, the last two with identical
 * screens when `screen` keys are given; `fail` for any other dialog or a
 * trust dialog persisting after its answer; otherwise `wait`. At most two startup keys in all (Astra 142855).
 */
export function startupStep(history, { answered, downSent = false, keys = 0, stableMs = 2000 }) {
  const last = history.at(-1)
  if (!last) return { action: 'wait' }
  if (keys > 2) return { action: 'fail', reason: 'startup key budget exceeded' }
  if (last.state === 'dialog') return { action: 'fail', reason: `unanswerable dialog: ${last.detail}` }
  if (downSent && !answered && last.state !== 'trust') return { action: 'fail', reason: 'trust selection did not reach the affirmative option after one Down' }
  if (last.state === 'trust-negative') return answered || downSent || keys > 0 ? { action: 'fail', reason: 'negative trust selection after a startup key' } : { action: 'down' }
  if (last.state === 'trust') return answered ? { action: 'fail', reason: 'trust dialog persisted after its one answer' } : keys > 1 ? { action: 'fail', reason: 'startup key budget used' } : { action: 'enter' }
  if (last.state === 'composer') {
    let first = history.length - 1
    while (first > 0 && history[first - 1].state === 'composer') first--
    // Astra 144228 correction 2: the last two observations show the same screen and lie at least stableMs apart, so an
    // immediate duplicate capture never establishes readiness.
    const previous = history.at(-2)
    const settled = history.length - first >= 2 && last.at - previous.at >= stableMs && (last.screen === undefined || last.screen === previous.screen)
    return settled ? { action: 'ready' } : { action: 'wait' }
  }
  return { action: 'wait' }
}
