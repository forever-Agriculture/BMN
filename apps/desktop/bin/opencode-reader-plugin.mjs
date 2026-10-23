// MODULE: opencode-reader-plugin.mjs - Fail-closed OpenCode 2 project tools and one bounded reader child
import { fileURLToPath } from 'node:url'
import { openProjectReader, singleReaderChild } from './opencode-project-reader.mjs'
import { createChildAccounting } from './opencode-child-accounting.mjs'
import { runReaderChild } from './opencode-reader-child.mjs'

const deny = () => { throw new Error('BMN read-only project boundary refused this operation') }
const string = { type: 'string' }
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const readers = new Set(['bmn-helper', 'bmn-ask-reader', 'bmn-reader'])
const historians = new Set(['bmn-ask-reader', 'bmn-reader'])

export default {
  id: 'bmn.read-only',
  async setup(ctx) {
    const state = ctx.options?.state ?? fileURLToPath(new URL('../../../../state/bmn-reader', import.meta.url))
    const admit = singleReaderChild(state)
    const accounting = createChildAccounting(state)
    const reader = openProjectReader(ctx.location.directory)
    const allowed = async (action, context, roles = readers) => {
      if (!roles.has(context.agent)) deny()
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
        source: { type: 'tool', messageID: context.messageID, id: context.id }, action, resources: ['*'], save: [] })
    }
    const tool = (name, description, input, run, roles = readers) => ({ name, description, input, options: { codemode: false },
      async execute(value, context) {
        await allowed(name, context, roles)
        const content = await run(value, context)
        return typeof content === 'object' && content !== null && Object.hasOwn(content, 'metadata') ? content :
          { content: typeof content === 'string' ? content : JSON.stringify(content) }
      }
    })
    try {
      await ctx.tool.transform(editor => {
        // Native file/shell/delegation implementations never become an unrestricted fallback.
        for (const name of ['read', 'glob', 'grep', 'list', 'shell', 'subagent']) editor.remove(name)
        editor.add(tool('bmn_read', 'Read a text file inside this project. Symlinks and paths outside the project are refused.',
          schema({ path: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']),
          value => reader.read(value.path, value)))
        editor.add(tool('bmn_glob', 'Find project-relative paths matching a glob. Optional path narrows the search; Git metadata and dependency directories are not traversed.',
          schema({ pattern: string, path: string }, ['pattern']), (value, context) => reader.glob(value.pattern, value.path, { signal: context.signal })))
        editor.add(tool('bmn_grep', 'Search project text with an extended regular expression. Optional path narrows the search and include is a project-relative glob.',
          schema({ pattern: string, path: string, include: string }, ['pattern']), (value, context) => reader.grep(value.pattern, value.path, value.include, { signal: context.signal })))
        editor.add(tool('bmn_git', 'Read project Git history. Pass argv starting with log, show, diff or blame; shell syntax and write options are refused.',
          schema({ argv: { type: 'array', items: string, minItems: 1, maxItems: 64 } }, ['argv']), value => reader.git(value.argv), historians))
        editor.add(tool('bmn_subagent', 'Ask the one permitted read-only child to perform a bounded project task. A second request, retries and child delegation are refused.',
          schema({ prompt: string, description: string }, ['prompt']),
          (value, context) => runReaderChild(ctx, context, value, admit, { accounting }), new Set(['bmn-ask-reader'])))
      })
    } catch (error) { reader.close(); throw error }
    return () => reader.close()
  }
}
