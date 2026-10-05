// MODULE: windows-update-decisions.mjs - parent-owned decision latch for the Windows update progress window
import assert from 'node:assert/strict'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const actions = new Set(['ready', 'dismissed', 'completion-closed', 'unavailable'])

/** Parent-owned state. A complete immutable ledger prevents a fast UI exit
 * overwriting an unseen ready/dismiss event. No child frame selects a payload. */
export class WindowsUpdateDecisionLatch {
  #attempt; #observation; #events = []; #ready = false; #suppressed = false
  #completionRequested = false; #acknowledged = false; #exited = false; #unavailable = false
  constructor({ attemptId, observationId }) {
    assert.match(attemptId, uuid); assert.match(observationId, uuid)
    this.#attempt = attemptId; this.#observation = observationId
  }
  requestCompletionClose() {
    assert.equal(this.#exited, false, 'Cannot close an already exited UI')
    this.#completionRequested = true
  }
  accept(ledger) {
    assert.equal(ledger.format, 1)
    assert.equal(ledger.attemptId, this.#attempt); assert.equal(ledger.observationId, this.#observation)
    assert.ok(Array.isArray(ledger.events) && ledger.events.length <= 4 && ledger.events.length >= this.#events.length)
    assert.deepEqual(ledger.events.slice(0, this.#events.length), this.#events, 'Decision history was replaced')
    // Validate the entire extension before changing parent-owned state.
    let ready = this.#ready, suppressed = this.#suppressed, acknowledged = this.#acknowledged, unavailable = this.#unavailable
    for (const event of ledger.events.slice(this.#events.length)) {
      assert.deepEqual(Object.keys(event).sort(), ['action', 'sequence'])
      assert.equal(event.sequence, this.#events.length + ledger.events.slice(this.#events.length).indexOf(event) + 1)
      assert.ok(actions.has(event.action)); assert.equal(acknowledged || unavailable, false, 'UI decision follows a terminal acknowledgement')
      if (event.action === 'ready') { assert.equal(ready, false); ready = true }
      if (event.action === 'dismissed') { assert.equal(ready, true); suppressed = true }
      if (event.action === 'completion-closed') { assert.equal(ready, true); assert.equal(this.#completionRequested, true); acknowledged = true }
      if (event.action === 'unavailable') { assert.equal(ready, false); unavailable = true }
    }
    this.#events = structuredClone(ledger.events); this.#ready = ready; this.#suppressed = suppressed
    this.#acknowledged = acknowledged; this.#unavailable = unavailable
  }
  observeExit(finalLedger) {
    assert.equal(this.#exited, false, 'UI exit already observed')
    if (finalLedger !== undefined) {
      try { this.accept(finalLedger) } catch {
        // Invalid final history is an unknown exit; it can never grant opening.
        if (this.#ready) this.#suppressed = true
        else this.#unavailable = true
      }
    }
    this.#exited = true
    if (this.#ready && !this.#acknowledged) this.#suppressed = true
    if (!this.#ready) this.#unavailable = true
  }
  get state() {
    return Object.freeze({ ready: this.#ready, suppressed: this.#suppressed, acknowledged: this.#acknowledged,
      exited: this.#exited, unavailable: this.#unavailable,
      autoOpenAfterSuccessfulUpdate: this.#exited && this.#acknowledged && !this.#suppressed,
      notificationFallbackNeeded: this.#exited && this.#unavailable })
  }
}
