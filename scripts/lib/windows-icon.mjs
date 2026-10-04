// Windows Vista+ ICO supports an embedded PNG. Preserve the repository bitmap
// byte-for-byte; this is packaging conversion, not a new visual design.
import assert from 'node:assert/strict'
export function windowsIconFromPng(png) {
  assert.ok(Buffer.isBuffer(png) && png.length > 24)
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Icon source is not PNG')
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  assert.ok(width === height && width >= 1 && width <= 256, 'Windows icon requires a square PNG up to 256 pixels')
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
  header[6] = width === 256 ? 0 : width; header[7] = height === 256 ? 0 : height
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}
