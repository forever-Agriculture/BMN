// MODULE: image-viewport.test.ts - fitScale, clampPan and zoomAt math
import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, clampPan, fitScale, zoomAt, type ViewportState } from './image-viewport'

describe('fitScale', () => {
  it('constrains by width for a wide image', () => {
    expect(fitScale({ width: 2000, height: 500 }, { width: 400, height: 400 })).toBeCloseTo(0.2)
  })

  it('constrains by height for a tall image', () => {
    expect(fitScale({ width: 500, height: 2000 }, { width: 400, height: 400 })).toBeCloseTo(0.2)
  })

  it('scales a small image up to fill the viewport', () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 400, height: 200 })).toBeCloseTo(2)
  })

  it('falls back to 1 for degenerate sizes', () => {
    expect(fitScale({ width: 0, height: 100 }, { width: 400, height: 400 })).toBe(1)
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 400 })).toBe(1)
  })
})

describe('clampPan', () => {
  const viewport = { width: 400, height: 200 }

  it('forces pan to zero on an axis where the scaled image fits inside the viewport', () => {
    const image = { width: 300, height: 100 }
    const result = clampPan({ x: 999, y: 999 }, image, viewport, 1)
    expect(result).toEqual({ x: 0, y: 0 })
  })

  it('clamps pan to the overhang when the scaled image is larger than the viewport', () => {
    // scaled image: 800x400, viewport 400x200 -> max offset is (800-400)/2=200 and (400-200)/2=100
    const image = { width: 800, height: 400 }
    expect(clampPan({ x: 500, y: 500 }, image, viewport, 1)).toEqual({ x: 200, y: 100 })
    expect(clampPan({ x: -500, y: -500 }, image, viewport, 1)).toEqual({ x: -200, y: -100 })
  })

  it('leaves an in-bounds pan untouched', () => {
    const image = { width: 800, height: 400 }
    expect(clampPan({ x: 50, y: -25 }, image, viewport, 1)).toEqual({ x: 50, y: -25 })
  })
})

describe('zoomAt', () => {
  it('leaves pan unchanged when zooming at the viewport center from a zero pan', () => {
    const state: ViewportState = { scale: 1, pan: { x: 0, y: 0 } }
    const next = zoomAt(state, 2, { x: 0, y: 0 })
    expect(next.scale).toBe(2)
    expect(next.pan).toEqual({ x: 0, y: 0 })
  })

  it('keeps the image point under the zoom point fixed on screen', () => {
    const state: ViewportState = { scale: 1, pan: { x: 10, y: -5 } }
    const point = { x: 60, y: 30 }
    const imagePointBefore = {
      x: (point.x - state.pan.x) / state.scale,
      y: (point.y - state.pan.y) / state.scale
    }
    const next = zoomAt(state, 2.5, point)
    const imagePointAfter = {
      x: (point.x - next.pan.x) / next.scale,
      y: (point.y - next.pan.y) / next.scale
    }
    expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x)
    expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y)
  })

  it('clamps scale to MAX_SCALE and stops moving pan once clamped', () => {
    const state: ViewportState = { scale: MAX_SCALE, pan: { x: 12, y: 8 } }
    const next = zoomAt(state, 4, { x: 60, y: 30 })
    expect(next.scale).toBe(MAX_SCALE)
    expect(next.pan).toEqual({ x: 12, y: 8 })
  })

  it('clamps scale to MIN_SCALE and stops moving pan once clamped', () => {
    const state: ViewportState = { scale: MIN_SCALE, pan: { x: 12, y: 8 } }
    const next = zoomAt(state, 0.1, { x: 60, y: 30 })
    expect(next.scale).toBe(MIN_SCALE)
    expect(next.pan).toEqual({ x: 12, y: 8 })
  })

  it('zooming out then back in by reciprocal factors returns to the original state', () => {
    const state: ViewportState = { scale: 1.6, pan: { x: -20, y: 40 } }
    const point = { x: -10, y: 5 }
    const out = zoomAt(state, 0.5, point)
    const back = zoomAt(out, 2, point)
    expect(back.scale).toBeCloseTo(state.scale)
    expect(back.pan.x).toBeCloseTo(state.pan.x)
    expect(back.pan.y).toBeCloseTo(state.pan.y)
  })
})
