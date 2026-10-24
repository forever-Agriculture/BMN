// MODULE: auto-test-words.ts - what a row says about the test BMN runs by itself, and when it offers Test again (Story 75.8)
import { ROSTER_APP_NAMES, type AutoTestKind, type AutoTestsView, type RosterHarness } from '@bmn/protocol'

type Stop = AutoTestsView['stopped'][number]

/** The test of this kind BMN stopped trying for this app on its installed version, if it did. */
export function stoppedTest(auto: AutoTestsView, kind: AutoTestKind, harness: RosterHarness): Stop | undefined {
  return auto.stopped.find((entry) => entry.kind === kind && entry.harness === harness)
}

/** Whether BMN is running this test for this app right now. */
export function testRunning(auto: AutoTestsView, kind: AutoTestKind | readonly AutoTestKind[], harness: RosterHarness): boolean {
  const kinds: readonly AutoTestKind[] = typeof kind === 'string' ? [kind] : kind
  return auto.running !== null && auto.running.harness === harness && kinds.includes(auto.running.kind)
}

/** Said in a row's faint line once BMN stopped trying: how often, on which version, and why, as the last try said. */
export function stoppedWords(stop: Pick<Stop, 'tries' | 'version' | 'detail'>): string {
  return `BMN stopped after ${stop.tries} tries on ${stop.version}${stop.detail ? `: ${stop.detail}` : ''}`
}

/** Said while BMN runs the test. */
export function runningWords(harness: RosterHarness): string {
  return `BMN is testing ${ROSTER_APP_NAMES[harness]} now…`
}

/**
 * Whether a row offers Test again: only once BMN's own tries are over, because the test failed on the installed
 * version or BMN stopped trying it. Otherwise BMN runs the test itself and no button is there for it.
 */
export function offersTestAgain(auto: AutoTestsView, kind: AutoTestKind, harness: RosterHarness, failedOnVersion: boolean): boolean {
  if (testRunning(auto, kind, harness)) return false
  return failedOnVersion || stoppedTest(auto, kind, harness) !== undefined
}
