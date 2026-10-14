// MODULE: traced-capture.ts - the one process that runs under a trace in the hostile repository test: two captures with a pause between them, their comparison and every file's difference
//
// node --import ./ts-resolve.mjs traced-capture.ts <spec.json>
// It prints PAUSE after the first capture and goes on when a line arrives, so that the test, which is
// not traced, can replace the repository's settings in between.
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { capture, isRefusal } from '../../turn-changes-capture'
import { compareCaptures, fileDifference } from '../../turn-changes-compare'
import type { TurnGitCall } from '../../turn-changes-git'
import { TurnStore, type TurnCaptureRecord } from '../../turn-changes-store'

const spec = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as { repo: string; home: string; dataRoot: string; result: string }
const calls: TurnGitCall[] = []
const options = { home: spec.home, dataRoot: spec.dataRoot, session: 's-hostile', observeGit: (call: TurnGitCall) => calls.push(call) }
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()

const first = await capture(spec.repo, options)
const one: TurnCaptureRecord | null = !isRefusal(first) && first.state === 'whole' ? ((await first.publish())?.record ?? null) : null
process.stdout.write('PAUSE\n')
await lines.next()
const second = one ? await capture(spec.repo, { ...options, base: one.id }) : null
const two: TurnCaptureRecord | null = second && !isRefusal(second) && second.state === 'whole' ? ((await second.publish())?.record ?? null) : null
const store = one ? new TurnStore(spec.dataRoot, 's-hostile', one.root) : null
const compared = store && one && two ? compareCaptures(store, one.id, two.id) : null
const differences = store && one && two && compared?.state === 'compared'
  ? Object.fromEntries(compared.files.map((row) => [row.path, fileDifference(store, one.id, two.id, row.path)]))
  : null
writeFileSync(spec.result, JSON.stringify({ first: first.state, second: second?.state ?? null, one, two, compared, differences, calls }))
process.exit(0)
