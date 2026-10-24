// MODULE: terminal-states.test.mjs - Story 91.2 AC3: captures are read back to the pixel through every PNG filter, and two captures compared pixel by pixel
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng, differingPixels, stateBytes } from '../test/terminal-states.mjs'

/** A PNG of `rows` (each an array of [r, g, b, a]), every row written with the filter given for it. */
function png(rows, filters, channels = 4) {
  const width = rows[0].length
  const stride = width * channels
  const raw = []
  let previous = new Array(stride).fill(0)
  for (const [index, row] of rows.entries()) {
    const line = row.flatMap((pixel) => pixel.slice(0, channels))
    const filter = filters[index]
    const encoded = line.map((value, at) => {
      const left = at >= channels ? line[at - channels] : 0
      const up = previous[at]
      const upLeft = at >= channels ? previous[at - channels] : 0
      const estimate = left + up - upLeft
      const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
      const paeth = a <= b && a <= c ? left : b <= c ? up : upLeft
      return (value - [0, left, up, (left + up) >> 1, paeth][filter] + 256) & 255
    })
    raw.push(filter, ...encoded)
    previous = line
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(rows.length, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))])
}

const rows = [
  [[10, 20, 30, 255], [200, 100, 50, 255], [0, 255, 0, 128]],
  [[11, 22, 33, 255], [199, 98, 51, 255], [255, 0, 255, 255]],
  [[250, 250, 250, 255], [3, 2, 1, 255], [128, 128, 128, 255]],
  [[9, 8, 7, 255], [60, 70, 80, 255], [90, 100, 110, 255]],
  [[1, 1, 1, 255], [254, 254, 254, 255], [77, 66, 55, 255]]
]

describe('terminal state captures (Story 91.2 AC3)', () => {
  it('reads every pixel back through the None, Sub, Up, Average and Paeth filters', () => {
    const { width, height, pixels } = decodePng(png(rows, [0, 1, 2, 3, 4]))
    expect([width, height]).toEqual([3, 5])
    expect([...pixels]).toEqual(rows.flat(2))
  })

  it('reads an RGB capture with every alpha opaque', () => {
    const { pixels } = decodePng(png(rows, [4, 3, 2, 1, 0], 3))
    expect([...pixels]).toEqual(rows.flat().flatMap(([r, g, b]) => [r, g, b, 255]))
  })

  it('counts the pixels two captures differ in, and refuses captures of different sizes', () => {
    const changed = rows.map((row) => row.map((pixel) => [...pixel]))
    changed[2][1] = [4, 2, 1, 255]
    changed[4][0][3] = 254
    expect(differingPixels(decodePng(png(rows, [0, 0, 0, 0, 0])), decodePng(png(changed, [1, 2, 3, 4, 0])))).toBe(2)
    expect(differingPixels(decodePng(png(rows, [0, 0, 0, 0, 0])), decodePng(png(rows.slice(1), [0, 0, 0, 0])))).toBeNull()
  })

  it('ends every state on a line that names it, after clearing nothing itself', () => {
    for (const [name, bytes] of Object.entries(stateBytes())) {
      expect(bytes.split('\r\n').some((line) => line.startsWith(`STATE ${name}`))).toBe(true)
      expect(bytes).not.toContain('\u001b[2J')
    }
  })
})
