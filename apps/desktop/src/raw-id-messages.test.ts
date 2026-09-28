// MODULE: raw-id-messages.test.ts - FR73: no error the desktop app throws names a session by its raw id
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('.', import.meta.url))
// The desktop package compiles with TypeScript 7, which has no JavaScript API; the workspace root pins 6's.
const ts = createRequire(join(sourceRoot, '../../../package.json'))('typescript') as typeof import('typescript')
/** Test code, the self-test and its probes speak to developers, not the owner. */
const developerOnly = /(\.test\.tsx?$|[\\/]self-test[\\/]|-self-test\.ts$|[\\/]test-hook\.ts$|-probe\.ts$)/u

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) && !developerOnly.test(path) ? [path] : []
  })
}

/** Template literals inside `throw` or `new …Error(…)` whose text puts a value right after the word "session". */
function rawSessionIdMessages(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines: number[] = []
  const namesSession = (node: ts.TemplateExpression): boolean =>
    [node.head.text, ...node.templateSpans.slice(0, -1).map((span) => span.literal.text)]
      .some((literal) => /\bsession $/iu.test(literal))
  const visit = (node: ts.Node, inError: boolean): void => {
    const errorSite = inError || ts.isThrowStatement(node) ||
      (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(source)))
    if (errorSite && ts.isTemplateExpression(node) && namesSession(node)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    ts.forEachChild(node, (child) => visit(child, errorSite))
  }
  visit(source, false)
  return lines
}

describe('owner-facing errors (Story 38.1 FR73)', () => {
  it('finds a raw session id in a thrown message and passes an id-free one', () => {
    expect(rawSessionIdMessages('probe.ts', 'throw new Error(`Session ${id} was not found`)')).toEqual([1])
    expect(rawSessionIdMessages('probe.ts', 'throw new MainIpcError(code,\n  `Started session ${id} failed`)')).toEqual([2])
    expect(rawSessionIdMessages('probe.ts', "throw new Error('The session was not found')")).toEqual([])
    expect(rawSessionIdMessages('probe.ts', 'console.error(`session ${id} restored`)')).toEqual([])
  })

  it('never names a session by its raw id in any error the desktop app throws', () => {
    const found = sourceFiles(sourceRoot).flatMap((path) =>
      rawSessionIdMessages(path, readFileSync(path, 'utf8')).map((line) => `${relative(sourceRoot, path)}:${line}`))
    expect(found).toEqual([])
  })
})
