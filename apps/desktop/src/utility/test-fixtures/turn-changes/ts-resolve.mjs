// MODULE: ts-resolve.mjs - lets plain Node run this repository's TypeScript in a test's child process or worker: an import without an ending is looked for as a .ts file, read as a module
//
// node --import ./ts-resolve.mjs some-file.ts
// Node strips the types by itself; the app's own build is not involved, so a child that must be
// traced alone (the hostile repository) runs nothing but Node and what the code under test starts.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return nextLoad(url, url.endsWith('.ts') ? { ...context, format: 'module-typescript' } : context)
  }
})
