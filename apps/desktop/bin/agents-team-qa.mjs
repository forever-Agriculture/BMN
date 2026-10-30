// MODULE: agents-team-qa.mjs - curated quick-QA inputs and checked reports bound to native browser evidence
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { InputRefusal, textFile } from './agents-team-inputs.mjs'
import { writeWhole } from './agents-team-supervisor.mjs'
import { canonicalJson, sha256 } from './shared-helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const QA_SKILL = [resolve(here, '../skills/manual-qa'), resolve(here, '../../../skills/manual-qa')].find(path => existsSync(join(path, 'check.mjs')))
// Node 24 loads synchronous ESM here; keep the Electron main bundle free of top-level await.
const checker = QA_SKILL === undefined ? null : createRequire(import.meta.url)(join(QA_SKILL, 'check.mjs'))
const read = path => JSON.parse(readFileSync(path, 'utf8'))

export function qaAskInputs(path, { cwd = process.cwd(), home = process.env.HOME, origin } = {}) {
  if (QA_SKILL === undefined) throw new InputRefusal('QA_SKILL_UNAVAILABLE', 'The shared manual-qa skill is unavailable')
  const file = textFile(path, { cwd, home })
  let brief
  try { brief = JSON.parse(file.bytes.toString('utf8')) } catch { throw new InputRefusal('QA_BRIEF_INVALID', 'The QA brief is not JSON') }
  const errors = checker.checkQaBrief(brief)
  if (errors.length) throw new InputRefusal('QA_BRIEF_INVALID', errors.join('\n'))
  if (brief.mode !== 'quick-web' || brief.accounts.length) throw new InputRefusal('QA_MODE_INVALID', 'A quick QA ask is signed out, with mode quick-web and no accounts; use a QA session for accounts')
  if (brief.target !== origin) throw new InputRefusal('QA_TARGET_MISMATCH', 'The brief target must match the normalized --origin exactly')
  return {
    brief,
    files: [file.real, ...['SKILL.md', 'report.md', 'schema.json'].map(name => join(QA_SKILL, name))],
    question: 'Perform the manual QA job using only the supplied skill, brief, report instructions and schema, and the running disposable app. Do not inspect implementation, diffs, run logs or other agents’ conclusions. Use browser tools; never unsafe callbacks. Capture native screenshots. Return one JSON report object as the entire final answer, without Markdown fences or commentary. Evidence names must be browser.json or browser/<native screenshot filename>. A blocked check is not a defect; do not invent observations.'
  }
}

/** The native browser's record, rather than a model-supplied filename, admits retained evidence. */
export function finishQa(folder, answer, { hostSummary } = {}) {
  let manifest
  try { manifest = read(join(folder, 'inputs/manifest.json')) } catch { return null }
  if (manifest.qa === undefined) return null
  const own = join(folder, 'qa')
  mkdirSync(own, { recursive: true, mode: 0o700 })
  const brief = manifest.qa.brief
  writeWhole(join(own, 'brief.json'), `${JSON.stringify(brief, null, 2)}\n`)
  let report, errors
  try {
    report = JSON.parse(answer)
    errors = checker === null ? ['The shipped QA checker is unavailable'] : checker.checkQaReport(report, brief, undefined,
      hostSummary ? { hostSummary, receiptSha256: sha256(canonicalJson(hostSummary)) } : undefined)
  } catch { errors = ['QA answer must be one JSON report object'] }
  if (errors.length === 0 && report.version === 2) {
    let file
    try {
      if (!hostSummary || hostSummary.briefSha256 !== sha256(JSON.stringify(brief)) || hostSummary.revision !== brief.revision || hostSummary.receiptId !== `${hostSummary.qaId}:summary:1`) throw new Error('binding')
      file = openSync(join(folder, 'host-summary.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('size')
      const expected = canonicalJson(hostSummary)
      if (readFileSync(file, 'utf8') !== expected + '\n' || report.host_summary.receiptId !== hostSummary.receiptId || report.host_summary.sha256 !== sha256(expected)) throw new Error('mismatch')
      const blocked = hostSummary.audit.open || !hostSummary.audit.complete || hostSummary.audit.gaps.length > 0 || hostSummary.grants.some(grant => grant.activities.some(activity => activity.uncertain > 0))
      if (blocked && report.verdict !== 'NO-GO') errors.push('$.report.verdict: host audit gaps or uncertain activity require NO-GO')
    } catch { errors.push('$.report.host_summary: missing, stale or mismatched sealed host receipt') }
    finally { if (file !== undefined) closeSync(file) }
  }
  if (errors.length === 0) {
    let browser
    try { browser = read(join(folder, 'browser.json')) } catch { errors.push('Native browser evidence is unavailable') }
    if (!browser) {
      const result = { valid: false, verdict: null, errors, report: null, brief: 'qa/brief.json' }
      writeWhole(join(own, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
      return result
    }
    const evidence = new Set(['browser.json', ...browser.screenshots.map(shot => `browser/${shot.name}`)])
    const named = [...report.criteria.flatMap(item => item.evidence), ...report.findings.flatMap(item => item.evidence)]
    for (const name of named) if (!evidence.has(name)) errors.push(`$.report.evidence: ${name} is not retained native browser evidence`)
    if (report.goal_check.execution === 'started' && browser.calls === 0) errors.push('$.report.goal_check: no native browser activity was recorded')
  }
  if (report !== undefined) writeWhole(join(own, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const result = { valid: errors.length === 0, verdict: errors.length ? null : report.verdict, errors, report: report === undefined ? null : 'qa/report.json', brief: 'qa/brief.json' }
  writeWhole(join(own, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}
