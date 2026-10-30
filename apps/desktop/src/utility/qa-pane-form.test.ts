// MODULE: qa-pane-form.test.ts - QA panes narrow native tools without changing ordinary teammate asks
import { expect, it } from 'vitest'
import { askCommand } from '../../bin/agents-team-forms.mjs'

const request = { model: 'synthetic-qa', effort: 'high', cwd: '/synthetic/qa', folder: '/synthetic/qa', environment: { HOME: '/synthetic/home', PATH: '/usr/bin' }, inherited: [{ name: 'unrelated', transport: 'stdio' as const }] }
const program = { launcher: '/synthetic/codex', payload: '/synthetic/codex' }
const configs = (command: string[]) => command.filter((_, index) => command[index - 1] === '-c')
it('the QA form turns off shell, collaboration, web and implicit instructions while retaining read-only sandboxing', () => {
  const built = askCommand('codex', program, { ...request, form: 'codex-qa' })
  for (const item of ['features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false', 'web_search="disabled"', 'features.apps=false', 'features.plugins=false', 'project_doc_max_bytes=0', 'include_environment_context=false']) expect(configs(built.command)).toContain(item)
  expect(built.command.slice(built.command.indexOf('--sandbox'), built.command.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only'])
  expect(configs(built.command).join(' ')).toContain('"unrelated"={enabled=false}')
  for (const feature of ['view_image', 'goals', 'image_generation', 'sleep_tool', 'hooks']) expect(built.command.some((arg, index) => arg === '--disable' && built.command[index + 1] === feature)).toBe(true)
})
it('ordinary teammate asks retain their established read-only tool form', () => {
  const built = askCommand('codex', program, { ...request, form: 'codex-read-only' })
  expect(configs(built.command)).not.toContain('features.shell_tool=false')
  expect(configs(built.command)).not.toContain('web_search="disabled"')
})
