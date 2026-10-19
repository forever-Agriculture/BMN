// MODULE: shared-helpers.ts - the one copy of each small helper the utility process's modules share: a turn for the terminals and two value checks (Story 80.15)
// Checks the renderer or the protocol also use live in @bmn/protocol's shared-helpers.ts instead.

/** Leaves the event loop one turn (setImmediate), so the terminals' output is not held up by a long walk or search. Not bin's `pause(ms)`, which waits. */
export const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A string that is not empty. */
export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Any object, an array included: unlike @bmn/protocol's `isRecord`, an array passes. */
export function isObjectOrArray(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}
