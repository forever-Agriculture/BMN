// MODULE: agents-team-pictures.test.ts - Story 72.8: a picture made ready to send: its type and bounds, its metadata taken out of PNG, JPEG and WebP by byte edits (oriented pictures, colour profiles, transparency, decoded size) or the picture refused; then asked about in BMN's real container, Codex given it with -i and Claude Code as one stream-json message; synthetic pictures, stand-in apps, no provider reached
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAsk } from '../../bin/agents-check.mjs'
import { containerStarts } from '../../bin/agents-container.mjs'
import { ASK_RUN_FILES, claudePictureMessage } from '../../bin/agents-team-forms.mjs'
import { LIMITS } from '../../bin/agents-team-inputs.mjs'
import { pictureFile, pictureType, treatExif, treatPicture } from '../../bin/agents-team-pictures.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { exportAsk, startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { askFeatures } from '../../bin/agents-team-cli.mjs'
import { EXAMPLE, approve, leftovers, settle, stubOpenCode, goSignInInBmnFolder, teamAskHome } from './test-fixtures/team-ask-harness'

// Synthetic pictures Pillow made once (16x8, a red square): a JPEG with its JFIF header only, a lossy WebP and a lossless WebP with alpha.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0zVvDXim58eJqdnrXlaKLiCQ2n2qVcooXeuwDbzhuM855rv6KK5YxUb2O6tiJVlFSt7qtovzP/9k=', 'base64')
const WEBP_LOSSY = Buffer.from('UklGRnAAAABXRUJQVlA4IGQAAAAwAgCdASoQAAgAAUAmJagCdAXAiaWxl35AAAD+8pP1gELxOj/nHfkI1Zimev279Wf9p+cbrwvb0T+GPQaeDC7fvuqA5n/VcDddsgGsTsp2Owl/1/+Jgcf/P++//97o9qfDTIAA', 'base64')
const WEBP_LOSSLESS = Buffer.from('UklGRj4AAABXRUJQVlA4TDEAAAAvD8ABEBcgEEjC2h9mJoFAkj/hGCMIBJLY9kcYZv4D/hUQBIJInsRes64Q0f8I1gcAAA==', 'base64')
const PLANTED = ['MADE-UP-MAKE', 'MADE-UP-MODEL', 'MADE-UP-SERIAL', 'MADE-UP-GPS', 'MADE-UP-XMP', 'MADE-UP-TEXT', 'MADE-UP-COMMENT', 'MADE-UP-IPTC', 'MADE-UP-TRAILER', 'MADE-UP-THUMB']
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const leftIn = (bytes: Buffer): string[] => PLANTED.filter((word) => bytes.includes(word))
const code = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as Error).message}`
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Building synthetic pictures by their bytes

type Entry = { tag: number; type: 2 | 3 | 4 | 5 | 7; value: number | Buffer }
const ascii = (text: string): Buffer => Buffer.from(`${text}\0`, 'latin1')
/** An EXIF body (a TIFF): the first directory, the camera-settings and GPS directories it points to, and a thumbnail directory after it. */
function exifBody(order: 'II' | 'MM', dirs: { ifd0: Entry[]; exif?: Entry[]; gps?: Entry[]; ifd1?: Entry[] }): Buffer {
  const little = order === 'II'
  const ifd0 = [...dirs.ifd0, ...(dirs.exif ? [{ tag: 0x8769, type: 4, value: 0 } as Entry] : []), ...(dirs.gps ? [{ tag: 0x8825, type: 4, value: 0 } as Entry] : [])]
  const list = [ifd0, dirs.exif, dirs.gps, dirs.ifd1].filter((dir): dir is Entry[] => dir !== undefined)
  const offsets: number[] = []
  let at = 8
  for (const dir of list) {
    offsets.push(at)
    at += 2 + 12 * dir.length + 4
  }
  const head = Buffer.alloc(at)
  const data: Buffer[] = []
  let dataAt = at
  const w16 = (value: number, where: number): void => void (little ? head.writeUInt16LE(value, where) : head.writeUInt16BE(value, where))
  const w32 = (value: number, where: number): void => void (little ? head.writeUInt32LE(value, where) : head.writeUInt32BE(value, where))
  head.write(order, 0, 'latin1')
  w16(42, 2)
  w32(8, 4)
  list.forEach((dir, index) => {
    const base = offsets[index]!
    w16(dir.length, base)
    dir.forEach((entry, n) => {
      const where = base + 2 + 12 * n
      w16(entry.tag, where)
      w16(entry.type, where + 2)
      let value = entry.value
      if (entry.tag === 0x8769) value = offsets[list.indexOf(dirs.exif!)]!
      if (entry.tag === 0x8825) value = offsets[list.indexOf(dirs.gps!)]!
      if (typeof value === 'number') {
        w32(1, where + 4)
        if (entry.type === 3) w16(value, where + 8)
        else w32(value, where + 8)
      } else {
        w32(entry.type === 5 ? value.length / 8 : value.length, where + 4)
        if (value.length <= 4) value.copy(head, where + 8)
        else {
          w32(dataAt, where + 8)
          data.push(value)
          dataAt += value.length
        }
      }
    })
    // The first directory's next is the thumbnail's.
    w32(index === 0 && dirs.ifd1 ? offsets[list.indexOf(dirs.ifd1)]! : 0, base + 2 + 12 * dir.length)
  })
  return Buffer.concat([head, ...data])
}
const rational = (...values: number[]): Buffer => Buffer.concat(values.map((value) => {
  const out = Buffer.alloc(8)
  out.writeUInt32LE(value, 0)
  out.writeUInt32LE(1, 4)
  return out
}))
/** A phone photo's EXIF: make, model, orientation, GPS, a serial number, a comment and a thumbnail. */
const cameraExif = (order: 'II' | 'MM' = 'II', orientation = 6): Buffer => exifBody(order, {
  ifd0: [{ tag: 0x010f, type: 2, value: ascii('MADE-UP-MAKE') }, { tag: 0x0110, type: 2, value: ascii('MADE-UP-MODEL') }, { tag: 0x0112, type: 3, value: orientation }, { tag: 0x011a, type: 5, value: rational(72) }],
  exif: [{ tag: 0xa431, type: 2, value: ascii('MADE-UP-SERIAL') }, { tag: 0x9286, type: 7, value: Buffer.from('ASCII\0\0\0MADE-UP-TEXT') }, { tag: 0x829a, type: 5, value: rational(1) }],
  gps: [{ tag: 1, type: 2, value: ascii('N') }, { tag: 2, type: 5, value: rational(50, 27, 0) }, { tag: 27, type: 7, value: Buffer.from('MADE-UP-GPS') }],
  ifd1: [{ tag: 0x0201, type: 4, value: 0 }, { tag: 0x010e, type: 2, value: ascii('MADE-UP-THUMB') }]
})
const orientationOnly = (order: 'II' | 'MM', value: number): Buffer => exifBody(order, { ifd0: [{ tag: 0x0112, type: 3, value }] })

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, tail])
}
function ihdr(width: number, height: number, colour = 6, depth = 8): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = colour
  return chunk('IHDR', data)
}
const idat = (bytes = 16 * (1 + 8 * 4)): Buffer => chunk('IDAT', deflateSync(Buffer.alloc(bytes, 0x7f)))
const iend = chunk('IEND', Buffer.alloc(0))
const png = (...chunks: Buffer[]): Buffer => Buffer.concat([PNG_SIGNATURE, ...chunks])
const ICC = Buffer.concat([Buffer.from('made-up colour profile '), Buffer.alloc(40, 7)])

function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([head, data])
}
/** The fixture JPEG with segments put after its JFIF header (which ends at byte 20). */
const jpeg = (...segments: Buffer[]): Buffer => Buffer.concat([JPEG.subarray(0, 20), ...segments, JPEG.subarray(20)])
const JFIF_WITH_THUMBNAIL = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 2, 1]), Buffer.from('MADE-UP-THUMB'.slice(0, 6))]))
const XMP = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/">MADE-UP-XMP</x:xmpmeta>')

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(fourcc, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}
function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}
const imageChunk = (webp: Buffer): Buffer => webp.subarray(12, 20 + webp.readUInt32LE(16) + (webp.readUInt32LE(16) % 2))
function vp8x(flags: number, width = 16, height = 8): Buffer {
  const data = Buffer.alloc(10)
  data[0] = flags
  data.writeUIntLE(width - 1, 4, 3)
  data.writeUIntLE(height - 1, 7, 3)
  return riffChunk('VP8X', data)
}

// ---------------------------------------------------------------------------------------------

describe('a picture made ready to send (72.8 AC1, AC2)', () => {
  it('a PNG keeps its picture data, colour profile, transparency and orientation, every other chunk out by name, the bytes otherwise its own', () => {
    const original = png(ihdr(16, 8), chunk('iCCP', Buffer.concat([Buffer.from('made-up\0\0'), deflateSync(ICC)])), chunk('tEXt', Buffer.from('Author\0MADE-UP-TEXT', 'latin1')),
      chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), XMP])), chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), deflateSync(Buffer.from('MADE-UP-COMMENT'))])),
      chunk('tIME', Buffer.from([7, 234, 10, 15, 1, 2, 3])), chunk('eXIf', cameraExif('MM', 6)), chunk('prVW', Buffer.from('MADE-UP-THUMB')), idat(), iend, Buffer.from('MADE-UP-TRAILER'))
    const treated = treatPicture(original, 'shot.png')
    expect(treated).toMatchObject({ media_type: 'image/png', width: 16, height: 8, before: { bytes: original.length, sha256: sha(original) } })
    expect(treated.removed).toEqual(['PNG text "Author"', 'XMP', 'PNG text "Comment"', 'PNG modification time (tIME)', 'EXIF Make', 'EXIF Model',
      'EXIF BodySerialNumber', 'EXIF UserComment', 'EXIF GPS (3 fields)', 'EXIF thumbnail', 'EXIF other fields (2)', 'PNG chunk prVW', 'data after the end of the picture (15 bytes)'])
    expect(treated.kept).toEqual(['transparency (alpha channel)', 'colour profile (iCCP)', 'EXIF Orientation 6'])
    // What is sent is the original's own chunks, the EXIF rewritten to its orientation alone.
    expect(treated.bytes.equals(png(ihdr(16, 8), chunk('iCCP', Buffer.concat([Buffer.from('made-up\0\0'), deflateSync(ICC)])), chunk('eXIf', orientationOnly('MM', 6)), idat(), iend))).toBe(true)
    expect(treated.sha256).toBe(sha(treated.bytes))
    // Eight planted words are there to find (the zTXt comment is compressed).
    expect(leftIn(original)).toHaveLength(8)
    expect(leftIn(treated.bytes)).toEqual([])
  })

  it('a palette PNG keeps its tRNS transparency; one with nothing to take out is sent as it is', () => {
    const palette = png(ihdr(16, 8, 3), chunk('PLTE', Buffer.from([0, 0, 0, 255, 0, 0])), chunk('tRNS', Buffer.from([0])), idat(16 * 9), iend)
    const treated = treatPicture(palette, 'palette.png')
    expect(treated.kept).toEqual(['transparency (tRNS)'])
    expect(treated.removed).toEqual([])
    expect(treated.bytes.equals(palette)).toBe(true)
    expect(treated.sha256).toBe(treated.before.sha256)
  })

  it('an oriented JPEG keeps its orientation, colour profile and every coded byte; EXIF, XMP, IPTC, comments, thumbnails and a trailer go', () => {
    const icc = segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), ICC]))
    for (const order of ['II', 'MM'] as const) {
      const original = Buffer.concat([JPEG.subarray(0, 2), JFIF_WITH_THUMBNAIL,
        segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), cameraExif(order, 8)])), segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), XMP])), icc,
        segment(0xed, Buffer.from('Photoshop 3.0\0MADE-UP-IPTC', 'latin1')), segment(0xeb, Buffer.from('JP\0MADE-UP-TEXT', 'latin1')), segment(0xfe, Buffer.from('MADE-UP-COMMENT')),
        JPEG.subarray(20), Buffer.from('MADE-UP-TRAILER')])
      const treated = treatPicture(original, 'photo.jpg')
      expect(treated).toMatchObject({ media_type: 'image/jpeg', width: 16, height: 8 })
      expect(treated.removed).toEqual(['JFIF thumbnail', 'EXIF Make', 'EXIF Model', 'EXIF BodySerialNumber', 'EXIF UserComment', 'EXIF GPS (3 fields)', 'EXIF thumbnail', 'EXIF other fields (2)',
        'XMP', 'IPTC (Photoshop)', 'JPEG APP11 JP', 'JPEG comment', 'data after the end of the picture (15 bytes)'])
      expect(treated.kept).toEqual(['EXIF Orientation 8', 'colour profile (ICC)'])
      // The fixture's own JFIF header (no thumbnail) is what the treated one becomes; the tables, frame and coded data are untouched.
      expect(treated.bytes.equals(Buffer.concat([JPEG.subarray(0, 20), segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationOnly(order, 8)])), icc, JPEG.subarray(20)]))).toBe(true)
      expect(leftIn(treated.bytes)).toEqual([])
    }
  })

  it('a JPEG with no orientation keeps no EXIF at all, and its restart markers and stuffed bytes stay inside its coded data', () => {
    const exif = exifBody('II', { ifd0: [{ tag: 0x010f, type: 2, value: ascii('MADE-UP-MAKE') }] })
    const treated = treatPicture(jpeg(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif]))), 'plain.jpg')
    expect(treated.removed).toEqual(['EXIF Make'])
    expect(treated.kept).toEqual([])
    expect(treated.bytes.equals(JPEG)).toBe(true)
    // Coded data holding 0xFF00 and a restart marker is walked through to its end.
    const sos = JPEG.indexOf(Buffer.from([0xff, 0xda]))
    const header = 2 + JPEG.readUInt16BE(sos + 2)
    const coded = Buffer.concat([JPEG.subarray(0, sos + header), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), JPEG.subarray(sos + header)])
    expect(treatPicture(coded, 'coded.jpg').bytes.equals(coded)).toBe(true)
  })

  it('a WebP keeps its picture, alpha, colour profile and orientation, its header flags saying so; XMP, other chunks and a trailer go', () => {
    const lossy = riff(vp8x(0x20 | 0x10 | 0x08 | 0x04), riffChunk('ICCP', ICC), riffChunk('ALPH', Buffer.from([0, 1, 2])), imageChunk(WEBP_LOSSY),
      riffChunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), cameraExif('II', 3)])), riffChunk('XMP ', XMP), riffChunk('MADE', Buffer.from('MADE-UP-TEXT')))
    const treated = treatPicture(Buffer.concat([lossy, Buffer.from('MADE-UP-TRAILER')]), 'sticker.webp')
    expect(treated).toMatchObject({ media_type: 'image/webp', width: 16, height: 8 })
    expect(treated.removed).toEqual(['EXIF Make', 'EXIF Model', 'EXIF BodySerialNumber', 'EXIF UserComment', 'EXIF GPS (3 fields)', 'EXIF thumbnail', 'EXIF other fields (2)', 'XMP', 'WebP chunk MADE', 'data after the end of the picture (15 bytes)'])
    expect(treated.kept).toEqual(['colour profile (ICCP)', 'transparency (ALPH)', 'EXIF Orientation 3'])
    expect(treated.bytes.equals(riff(vp8x(0x20 | 0x10 | 0x08), riffChunk('ICCP', ICC), riffChunk('ALPH', Buffer.from([0, 1, 2])), imageChunk(WEBP_LOSSY), riffChunk('EXIF', orientationOnly('II', 3))))).toBe(true)
    expect(leftIn(treated.bytes)).toEqual([])
    // A lossless picture carries its alpha itself; with no orientation the EXIF flag goes with the chunk.
    const lossless = treatPicture(riff(vp8x(0x10 | 0x08 | 0x04), imageChunk(WEBP_LOSSLESS), riffChunk('EXIF', exifBody('II', { ifd0: [{ tag: 0x0110, type: 2, value: ascii('MADE-UP-MODEL') }] })), riffChunk('XMP ', XMP)), 'icon.webp')
    expect(lossless.kept).toEqual(['transparency (alpha channel)'])
    expect(lossless.bytes.equals(riff(vp8x(0x10), imageChunk(WEBP_LOSSLESS)))).toBe(true)
    // The simple forms are sent as they are.
    expect(treatPicture(WEBP_LOSSY, 'a.webp').bytes.equals(WEBP_LOSSY)).toBe(true)
    expect(treatPicture(WEBP_LOSSLESS, 'b.webp')).toMatchObject({ width: 16, height: 8, kept: ['transparency (alpha channel)'] })
  })

  it('a payload hidden inside a structure a viewer reads is taken out or refused: the end chunk, a fixed-size chunk, Adobe\'s segment, the WebP header (epic review)', () => {
    const hidden = Buffer.from('MADE-UP-TEXT, private words')
    // PNG: the end chunk is sent empty; a kept chunk of fixed size that carries more is refused.
    const ended = treatPicture(png(ihdr(16, 8), idat(), chunk('IEND', hidden)), 'end.png')
    expect(ended.removed).toEqual([`data inside the end chunk (${hidden.length} bytes)`])
    expect(ended.bytes.equals(png(ihdr(16, 8), idat(), iend))).toBe(true)
    expect(code(() => treatPicture(png(ihdr(16, 8), chunk('gAMA', Buffer.concat([Buffer.alloc(4), hidden])), idat(), iend), 'gamma.png'))).toMatch(/^PICTURE_UNTREATABLE: .*gAMA chunk of a size no viewer reads/)
    expect(code(() => treatPicture(png(ihdr(16, 8), chunk('pHYs', Buffer.concat([Buffer.alloc(9), hidden])), idat(), iend), 'phys.png'))).toMatch(/pHYs chunk of a size no viewer reads/)
    expect(code(() => treatPicture(png(ihdr(16, 8), chunk('tRNS', hidden), idat(), iend), 'alpha.png'))).toMatch(/tRNS chunk of a size no viewer reads/)
    // JPEG: Adobe's segment is written anew around its transform; its other bytes and anything after them go.
    const adobe = (version: number, transform: number, rest = Buffer.alloc(0)): Buffer => Buffer.concat([Buffer.from('Adobe', 'latin1'), Buffer.from([version >> 8, version & 0xff, 0x4d, 0x41, 0x44, 0x45, transform]), rest])
    const cmyk = treatPicture(jpeg(segment(0xee, adobe(0x4d41, 2, hidden))), 'cmyk.jpg')
    expect(cmyk.kept).toContain('colour coding (Adobe)')
    expect(cmyk.removed).toContain(`data after Adobe's colour coding (${hidden.length} bytes)`)
    expect(cmyk.bytes.includes(segment(0xee, adobe(100, 2).fill(0, 7, 11)))).toBe(true)
    expect(cmyk.bytes.includes(Buffer.from('MADE'))).toBe(false)
    expect(leftIn(treatPicture(jpeg(segment(0xee, Buffer.from('AdobeMADE-UP-TEXT'))), 'named.jpg').bytes)).toEqual([])
    // WebP: the header is its ten bytes, reserved bits zero; what a writer put after them goes.
    const header = Buffer.concat([vp8x(0).subarray(8, 18), hidden])
    header[1] = 0x4d
    const webp = treatPicture(riff(riffChunk('VP8X', header), imageChunk(WEBP_LOSSY)), 'header.webp')
    expect(webp.removed).toContain(`data after the WebP header (${hidden.length} bytes)`)
    expect(webp.bytes.equals(riff(vp8x(0), imageChunk(WEBP_LOSSY)))).toBe(true)
  })

  it('refuses what it cannot walk to the end, never sending a picture half-treated', () => {
    const refusals = {
      gif: code(() => treatPicture(Buffer.from('GIF89a\x10\x00\x08\x00', 'latin1'), 'a.gif')),
      text: code(() => treatPicture(Buffer.from('not a picture'), 'notes.txt')),
      apng: code(() => treatPicture(png(ihdr(16, 8), chunk('acTL', Buffer.alloc(8)), idat(), iend), 'moving.png')),
      damaged: code(() => {
        const bytes = png(ihdr(16, 8), idat(), iend)
        bytes.writeUInt8(bytes.readUInt8(bytes.length - 20) ^ 0xff, bytes.length - 20)
        treatPicture(bytes, 'damaged.png')
      }),
      critical: code(() => treatPicture(png(ihdr(16, 8), chunk('ZZZZ', Buffer.alloc(2)), idat(), iend), 'odd.png')),
      unended: code(() => treatPicture(png(ihdr(16, 8), idat()), 'short.png')),
      exif: code(() => treatPicture(png(ihdr(16, 8), chunk('eXIf', Buffer.from('MM\0*\0\0\0\xff', 'latin1')), idat(), iend), 'badexif.png')),
      jpegCut: code(() => treatPicture(JPEG.subarray(0, JPEG.length - 2), 'cut.jpg')),
      jpegFrames: code(() => treatPicture(jpeg(segment(0xc0, Buffer.from([8, 0, 8, 0, 16, 1, 1, 0x11, 0]))), 'two.jpg')),
      jpegHierarchical: code(() => treatPicture(jpeg(segment(0xde, Buffer.alloc(4))), 'layers.jpg')),
      webpAnimated: code(() => treatPicture(riff(vp8x(0x02), imageChunk(WEBP_LOSSY)), 'moving.webp')),
      webpCanvas: code(() => treatPicture(riff(vp8x(0, 32, 8), imageChunk(WEBP_LOSSY)), 'canvas.webp'))
    }
    expect(refusals.gif).toMatch(/^INPUT_INVALID: a\.gif is a GIF; BMN sends PNG, JPEG and WebP pictures/)
    expect(refusals.text).toBe('INPUT_INVALID: notes.txt is not a PNG, JPEG or WebP picture')
    expect(refusals.apng).toBe('PICTURE_UNTREATABLE: moving.png is animated (APNG); give one frame as a still picture; BMN sends a picture only after taking its metadata out, without re-encoding it')
    expect(refusals.damaged).toMatch(/^PICTURE_UNTREATABLE: damaged\.png has a damaged IDAT chunk/)
    expect(refusals.critical).toMatch(/^PICTURE_UNTREATABLE: odd\.png holds a ZZZZ chunk a viewer must understand/)
    expect(refusals.unended).toMatch(/^PICTURE_UNTREATABLE: short\.png has no end chunk/)
    expect(refusals.exif).toMatch(/^PICTURE_UNTREATABLE: badexif\.png carries EXIF data BMN cannot read/)
    expect(refusals.jpegCut).toMatch(/^PICTURE_UNTREATABLE: cut\.jpg is cut short inside its picture data/)
    expect(refusals.jpegFrames).toMatch(/^PICTURE_UNTREATABLE: two\.jpg holds more than one frame/)
    expect(refusals.jpegHierarchical).toMatch(/^PICTURE_UNTREATABLE: layers\.jpg holds a segment \(0xFFDE\) BMN does not know/)
    expect(refusals.webpAnimated).toMatch(/^PICTURE_UNTREATABLE: moving\.webp is animated/)
    expect(refusals.webpCanvas).toMatch(/^PICTURE_UNTREATABLE: canvas\.webp has a canvas of another size than its picture/)
  })

  it('bounds the sides and the decoded pixels: a small file that would unfold into a huge picture is refused', () => {
    expect(code(() => treatPicture(png(ihdr(8001, 8), idat(), iend), 'wide.png'))).toBe('INPUT_TOO_LARGE: wide.png is 8001x8 pixels; a side may be at most 8000')
    const bomb = png(ihdr(7000, 7000), idat(64), iend)
    expect(bomb.length).toBeLessThan(200)
    expect(code(() => treatPicture(bomb, 'bomb.png'))).toBe('INPUT_TOO_LARGE: bomb.png is 7000x7000, 49.0 million pixels once drawn; a picture may have at most 33.2 million')
    expect(treatPicture(png(ihdr(7680, 4320), idat(64), iend), '8k.png')).toMatchObject({ width: 7680, height: 4320 })
    expect(LIMITS.pictures).toBe(8)
  })

  it('reads the Orientation alone from EXIF, either byte order, and drops one that is not a valid value', () => {
    expect(treatExif(cameraExif('MM', 5), 'x')).toMatchObject({ orientation: 5 })
    expect(treatExif(cameraExif('MM', 5), 'x').tiff!.equals(orientationOnly('MM', 5))).toBe(true)
    expect(treatExif(exifBody('II', { ifd0: [{ tag: 0x0112, type: 3, value: 9 }] }), 'x')).toMatchObject({ tiff: null, orientation: null, removed: ['EXIF Orientation (not a valid value)'] })
    expect(pictureType(JPEG)).toBe('image/jpeg')
    expect(pictureType(WEBP_LOSSLESS)).toBe('image/webp')
  })
})

