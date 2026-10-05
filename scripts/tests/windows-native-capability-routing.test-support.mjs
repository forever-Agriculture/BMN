import { resolve } from 'node:path'

/** Native process substitution belongs only to this exact source module. */
export const workerOnlySubprocessRoute = workerPath => args =>
  args.path === 'node:child_process' && resolve(args.importer) === resolve(workerPath)
    ? { path: args.path, namespace: 'synthetic-native' } : undefined
