// MODULE: native-settle.mjs - Epic 125.1 AC5: a native driver types its first prompt only on a screen that stood still and is still the app's bare prompt

/**
 * Waits until the screen has not changed for `quietMs`, then reads that screen again with `composer`. An app can show its
 * prompt, redraw it, or put a dialog over it after it first looked ready: readiness read before this wait is not enough.
 * Throws, and so types nothing, when the screen never stood still within `limitMs` or the settled screen is not the bare prompt.
 */
export async function settledBeforeTyping({ screen, sleep, now = Date.now, composer, quietMs = 5000, limitMs = 90000, stepMs = 500 }) {
  let before = (await screen()).join('\n'), since = now()
  const limit = now() + limitMs
  while (now() - since < quietMs && now() < limit) {
    await sleep(stepMs)
    const current = (await screen()).join('\n')
    if (current !== before) { before = current; since = now() }
  }
  const stood = now() - since
  if (stood < quietMs) throw new Error(`UNVERIFIED: the screen never stood still for ${quietMs} ms before the first prompt; nothing was typed`)
  if (!composer(before)) throw new Error("UNVERIFIED: the settled screen is not the app's bare prompt (a dialog or another screen); nothing was typed")
  return { stood, text: before }
}
