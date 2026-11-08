#!/usr/bin/env node
// MODULE: bench-receipt.mjs - finalize a declared lead-run QA receipt only after generation-bound shutdown
import { parseArgs } from 'node:util'
import { configFor } from './bench-state.mjs'
import { finishBenchQa } from './bench-qa-record.mjs'
const { values } = parseArgs({ options: { 'run-id': { type: 'string' }, report: { type: 'string' } } })
if (!values['run-id'] || !values.report) throw new Error('Expected --run-id GENERATION --report REPORT.json')
const config = configFor(values['run-id'])
console.log(JSON.stringify(finishBenchQa({ run: config.run, runId: config.runId, reportPath: values.report }), null, 2))
