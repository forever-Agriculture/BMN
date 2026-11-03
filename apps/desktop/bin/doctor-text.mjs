// MODULE: doctor-text.mjs - Story 102.12: what `bmn doctor` prints: each problem and what to do, in plain words; identities and routes only with --details

const APP = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
const KIND = { plugins: 'plugin', mcp: 'MCP entry', memory: 'memory', skills: 'skill', hooks: 'hook', rules: 'rules file' }

/** A finding of BMN's own checks in plain words: only the app's name and a closed cause word, never text from the tool's own file. */
function problemWords(problem) {
  const app = APP[problem.app]
  const { cause } = problem
  if (app !== undefined && cause !== undefined) {
    if (cause === 'unlisted-exposed') return `${app} offers a tool BMN does not list`
    if (cause === 'unlisted-managed') return `${app} has a tool from its managed settings that BMN does not list`
    if (cause === 'guard:does-not-answer') return `${app}'s command guard does not answer`
    if (cause === 'rules:missing') return `${app}'s own refusal rules are missing`
    if (cause === 'approval:not-approved') return `${app} does not run some of BMN's hook entries`
    if (cause === 'approval:unverified') return `BMN could not ask ${app} whether it runs BMN's hook entries`
    if (cause === 'approval:no-codex') return `BMN cannot find ${app}, whose hook file holds BMN's entries`
    if (cause.startsWith('missing:')) return `${app}'s ${cause.slice(8)} hook is missing`
    if (cause === 'older-wording:plugin') return `${app}'s plugin is an older wording`
    return `${problem.reason} in ${app}: ${cause}`
  }
  return problem.reason
}

const FIXES = {
  'guard:does-not-answer': 'Its holds are missed while the app\'s own rules still refuse the worst. Run `bmn hooks check`, then `bmn hooks install`.',
  'rules:missing': 'Run `bmn hooks install`.',
  'approval:not-approved': 'It runs a new or changed entry only once you approve it, so its guard and BMN\'s view of its sessions are off. Run /hooks in Codex.',
  'approval:unverified': 'Run `bmn hooks check`; it says why. If Codex still cannot answer, treat its guard as off.',
  'approval:no-codex': 'Check that it is on your PATH; until then, treat its guard as off.'
}

/** An app's own doctor says what BMN could tell from it: what was checked, what could not be, and whether it needs him. */
function appDoctorWords(check, state, load) {
  const app = APP[check]
  if (state === 'timeout') {
    return `${app}: not judged. Its doctor did not finish within BMN's limit${load === null ? '' : `, with the machine at load ${load}`}; that says nothing about the app. It needs you only if this repeats on a quiet machine.`
  }
  if (state === 'partial') {
    return `${app}: checked what its doctor reported in terms BMN knows. A part could not be read: a check it skipped, one BMN's read-only run cannot open, or one BMN does not know. It needs you only if the app misbehaves; \`${check} doctor\` shows it all.`
  }
  return null
}

const counted = (lines) => {
  const seen = new Map()
  for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1)
  return [...seen].map(([line, count]) => (count > 1 ? `  ${count} x ${line}` : `  ${line}`))
}

/** The full listing, as it was before Story 102.12: every leftover's location and route. */
function detailsLines(view) {
  const lines = []
  for (const row of view.rows) {
    if (row.state === 'passed' && !row.stale && row.leftovers.length === 0) continue
    lines.push(`${row.check}: ${row.state}${row.stale ? ' · stale' : ''}`)
    for (const problem of row.problems) lines.push(`  ${problemWords(problem)}. ${FIXES[problem.cause] ?? problem.fix}`)
    for (const item of row.leftovers) lines.push(`  Show-only: ${item.location}. ${item.reasonText}`)
  }
  if (view.rows.some((row) => row.leftovers.length > 0)) lines.push(view.locationHelp)
  return lines
}

function plainLines(view, load) {
  const lines = []
  for (const row of view.rows) {
    if (row.state === 'passed' && !row.stale && row.leftovers.length === 0) continue
    const said = ['claude', 'codex'].includes(row.check) ? appDoctorWords(row.check, row.state, load) : null
    const problems = said === null ? row.problems : row.problems.filter((problem) => problem.code !== 'additional-details')
    if (said !== null) lines.push(said)
    else if (row.state !== 'passed' || row.stale) lines.push(`${row.check}: ${row.state}${row.stale ? ' · stale' : ''}`)
    lines.push(...counted(problems.map((problem) => `${problemWords(problem)}. ${FIXES[problem.cause] ?? problem.fix}`)))
    if (row.leftovers.length > 0) {
      lines.push(`${row.check}: ${row.leftovers.length} shown only; BMN leaves them, and nothing here needs you. \`bmn doctor --details\` lists each.`)
      const kinds = new Map()
      for (const item of row.leftovers) kinds.set(`${KIND[item.kind] ?? item.kind}: ${item.reasonText}`, (kinds.get(`${KIND[item.kind] ?? item.kind}: ${item.reasonText}`) ?? 0) + 1)
      for (const [words, count] of [...kinds].sort((a, b) => b[1] - a[1])) lines.push(`  ${count} ${words}`)
    }
  }
  return lines
}

/** The doctor's text. `load` is the one-minute load average, said only beside a check that ran out of time on a busy machine. */
export function doctorText(view, { details = false, allowLines = [], load = null, cores = 1 } = {}) {
  const busy = load !== null && load > cores ? Math.round(load) : null
  const lines = [view.running ? 'Checking now' : view.allWell ? `All well · ${view.rows.length} checks passed` : 'Doctor needs attention']
  lines.push(...(details ? detailsLines(view) : plainLines(view, busy)))
  lines.push(...allowLines)
  if (view.error) lines.push('The doctor could not complete. Inspect the app doctor yourself.')
  return lines.join('\n')
}