// ---------------------------------------------------------------------------------------------

const canContain = containerStarts().ok
const savedHome = process.env.HOME
let home: string
let stubs: string
let env: Record<string, string>
const ORIENTED = (): Buffer => Buffer.concat([JPEG.subarray(0, 20), segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), cameraExif('II', 6)])), JPEG.subarray(20), Buffer.from('MADE-UP-TRAILER')])
const SHOT = (): Buffer => png(ihdr(16, 8), chunk('tEXt', Buffer.from('Author\0MADE-UP-TEXT', 'latin1')), idat(), iend)
type Asked = Parameters<typeof prepareAsk>[0]
const ask = (request: Partial<Asked>) => prepareAsk({ role: 'designer', question: 'What do you see in these screens?', ...request } as Asked, { environment: env, cwd: home, home })

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-pictures-'))
  mkdirSync(join(home, 'shots'))
  writeFileSync(join(home, 'shots/photo.jpg'), ORIENTED())
  writeFileSync(join(home, 'shots/screen.png'), SHOT())
})

afterEach(async () => {
  await settle(() => leftovers(home).length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe('a --image as the asker names it (72.8 AC1)', () => {
  it('is a regular file the asker may give, inside the size limit, a relative path read from where it asks', () => {
    symlinkSync(join(home, 'shots/screen.png'), join(home, 'shots/link.png'))
    expect(code(() => pictureFile(join(home, 'shots/link.png'), { home }))).toMatch(/^INPUT_INVALID: .*link\.png is a link; name the file itself/)
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh/key.png'), SHOT())
    expect(code(() => pictureFile(join(home, '.ssh/key.png'), { home }))).toMatch(/^INPUT_INVALID: /)
    writeFileSync(join(home, 'shots/huge.png'), Buffer.alloc(LIMITS.picture + 1))
    expect(code(() => pictureFile(join(home, 'shots/huge.png'), { home }))).toMatch(/^INPUT_TOO_LARGE: .* over the picture limit of 5 MiB/)
    expect(pictureFile('shots/screen.png', { cwd: home, home })).toMatchObject({ path: join(home, 'shots/screen.png'), real: realpathSync(join(home, 'shots/screen.png')), removed: ['PNG text "Author"'] })
  })

  it('goes with question or files access, never project access, at most eight per ask', () => {
    expect(code(() => ask({ access: 'project', images: [join(home, 'shots/screen.png')] }))).toMatch(/^undefined: --image goes with --access question or files/)
    expect(code(() => ask({ images: Array.from({ length: 9 }, () => join(home, 'shots/screen.png')) }))).toBe('INPUT_TOO_LARGE: 9 pictures, over the limit of 8')
  })
})

describe.skipIf(!canContain)('a picture ask in BMN\'s container (72.8)', { timeout: 30_000 }, () => {
  it('Claude Code: the designer gets the treated pictures as one stream-json message with every tool off; the record keeps both hashes, what was taken out and the answer (AC1, AC2)', async () => {
    const prepared = ask({ images: [join(home, 'shots/photo.jpg'), 'shots/screen.png'] })
    expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    expect(prepared.choice).toMatchObject({ agent: 'fable' })
    expect(prepared.verdict.receipt).toMatchObject({ harness: 'claude', form: 'claude-no-tools', pictures: 2, sandbox: { tools: [] } })
    const command = prepared.argv.slice(prepared.argv.indexOf('--') + 1)
    expect(command).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--tools', '']))
    const manifest = JSON.parse(readFileSync(join(prepared.folder, ASK_RUN_FILES.manifest), 'utf8'))
    const photo = treatPicture(ORIENTED(), 'x')
    expect(manifest.pictures).toEqual([
      { label: join(home, 'shots/photo.jpg'), real: join(home, 'shots/photo.jpg'), copy: 'pictures/1.jpg', media_type: 'image/jpeg', width: 16, height: 8,
        before: { bytes: ORIENTED().length, sha256: sha(ORIENTED()) }, bytes: photo.bytes.length, sha256: photo.sha256,
        removed: ['EXIF Make', 'EXIF Model', 'EXIF BodySerialNumber', 'EXIF UserComment', 'EXIF GPS (3 fields)', 'EXIF thumbnail', 'EXIF other fields (2)', 'data after the end of the picture (15 bytes)'], kept: ['EXIF Orientation 6'] },
      expect.objectContaining({ copy: 'pictures/2.png', media_type: 'image/png', removed: ['PNG text "Author"'], kept: ['transparency (alpha channel)'] })
    ])
    expect(manifest.inputs.filter((input: { kind: string }) => input.kind === 'picture').map((input: { sha256: string }) => input.sha256)).toEqual([photo.sha256, manifest.pictures[1].sha256])
    // The prompt names the pictures in their order; the message is the pictures, then that prompt.
    const prompt = readFileSync(join(prepared.folder, ASK_RUN_FILES.prompt), 'utf8')
    expect(prompt).toBe(`What do you see in these screens?\n\nThe asker gave you these 2 pictures, attached as images in this order:\n1. ${join(home, 'shots/photo.jpg')} (JPEG, 16x8)\n2. ${join(home, 'shots/screen.png')} (PNG, 16x8)\n`)
    const message = readFileSync(join(prepared.folder, ASK_RUN_FILES.message), 'utf8')
    expect(message).toBe(claudePictureMessage([{ media_type: 'image/jpeg', bytes: photo.bytes }, { media_type: 'image/png', bytes: treatPicture(SHOT(), 'x').bytes }], prompt))
    expect(prepared.verdict.receipt?.snapshots).toMatchObject({ message: sha(message) })
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({ state: 'answered', observed: { model: 'claude-fable-5-1' } })
    // The app read exactly that message on its standard input; nothing planted reached the run or its record.
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toContain(` stdin=${sha(message)}`)
    expect(JSON.parse(readFileSync(join(prepared.folder, 'launch.json'), 'utf8')).stdin).toBe(join(prepared.folder, ASK_RUN_FILES.message))
    for (const name of ['pictures/1.jpg', 'pictures/2.png', 'message.jsonl']) expect(leftIn(readFileSync(join(prepared.folder, 'inputs', name)))).toEqual([])
    // The export carries the treated pictures and the manifest with both hashes.
    exportAsk(prepared.folder, join(home, 'bundle'))
    expect(sha(readFileSync(join(home, 'bundle/inputs/pictures/1.jpg')))).toBe(photo.sha256)
  })

  it('Codex: another role named takes the pictures with -i from the run\'s inputs, its picture tool still off (AC1, AC2)', async () => {
    const prepared = ask({ role: 'helper', images: [join(home, 'shots/screen.png')] })
    expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    expect(prepared.choice).toMatchObject({ agent: 'luna' })
    const command = prepared.argv.slice(prepared.argv.indexOf('--') + 1)
    expect(command.slice(command.indexOf('-i'), command.indexOf('-i') + 2)).toEqual(['-i', '/ask/inputs/pictures/1.png'])
    expect(command).toEqual(expect.arrayContaining(['--disable', 'view_image']))
    expect(prepared.verdict.receipt?.snapshots).not.toHaveProperty('message')
    startAsk(prepared, { timeLimitMinutes: 2 })
    expect(await waitAsk(prepared.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'answered' })
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toContain(`pictures ${treatPicture(SHOT(), 'x').sha256}`)
  })

  it('a picture or message changed after it was made is refused by the check; an app whose pictures 72.1 did not pass is refused with that reason (AC2, AC3)', () => {
    const prepared = ask({ images: [join(home, 'shots/screen.png')] })
    expect(prepared.verdict.verdict).toBe('PASS')
    const judge = () => evaluateAsk({ agent: 'fable', role: 'designer', effort: 'medium', access: 'question', data: 'private', run: prepared.folder, argv: prepared.argv }, { environment: env })
    writeFileSync(join(prepared.folder, ASK_RUN_FILES.message), readFileSync(join(prepared.folder, ASK_RUN_FILES.message), 'utf8').replace('"text":"What', '"text":"Also what'))
    expect(judge()).toMatchObject({ verdict: 'REFUSED', code: 'WORKSPACE_MISMATCH', message: 'the picture message on standard input is not the pictures and the prompt BMN wrote for this ask' })
    writeFileSync(join(prepared.folder, 'inputs/pictures/1.png'), SHOT())
    expect(judge()).toMatchObject({ verdict: 'REFUSED', code: 'WORKSPACE_MISMATCH', message: expect.stringContaining('is not the copy BMN made for this ask') })
    // OpenCode's pictures were never measured: its teammate is not asked about pictures.
    stubOpenCode(stubs)
    goSignInInBmnFolder(home)
    approve(home, EXAMPLE.replace('## roles', '## luna-go\n\n```yaml\nname: Luna (Go)\nclass: rook\nharness: opencode\nmodel: gpt-6-luna\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [high]\nroles: [designer]\n```\n\n## roles').replace('designer: {candidates: [fable@medium], then: lead}', 'designer: {candidates: [luna-go@high], then: lead}'))
    expect(code(() => ask({ agent: 'luna-go', data: 'public', images: [join(home, 'shots/screen.png')] }))).toBe('AGENT_NOT_ELIGIBLE: luna-go cannot answer here: BMN never measured a picture ask on OpenCode (72.1 measured Codex and Claude Code), so OpenCode teammates are not asked about pictures; ask a Codex or Claude Code teammate')
    expect(askFeatures(env).apps.find((app: { app: string }) => app.app === 'opencode')).toMatchObject({ pictures: 'unmeasured' })
    expect(askFeatures(env).apps.find((app: { app: string }) => app.app === 'claude')).toMatchObject({ pictures: 'proven' })
  })
})

describe.skipIf(!canContain)('bmn team ask --image (72.8 AC1)', { timeout: 30_000 }, () => {
  const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
  const bmn = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
    const child = spawn(process.execPath, [BMN, ...args], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('exit', (code) => done({ code, stdout, stderr }))
  })

  it('goes to the designer when no role is named, its pictures in the request\'s hash and the record; a GIF is refused before anything is copied', async () => {
    const asked = await bmn(['team', 'ask', '--question', 'What do you see?', '--image', 'shots/screen.png', '--json'])
    expect(asked.code, asked.stderr).toBe(0)
    const shown = JSON.parse(asked.stdout)
    expect(shown).toMatchObject({ state: 'answered', role: 'designer', access: 'question', teammate: { agent: 'fable', app: 'claude' } })
    expect(shown.answer).toMatch(/ stdin=[0-9a-f]{64}/)
    const runs = join(home, '.config/bmn/agents/state/team/runs')
    expect(JSON.parse(readFileSync(join(runs, shown.id, ASK_RUN_FILES.manifest), 'utf8')).pictures[0]).toMatchObject({ copy: 'pictures/1.png', removed: ['PNG text "Author"'] })
    // Another picture is another request: the same key with it is a conflict, never the first ask's answer.
    const key = JSON.parse(readFileSync(join(runs, shown.id, ASK_RUN_FILES.request), 'utf8')).key
    writeFileSync(join(home, 'shots/screen.png'), png(ihdr(16, 8), idat(), iend))
    expect((await bmn(['team', 'ask', '--question', 'What do you see?', '--image', 'shots/screen.png', '--key', key, '--json'])).code).toBe(10)
    writeFileSync(join(home, 'shots/a.gif'), Buffer.from('GIF89a\x10\x00\x08\x00', 'latin1'))
    const gif = await bmn(['team', 'ask', '--question', 'And this?', '--image', 'shots/a.gif', '--json'])
    expect(gif.code).toBe(10)
    expect(JSON.parse(gif.stdout)).toMatchObject({ state: 'refused', refusal: { code: 'INPUT_INVALID' } })
  })
})

// ---------------------------------------------------------------------------------------------

/** The 72.1 synthetic picture (360x240, five planted details), drawn here, with a phone's metadata planted in it. */
function plantedPicture(): Buffer {
  const width = 360
  const height = 240
  const pixels = Buffer.alloc(width * height * 4)
  const set = (x: number, y: number, [r, g, b]: number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    pixels.set([r!, g!, b!, 255], (y * width + x) * 4)
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) set(x, y, [244, 241, 232])
  for (let y = 24; y < 72; y += 1) for (let x = 24; x < 72; x += 1) set(x, y, [214, 39, 40])
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if ((x - 290) ** 2 + (y - 180) ** 2 <= 30 ** 2) set(x, y, [31, 90, 200])
  for (let y = 112; y < 128; y += 1) for (let x = 90; x < 270; x += 1) set(x, y, [44, 160, 44])
  for (let y = 20; y < 60; y += 1) for (let x = 300 - (y - 20) / 2; x <= 300 + (y - 20) / 2; x += 1) set(Math.round(x), y, [255, 127, 14])
  const font: Record<string, string[]> = { K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'] }
  let left = 24
  for (const char of 'K7') {
    font[char]!.forEach((line, row) => [...line].forEach((bit, col) => {
      if (bit === '1') for (let dy = 0; dy < 5; dy += 1) for (let dx = 0; dx < 5; dx += 1) set(left + col * 5 + dx, 170 + row * 5 + dy, [20, 20, 20])
    }))
    left += 32
  }
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return png(ihdr(width, height), chunk('tEXt', Buffer.from('Author\0MADE-UP-TEXT', 'latin1')), chunk('eXIf', cameraExif('II', 1)), chunk('IDAT', deflateSync(raw)), iend)
}

const LIVE = process.env.BMN_PICTURES_LIVE === '1'
const OWNER = process.env.HOME ?? ''
const DESIGN = 'You are a designer looking at a picture. Name every visual detail you see: each shape, its colour and where it is in the picture, and any text. One short line per detail.'
const named = (answer: string): Record<string, boolean> => {
  const text = answer.toLowerCase()
  return {
    'red square top left': /red/u.test(text) && /square/u.test(text), 'blue circle bottom right': /blue/u.test(text) && /circle/u.test(text),
    'green bar middle': /green/u.test(text) && /(bar|rectangle|line|stripe)/u.test(text), 'orange triangle top right': /orange/u.test(text) && /triangle/u.test(text),
    'text K7 bottom left': /k7|k 7/u.test(text)
  }
}

/**
 * One live designer ask per app 72.1 proved pictures on (Claude Code, Codex), on the planted picture,
 * through the engine as it ships: a synthetic team in an isolated BMN home, the owner's sign-in files
 * bound into each run as the product binds them, never read. Two at once at most. Run with
 * BMN_PICTURES_LIVE=1 (and BMN_TEST_KEEP_HOME=1 to keep the records).
 */
describe.runIf(LIVE && canContain)('live designer asks on a synthetic picture (72.8 AC4, BMN_PICTURES_LIVE=1)', { timeout: 300_000 }, () => {
  it('a Claude Code and a Codex designer each name the five planted details; each record holds the hashes, what was taken out and the answer', async () => {
    approve(home, EXAMPLE.replace('class: pawn\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nenabled: true\nstatus: active\nefforts: [max]\nroles: [helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]',
      'class: rook\nharness: codex\nmodel: gpt-6-luna\nprovider: openai\nhost: default\nenabled: true\nstatus: active\nefforts: [max, xhigh]\nroles: [designer, helper, focused-reviewer, browser, pre-reviewer, project-pre-reviewer]')
      .replace('designer: {candidates: [fable@medium], then: lead}', 'designer: {candidates: [fable@medium, luna@xhigh], then: lead}'))
    env = { HOME: home, PATH: process.env.PATH ?? '', CODEX_HOME: join(OWNER, '.codex'), CLAUDE_CONFIG_DIR: join(OWNER, '.claude') }
    writeFileSync(join(home, 'shots/planted.png'), plantedPicture())
    const runs = [ask({ question: DESIGN, images: [join(home, 'shots/planted.png')] }), ask({ question: DESIGN, agent: 'luna', effort: 'xhigh', images: [join(home, 'shots/planted.png')] })]
    for (const prepared of runs) expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    for (const prepared of runs) startAsk(prepared, { timeLimitMinutes: 4 })
    const outcomes = await Promise.all(runs.map((prepared) => waitAsk(prepared.folder, { timeoutMs: 240_000 })))
    const report = runs.map((prepared, index) => {
      const answer = (() => {
        try {
          return readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')
        } catch {
          return ''
        }
      })()
      const manifest = JSON.parse(readFileSync(join(prepared.folder, ASK_RUN_FILES.manifest), 'utf8'))
      return { id: prepared.id, agent: prepared.choice.agent, outcome: outcomes[index], picture: manifest.pictures[0], answer, details: named(answer) }
    })
    if (process.env.BMN_PICTURES_LIVE_OUT) writeFileSync(process.env.BMN_PICTURES_LIVE_OUT, `${JSON.stringify(report, null, 1)}\n`)
    for (const run of report) {
      expect(run.outcome, run.answer).toMatchObject({ state: 'answered' })
      expect(run.picture).toMatchObject({ removed: expect.arrayContaining(['PNG text "Author"', 'EXIF GPS (3 fields)', 'EXIF Make']), kept: ['transparency (alpha channel)', 'EXIF Orientation 1'] })
      expect(run.picture.sha256).not.toBe(run.picture.before.sha256)
      expect(run.details, run.answer).toEqual({ 'red square top left': true, 'blue circle bottom right': true, 'green bar middle': true, 'orange triangle top right': true, 'text K7 bottom left': true })
    }
  })
})
