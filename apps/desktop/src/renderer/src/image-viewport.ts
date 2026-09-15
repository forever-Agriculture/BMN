// MODULE: image-viewport.ts - pure zoom/pan math for the artifact image preview viewport
export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** `pan` is the image center's offset from the viewport center, in viewport pixels. */
export interface ViewportState {
  scale: number
  pan: Point
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

/** The scale that fits `image` entirely inside `viewport`, preserving aspect ratio. */
export function fitScale(image: Size, viewport: Size): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(viewport.width / image.width, viewport.height / image.height)
}

/**
 * Keeps the scaled image covering the viewport when it is larger than it, and centered (no offset)
 * on any axis where it fits inside the viewport.
 */
export function clampPan(pan: Point, image: Size, viewport: Size, scale: number): Point {
  const clampAxis = (value: number, scaledSize: number, viewportSize: number): number => {
    const maxOffset = Math.max(0, (scaledSize - viewportSize) / 2)
    return Math.min(maxOffset, Math.max(-maxOffset, value))
  }
  return {
    x: clampAxis(pan.x, image.width * scale, viewport.width),
    y: clampAxis(pan.y, image.height * scale, viewport.height)
  }
}

/**
 * Zooms `state` by `factor` (>1 zooms in, <1 zooms out) while holding the image point under `point`
 * fixed on screen. `point` is in the same viewport-pixel space as `pan` (offset from the viewport
 * center). The resulting scale is clamped to [MIN_SCALE, MAX_SCALE]; pan is left unclamped to the
 * image bounds here -- callers apply `clampPan` afterward once the viewport size is known.
 */
export function zoomAt(state: ViewportState, factor: number, point: Point): ViewportState {
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor))
  const applied = state.scale === 0 ? 1 : nextScale / state.scale
  return {
    scale: nextScale,
    pan: {
      x: point.x * (1 - applied) + applied * state.pan.x,
      y: point.y * (1 - applied) + applied * state.pan.y
    }
  }
}
