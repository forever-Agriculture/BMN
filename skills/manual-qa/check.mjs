// MODULE: check.mjs - Epic 100.2: one strict brief/report schema and explicit QA consistency rules
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SCHEMA = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'))
const KEYWORDS = new Set(['$schema', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'minLength', 'minimum'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Deliberately limited JSON Schema walker; a new keyword must never be silently ignored. */
function schemaProblem(node, root, path = '$schema') {
  if (!object(node)) return `${path}: expected a schema object`
  for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) return `${path}.${key}: unsupported schema keyword`
  if (node.$ref !== undefined && (!/^#\/\$defs\/[^/]+$/u.test(node.$ref) || !Object.hasOwn(root.$defs ?? {}, node.$ref.slice(8)))) return `${path}.$ref: unsupported or missing definition`
  if (node.$ref !== undefined && Object.keys(node).some((key) => !['$ref', 'title', 'description'].includes(key))) return `${path}: unsupported constraint alongside $ref`
  if (node.type !== undefined && !['object', 'array', 'string', 'boolean', 'integer'].includes(node.type)) return `${path}.type: unsupported schema type`
  for (const group of ['$defs', 'properties']) for (const [name, child] of Object.entries(node[group] ?? {})) {
    const error = schemaProblem(child, root, `${path}.${group}.${name}`)
    if (error) return error
  }
  return node.items === undefined ? null : schemaProblem(node.items, root, `${path}.items`)
}

function walk(value, node, root, path, errors) {
  if (node.$ref !== undefined) return walk(value, root.$defs[node.$ref.slice(8)], root, path, errors)
  const fail = (message) => errors.push(`${path}: ${message}`)
  if (Object.hasOwn(node, 'const') && value !== node.const) fail(`expected ${JSON.stringify(node.const)}`)
  if (node.enum !== undefined && !node.enum.includes(value)) fail(`expected one of ${node.enum.join(', ')}`)
  if (node.type !== undefined) {
    const correct = node.type === 'object' ? object(value) : node.type === 'array' ? Array.isArray(value) : node.type === 'integer' ? Number.isInteger(value) : typeof value === node.type
    if (!correct) { fail(`expected ${node.type}`); return }
  }
  if (node.type === 'object') {
    for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`)
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(node.properties ?? {}, key)) walk(child, node.properties[key], root, `${path}.${key}`, errors)
      else if (node.additionalProperties === false) errors.push(`${path}.${key}: unknown field`)
    }
  } else if (node.type === 'array') {
    if (value.length < (node.minItems ?? 0)) fail(`expected at least ${node.minItems} item(s)`)
    for (let index = 0; index < value.length; index++) walk(value[index], node.items, root, `${path}[${index}]`, errors)
  } else if (node.type === 'string' && value.trim().length < (node.minLength ?? 0)) fail('expected nonempty text')
  else if (node.type === 'integer' && value < (node.minimum ?? -Infinity)) fail(`expected at least ${node.minimum}`)
}

/** Validity is shape and consistency only; this does not authenticate the QA observations. */
export function checkQaReport(report, brief, schema = SCHEMA) {
  const problem = schemaProblem(schema, schema)
  if (problem) return [problem]
  const errors = []
  walk(brief, schema.$defs.brief, schema, '$.brief', errors)
  walk(report, schema.$defs.report, schema, '$.report', errors)
  if (errors.length) return errors
  const fail = (path, reason) => errors.push(`$.${path}: ${reason}`)
  const unique = (values, path) => {
    const seen = new Set()
    for (let index = 0; index < values.length; index++) {
      if (seen.has(values[index])) fail(`${path}[${index}]`, `duplicate ID/alias ${values[index]}`)
      seen.add(values[index])
    }
    return seen
  }
  for (const key of ['revision', 'target', 'mode']) if (report[key] !== brief[key]) fail(`report.${key}`, 'does not match brief')
  const expected = unique(brief.criteria.map((item) => item.id), 'brief.criteria')
  const actual = unique(report.criteria.map((item) => item.id), 'report.criteria')
  for (const id of expected) if (!actual.has(id)) fail('report.criteria', `missing criterion ${id}`)
  for (const id of actual) if (!expected.has(id)) fail('report.criteria', `unknown criterion ${id}`)
  unique(report.findings.map((item) => item.id), 'report.findings')
  unique((brief.prior_findings ?? []).map((item) => item.finding.id), 'brief.prior_findings')
  const priorIds = new Set((brief.prior_findings ?? []).map((item) => item.finding.id))
  const findings = new Map(report.findings.map((item) => [item.id, item]))
  for (const { finding: prior } of brief.prior_findings ?? []) {
    const current = findings.get(prior.id)
    if (!current) { fail('report.findings', `retest must retain prior finding ${prior.id} with its current status`); continue }
    // Preserve the earlier observation; changed behaviour belongs in the current retest or a new finding.
    for (const key of ['category', 'severity', 'prerequisites', 'steps', 'expected', 'actual', 'impact']) {
      if (JSON.stringify(current[key]) !== JSON.stringify(prior[key])) fail(`report.findings.${prior.id}.${key}`, 'retest cannot rewrite prior finding facts; record current observations in retest')
    }
    for (const key of ['attempts', 'observed']) if (current.reproduction[key] !== prior.reproduction[key]) fail(`report.findings.${prior.id}.reproduction.${key}`, 'retest cannot rewrite prior reproduction counts')
  }
  const evidence = (names, path) => names.forEach((name, index) => {
    if (/^[\/\\]|[:\\\u0000-\u001f]/u.test(name) || name.split('/').some((part) => part === '' || part === '.' || part === '..')) fail(`${path}[${index}]`, 'expected a relative local evidence name without traversal or URL')
  })
  report.criteria.forEach((item, index) => {
    const path = `report.criteria[${index}]`
    if (['PASS', 'FAIL'].includes(item.status) && item.steps.length === 0) fail(`${path}.steps`, 'executed criterion needs steps')
    if (item.status === 'FAIL' && item.finding_ids.length === 0) fail(`${path}.finding_ids`, 'FAIL needs an open finding')
    unique(item.finding_ids, `${path}.finding_ids`)
    for (const id of item.finding_ids) {
      if (!findings.has(id)) fail(`${path}.finding_ids`, `unknown finding ${id}`)
      else if (item.status === 'FAIL' && findings.get(id).status !== 'open') fail(`${path}.finding_ids`, `resolved finding ${id} cannot justify FAIL`)
    }
    if (['BLOCKED', 'NOT RUN'].includes(item.status) && !report.untested_areas.some((gap) => gap.startsWith(`${item.id}:`) && gap.slice(item.id.length + 1).trim().length > 0)) fail('report.untested_areas', `disclose verification gap as ${item.id}: reason`)
    evidence(item.evidence, `${path}.evidence`)
  })
  report.findings.forEach((item, index) => {
    const path = `report.findings[${index}]`
    if (item.reproduction.observed > item.reproduction.attempts) fail(`${path}.reproduction.observed`, 'cannot exceed attempts')
    if (!priorIds.has(item.id)) {
      if (item.status === 'resolved') fail(`${path}.status`, 'a defect found on this revision stays open; record intermittent counts')
      if (item.retest !== undefined) fail(`${path}.retest`, 'retest is only for a prior finding supplied in the brief')
    }
    if (item.status === 'resolved' && item.retest === undefined) fail(`${path}.retest`, 'resolved finding needs current retest steps and observations')
    evidence(item.evidence, `${path}.evidence`)
  })
  const goal = report.goal_check
  if (goal.execution === 'started' && goal.steps.length === 0) fail('report.goal_check.steps', 'started execution needs steps')
  if (goal.execution === 'not started' && goal.status !== 'uncertain') fail('report.goal_check.status', 'execution not started requires uncertain')
  if (goal.status === 'uncertain' && goal.question === undefined) fail('report.goal_check.question', 'uncertainty needs an owner question, not an invented defect')
  unique(brief.accounts.map((item) => item.alias), 'brief.accounts')
  const accounts = new Map(brief.accounts.map((item) => [item.alias, item.permission]))
  const context = report.account_context
  unique(context.used_accounts.map((item) => item.alias), 'report.account_context.used_accounts')
  for (const { alias, permission } of context.used_accounts) {
    if (!accounts.has(alias)) fail('report.account_context.used_accounts', `account ${alias} is not in brief`)
    else if (accounts.get(alias) !== permission) fail('report.account_context.used_accounts', `permission for ${alias} does not match brief`)
  }
  if (context.signed_out !== (context.used_accounts.length === 0)) fail('report.account_context', 'signed-out context must have no used accounts; signed-in context needs an alias')
  if (brief.mode !== 'session' && (brief.accounts.length > 0 || !context.signed_out)) fail('report.account_context', 'quick modes must be signed out and have no brief accounts')
  if (report.mode === 'session' && context.used_accounts.length > 0 && report.audit_summary === undefined) fail('report.audit_summary', 'account use requires observed-traffic audit summary')
  if (report.audit_summary !== undefined && report.audit_summary.complete !== (report.audit_summary.gaps.length === 0)) fail('report.audit_summary', 'incomplete audit needs gaps; complete audit cannot claim gaps')
  const mandatoryIncomplete = brief.criteria.some((criterion) => criterion.mandatory && report.criteria.find((item) => item.id === criterion.id)?.status !== 'PASS')
  const open = report.findings.filter((finding) => finding.status === 'open')
  const verdict = goal.status !== 'achieved' || mandatoryIncomplete || open.some((finding) => ['blocker', 'major'].includes(finding.severity))
    ? 'NO-GO' : open.length > 0 ? 'GO WITH ISSUES' : 'GO'
  if (report.verdict !== verdict) fail('report.verdict', `expected ${verdict} from goal, mandatory results and open findings`)
  return errors
}

export function runReportCheck(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help')) { stdout.write('Usage: bmn qa report check REPORT --brief BRIEF\nExit: 0 valid (verdict may be NO-GO), 1 invalid/unreadable, 2 usage\n'); return 0 }
  if (argv.length !== 3 || argv[1] !== '--brief' || argv[0].startsWith('--') || argv[2].startsWith('--')) { stderr.write('Usage: bmn qa report check REPORT --brief BRIEF\n'); return 2 }
  const documents = []
  for (const [kind, path] of [['report', argv[0]], ['brief', argv[2]]]) {
    try { documents.push(JSON.parse(readFileSync(path, 'utf8'))) } catch { stderr.write(`$.${kind}: cannot read JSON from ${path}\n`); return 1 }
  }
  const errors = checkQaReport(documents[0], documents[1])
  if (errors.length) { stderr.write(`${errors.join('\n')}\n`); return 1 }
  stdout.write(`PASS: valid QA report (${documents[0].verdict}); observations are not authenticated\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runReportCheck(process.argv.slice(2))
