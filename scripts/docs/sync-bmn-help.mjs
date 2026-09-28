// MODULE: sync-bmn-help.mjs - rewrites the command block in docs/agent-control.md from what `bmn help` prints
// control-cli.test.ts fails when the two differ and names this script (`pnpm run docs:bmn-help`).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const doc = join(repoRoot, 'docs/agent-control.md')
export const BEGIN = '<!-- BEGIN `bmn help` (generated: pnpm run docs:bmn-help) -->'
export const END = '<!-- END `bmn help` -->'

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BMN_')))
const help = execFileSync(process.execPath, [join(repoRoot, 'apps/desktop/bin/bmn'), 'help'], { env, encoding: 'utf8' })
const text = readFileSync(doc, 'utf8')
const start = text.indexOf(BEGIN)
const end = text.indexOf(END)
if (start < 0 || end < start) throw new Error(`docs/agent-control.md has no ${BEGIN} … ${END} block`)
writeFileSync(doc, `${text.slice(0, start)}${BEGIN}\n\`\`\`text\n${help}\`\`\`\n${text.slice(end)}`)
console.log('docs/agent-control.md: command block matches `bmn help`')
