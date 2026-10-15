// MODULE: agents-team-pictures.mjs - Story 72.8: a picture made ready to send: a PNG, JPEG or WebP read from its own bytes and bounded, its metadata taken out by byte edits without re-encoding (BMN has no image library), its orientation, colour profile and transparency kept, and what was taken out named
import { crc32 } from 'node:zlib'
import { InputRefusal, LIMITS, readInputFile, sha256Of } from './agents-team-inputs.mjs'

/**
 * A teammate sees a picture's pixels as the asker sees them, and nothing else the file carries
 * (R72-FR11, NFR5). BMN walks the file's own structure, keeps every part a viewer needs to draw it
 * as it looks (the picture data, its orientation, colour profile and transparency) and leaves out
 * every other part whole: EXIF but its Orientation tag (GPS, camera make, model and serial numbers,
 * dates, text fields, the thumbnail), XMP, IPTC, comments, text chunks and anything after the
 * picture's end. Nothing is decoded or re-encoded: what is sent is the original's bytes with parts
 * cut out. A picture whose structure BMN cannot walk to the end is refused, never sent half-treated.
 */

const untreatable = (label, why) => {
  throw new InputRefusal('PICTURE_UNTREATABLE', `${label} ${why}; BMN sends a picture only after taking its metadata out, without re-encoding it`)
}

/** The picture's type from its first bytes: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, or null. */
export function pictureType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(bytes.toString('latin1', 0, 6))) return 'image/gif'
  return null
}

// ---------------------------------------------------------------------------------------------
// EXIF: only the Orientation tag stays

const EXIF_NAMES = new Map([
  [0x010d, 'DocumentName'], [0x010e, 'ImageDescription'], [0x010f, 'Make'], [0x0110, 'Model'], [0x0131, 'Software'], [0x0132, 'DateTime'],
  [0x013b, 'Artist'], [0x013c, 'HostComputer'], [0x02bc, 'XMP'], [0x83bb, 'IPTC'], [0x8298, 'Copyright'], [0x9c9b, 'XPTitle'], [0x9c9c, 'XPComment'],
  [0x9c9d, 'XPAuthor'], [0x9c9e, 'XPKeywords'], [0x9c9f, 'XPSubject'], [0xc4a5, 'PrintIM'],
  [0x9003, 'DateTimeOriginal'], [0x9004, 'DateTimeDigitized'], [0x9010, 'OffsetTime'], [0x9011, 'OffsetTimeOriginal'], [0x9012, 'OffsetTimeDigitized'],
  [0x927c, 'MakerNote'], [0x9286, 'UserComment'], [0xa420, 'ImageUniqueID'], [0xa430, 'CameraOwnerName'], [0xa431, 'BodySerialNumber'],
  [0xa432, 'LensSpecification'], [0xa433, 'LensMake'], [0xa434, 'LensModel'], [0xa435, 'LensSerialNumber']
])
const EXIF_SUB = new Map([[0x8769, 'camera settings'], [0x8825, 'GPS'], [0xa005, 'interoperability']])
const ORIENTATION = 0x0112

/** A reader of one TIFF structure (EXIF's body), or null when its header is not one. */
function tiffReader(tiff) {
  if (tiff.length < 8) return null
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  const u16 = (at) => (at >= 0 && at + 2 <= tiff.length ? (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)) : null)
  const u32 = (at) => (at >= 0 && at + 4 <= tiff.length ? (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)) : null)
  if (u16(2) !== 42) return null
  // One directory: its entries and the offset of the next, or null when it does not fit.
  const directory = (at) => {
    const count = u16(at)
    if (count === null || at + 2 + count * 12 + 4 > tiff.length) return null
    const entries = []
    for (let index = 0; index < count; index += 1) {
      const entry = at + 2 + index * 12
      entries.push({ tag: u16(entry), type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), short: u16(entry + 8) })
    }
    return { entries, next: u32(at + 2 + count * 12) }
  }
  return { order, ifd0: u32(4), directory }
}

/** A TIFF holding one tag, the Orientation, in the byte order of the original. */
function orientationTiff(order, value) {
  const little = order === 'II'
  const out = Buffer.alloc(26)
  out.write(order, 0, 'latin1')
  const w16 = (number, at) => (little ? out.writeUInt16LE(number, at) : out.writeUInt16BE(number, at))
  const w32 = (number, at) => (little ? out.writeUInt32LE(number, at) : out.writeUInt32BE(number, at))
  w16(42, 2)
  w32(8, 4)
  w16(1, 8)
  w16(ORIENTATION, 10)
  w16(3, 12)
  w32(1, 14)
  w16(value, 18)
  return out
}

/**
 * One EXIF body treated: `{ tiff, orientation, removed }`, `tiff` the body with the Orientation
 * alone or null when there is none to keep. Its first directory must be readable, or BMN cannot
 * tell the orientation it would keep; what lies beyond it goes, named as far as it can be read.
 */
export function treatExif(tiff, label) {
  const reader = tiffReader(tiff)
  const first = reader === null || reader.ifd0 === null ? null : reader.directory(reader.ifd0)
  if (first === null) untreatable(label, 'carries EXIF data BMN cannot read')
  const removed = []
  let others = 0
  let orientation = null
  const name = (entry, inside) => {
    if (EXIF_NAMES.has(entry.tag)) removed.push(`EXIF ${EXIF_NAMES.get(entry.tag)}`)
    else if (inside !== 'GPS') others += 1
  }
  for (const entry of first.entries) {
    if (entry.tag === ORIENTATION) {
      if (entry.type === 3 && entry.count === 1 && entry.short >= 1 && entry.short <= 8) orientation = entry.short
      else removed.push('EXIF Orientation (not a valid value)')
      continue
    }
    if (EXIF_SUB.has(entry.tag)) {
      const sub = EXIF_SUB.get(entry.tag)
      const inner = reader.directory(entry.value)
      if (inner === null) {
        removed.push(`EXIF ${sub} (unreadable)`)
        continue
      }
      if (sub === 'GPS') removed.push(`EXIF GPS (${inner.entries.length} fields)`)
      else for (const field of inner.entries) name(field, sub)
      continue
    }
    name(entry, 'IFD0')
  }
  if (first.next !== null && first.next !== 0) removed.push('EXIF thumbnail')
  if (others > 0) removed.push(`EXIF other fields (${others})`)
  return { tiff: orientation === null ? null : orientationTiff(reader.order, orientation), orientation, removed }
}

// ---------------------------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** The chunks a viewer needs to draw the picture as it looks, with the name a record gives the ones worth naming. */
const PNG_KEPT = new Map([
  ['IHDR', null], ['PLTE', null], ['IDAT', null], ['IEND', null], ['tRNS', 'transparency (tRNS)'], ['iCCP', 'colour profile (iCCP)'],
  ['sRGB', 'colour space (sRGB)'], ['gAMA', 'gamma (gAMA)'], ['cHRM', 'chromaticities (cHRM)'], ['cICP', 'colour coding (cICP)'],
  ['mDCV', 'mastering display (mDCV)'], ['cLLI', 'light level (cLLI)'], ['sBIT', null], ['pHYs', null], ['bKGD', null]
])
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A text chunk's keyword, the field's name (never its text), printable. */
function pngKeyword(data) {
  const end = data.indexOf(0)
  return data.toString('latin1', 0, end === -1 ? Math.min(data.length, 79) : Math.min(end, 79)).replace(/[^\x20-\x7e]/gu, '?')
}

function treatPng(bytes, label) {
  const out = [PNG_SIGNATURE]
  const removed = []
  const kept = []
  let at = 8
  let header = null
  let ended = false
  let data = 0
  let exif = false
  while (at < bytes.length) {
    if (at + 12 > bytes.length) untreatable(label, 'is cut short inside a chunk')
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (length > 0x7fffffff || at + 12 + length > bytes.length) untreatable(label, 'is cut short inside a chunk')
    if (!/^[A-Za-z]{4}$/u.test(type)) untreatable(label, 'holds a chunk with no valid name')
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) untreatable(label, `has a damaged ${type} chunk`)
    const whole = bytes.subarray(at, at + 12 + length)
    at += 12 + length
    if (header === null) {
      if (type !== 'IHDR' || length !== 13) untreatable(label, 'does not start with its header')
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] }
      if (!PNG_DEPTHS[header.colour]?.includes(header.depth) || body[10] !== 0 || body[11] !== 0 || body[12] > 1) untreatable(label, 'has a header no viewer reads')
      if (header.colour === 4 || header.colour === 6) kept.push('transparency (alpha channel)')
    } else if (type === 'IHDR') {
      untreatable(label, 'has two headers')
    }
    if (type === 'IEND') {
      out.push(whole)
      ended = true
      break
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') untreatable(label, 'is animated (APNG); give one frame as a still picture')
    if (type === 'eXIf') {
      if (exif) untreatable(label, 'has two EXIF chunks')
      exif = true
      const treated = treatExif(body, label)
      removed.push(...treated.removed)
      if (treated.tiff !== null) {
        out.push(pngChunk('eXIf', treated.tiff))
        kept.push(`EXIF Orientation ${treated.orientation}`)
      }
      continue
    }
    if (PNG_KEPT.has(type)) {
      out.push(whole)
      if (type === 'IDAT') data += 1
      const named = PNG_KEPT.get(type)
      if (named !== null && !kept.includes(named)) kept.push(named)
      continue
    }
    // A chunk whose name starts with a capital letter must be understood to draw the picture.
    if (type[0] >= 'A' && type[0] <= 'Z') untreatable(label, `holds a ${type} chunk a viewer must understand and BMN does not know`)
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const keyword = pngKeyword(body)
      removed.push(keyword === 'XML:com.adobe.xmp' ? 'XMP' : `PNG text "${keyword}"`)
    } else {
      removed.push(type === 'tIME' ? 'PNG modification time (tIME)' : `PNG chunk ${type}`)
    }
  }
  if (!ended) untreatable(label, 'has no end chunk')
  if (data === 0) untreatable(label, 'holds no picture data')
  if (at < bytes.length) removed.push(`data after the end of the picture (${bytes.length - at} bytes)`)
  return { width: header.width, height: header.height, parts: out, removed, kept }
}

// ---------------------------------------------------------------------------------------------
// JPEG

/** The identifier an application segment starts with, printable, for its name in the record. */
function segmentName(data) {
  const end = data.indexOf(0)
  return data.toString('latin1', 0, end === -1 ? Math.min(data.length, 40) : Math.min(end, 40)).replace(/[^\x20-\x7e]/gu, '')
}

function segment(marker, data) {
  const out = Buffer.alloc(4 + data.length)
  out[0] = 0xff
  out[1] = marker
  out.writeUInt16BE(data.length + 2, 2)
  data.copy(out, 4)
  return out
}

const isFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function treatJpeg(bytes, label) {
  const out = [bytes.subarray(0, 2)]
  const removed = []
  const kept = []
  let at = 2
  let frame = null
  let scans = 0
  let ended = false
  let exif = false
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) untreatable(label, 'has bytes where a marker should be')
    // Fill bytes before a marker carry nothing; the marker itself starts at the last one.
    while (at + 1 < bytes.length && bytes[at + 1] === 0xff) at += 1
    if (at + 1 >= bytes.length) untreatable(label, 'is cut short')
    const marker = bytes[at + 1]
    if (marker === 0xd9) {
      out.push(bytes.subarray(at, at + 2))
      at += 2
      ended = true
      break
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) untreatable(label, 'has a marker out of place')
    if (at + 4 > bytes.length) untreatable(label, 'is cut short')
    const length = bytes.readUInt16BE(at + 2)
    if (length < 2 || at + 2 + length > bytes.length) untreatable(label, 'is cut short inside a segment')
    const whole = bytes.subarray(at, at + 2 + length)
    const data = bytes.subarray(at + 4, at + 2 + length)
    at += 2 + length
    if (marker === 0xda) {
      if (frame === null) untreatable(label, 'has picture data before its frame header')
      // The coded data runs to the next marker: an 0xFF that is neither a stuffed byte nor a restart.
      let end = at
      for (;;) {
        end = bytes.indexOf(0xff, end)
        if (end === -1 || end + 1 >= bytes.length) untreatable(label, 'is cut short inside its picture data')
        const next = bytes[end + 1]
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break
        end += 2
      }
      out.push(whole, bytes.subarray(at, end))
      at = end
      scans += 1
      continue
    }
    if (isFrame(marker)) {
      if (frame !== null) untreatable(label, 'holds more than one frame')
      if (data.length < 6 || data.length < 6 + 3 * data[5]) untreatable(label, 'has a damaged frame header')
      frame = { height: data.readUInt16BE(1), width: data.readUInt16BE(3) }
      if (frame.height === 0) untreatable(label, 'names its height only after its picture data (DNL)')
      out.push(whole)
      continue
    }
    if (marker === 0xc4 || marker === 0xcc || marker === 0xdb || marker === 0xdd) {
      out.push(whole)
      continue
    }
    if (marker === 0xe0) {
      const id = segmentName(data)
      if (id === 'JFIF' && data.length >= 14) {
        // The header stays; a thumbnail in it is a second, older picture and goes.
        if (data.length > 14 || data[12] !== 0 || data[13] !== 0) {
          out.push(segment(0xe0, Buffer.concat([data.subarray(0, 12), Buffer.from([0, 0])])))
          removed.push('JFIF thumbnail')
        } else {
          out.push(whole)
        }
      } else {
        removed.push(id === 'JFXX' ? 'JFIF extension thumbnail' : `JPEG APP0 ${id || 'segment'}`)
      }
      continue
    }
    if (marker === 0xe1) {
      const id = segmentName(data)
      if (id === 'Exif') {
        if (data.length < 6) untreatable(label, 'carries EXIF data BMN cannot read')
        const treated = treatExif(data.subarray(6), label)
        removed.push(...treated.removed)
        if (treated.tiff !== null && !exif) {
          out.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), treated.tiff])))
          kept.push(`EXIF Orientation ${treated.orientation}`)
        }
        exif = true
      } else if (id === 'http://ns.adobe.com/xap/1.0/') {
        removed.push('XMP')
      } else if (id === 'http://ns.adobe.com/xmp/extension/') {
        removed.push('XMP (extended)')
      } else {
        removed.push(`JPEG APP1 ${id || 'segment'}`)
      }
      continue
    }
    if (marker === 0xe2 && segmentName(data) === 'ICC_PROFILE') {
      out.push(whole)
      if (!kept.includes('colour profile (ICC)')) kept.push('colour profile (ICC)')
      continue
    }
    if (marker === 0xee && segmentName(data).startsWith('Adobe')) {
      // Adobe's segment says how the colours are coded; without it a CMYK picture draws wrong.
      out.push(whole)
      kept.push('colour coding (Adobe)')
      continue
    }
    if (marker >= 0xe0 && marker <= 0xef) {
      const id = segmentName(data)
      removed.push(marker === 0xed && id === 'Photoshop 3.0' ? 'IPTC (Photoshop)' : marker === 0xe2 && id === 'MPF' ? 'MPF (multi-picture index)' : `JPEG APP${marker - 0xe0} ${id || 'segment'}`)
      continue
    }
    if (marker === 0xfe) {
      removed.push('JPEG comment')
      continue
    }
    untreatable(label, `holds a segment (0xFF${marker.toString(16).toUpperCase()}) BMN does not know`)
  }
  if (!ended) untreatable(label, 'has no end marker')
  if (frame === null || scans === 0) untreatable(label, 'holds no picture data')
  if (at < bytes.length) removed.push(`data after the end of the picture (${bytes.length - at} bytes)`)
  return { width: frame.width, height: frame.height, parts: out, removed, kept }
}

// ---------------------------------------------------------------------------------------------
// WebP

function riffChunk(fourcc, data) {
  const out = Buffer.alloc(8 + data.length + (data.length & 1))
  out.write(fourcc, 0, 'latin1')
  out.writeUInt32LE(data.length, 4)
  data.copy(out, 8)
  return out
}

/** The size the image chunk's own bitstream gives, or null when it is not one. */
function webpFrame(fourcc, data) {
  if (fourcc === 'VP8 ' && data.length >= 10 && (data[0] & 1) === 0 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
    return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff }
  }
  if (fourcc === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  return null
}

const WEBP_ICC = 0x20
const WEBP_EXIF = 0x08
const WEBP_XMP = 0x04
const WEBP_ANIMATION = 0x02

function treatWebp(bytes, label) {
  const size = bytes.readUInt32LE(4)
  const end = 8 + size
  if (size < 4 || end > bytes.length) untreatable(label, 'is cut short')
  const chunks = []
  let at = 12
  while (at < end) {
    if (at + 8 > end) untreatable(label, 'is cut short inside a chunk')
    const fourcc = bytes.toString('latin1', at, at + 4)
    const length = bytes.readUInt32LE(at + 4)
    if (at + 8 + length > end) untreatable(label, 'is cut short inside a chunk')
    chunks.push({ fourcc, data: bytes.subarray(at + 8, at + 8 + length) })
    at += 8 + length + (length & 1)
  }
  const removed = []
  const kept = []
  const parts = []
  const first = chunks[0]
  let frame = null
  if (first === undefined) untreatable(label, 'holds no picture')
  if (first.fourcc === 'VP8 ' || first.fourcc === 'VP8L') {
    // A simple file holds its picture alone; anything after it is no part of what is drawn.
    frame = webpFrame(first.fourcc, first.data)
    if (frame === null) untreatable(label, 'has a damaged picture chunk')
    parts.push(riffChunk(first.fourcc, first.data))
    if (first.fourcc === 'VP8L' && (first.data.readUInt32LE(1) >>> 28) & 1) kept.push('transparency (alpha channel)')
    for (const chunk of chunks.slice(1)) removed.push(chunk.fourcc === 'EXIF' ? 'EXIF (all of it)' : chunk.fourcc === 'XMP ' ? 'XMP' : `WebP chunk ${chunk.fourcc.trim()}`)
  } else if (first.fourcc === 'VP8X') {
    if (first.data.length < 10) untreatable(label, 'has a damaged header')
    const flags = first.data[0]
    if (flags & WEBP_ANIMATION) untreatable(label, 'is animated; give one frame as a still picture')
    const canvas = { width: 1 + first.data.readUIntLE(4, 3), height: 1 + first.data.readUIntLE(7, 3) }
    let icc = false
    let exif = null
    const body = []
    for (const chunk of chunks.slice(1)) {
      if (chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF') untreatable(label, 'is animated; give one frame as a still picture')
      if (chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L') {
        if (frame !== null) untreatable(label, 'holds more than one picture')
        frame = webpFrame(chunk.fourcc, chunk.data)
        if (frame === null) untreatable(label, 'has a damaged picture chunk')
        body.push(riffChunk(chunk.fourcc, chunk.data))
      } else if (chunk.fourcc === 'ICCP') {
        icc = true
        body.push(riffChunk('ICCP', chunk.data))
        kept.push('colour profile (ICCP)')
      } else if (chunk.fourcc === 'ALPH') {
        body.push(riffChunk('ALPH', chunk.data))
        kept.push('transparency (ALPH)')
      } else if (chunk.fourcc === 'EXIF') {
        if (exif !== null) untreatable(label, 'has two EXIF chunks')
        // Some writers put JPEG's "Exif\0\0" before the TIFF body; the body is the same.
        const tiff = chunk.data.toString('latin1', 0, 6) === 'Exif\0\0' ? chunk.data.subarray(6) : chunk.data
        exif = treatExif(tiff, label)
        removed.push(...exif.removed)
        if (exif.tiff !== null) {
          body.push(riffChunk('EXIF', exif.tiff))
          kept.push(`EXIF Orientation ${exif.orientation}`)
        }
      } else {
        removed.push(chunk.fourcc === 'XMP ' ? 'XMP' : `WebP chunk ${chunk.fourcc.trim()}`)
      }
    }
    if (frame === null) untreatable(label, 'holds no picture')
    if (frame.width !== canvas.width || frame.height !== canvas.height) untreatable(label, 'has a canvas of another size than its picture')
    // A lossless picture carries its own alpha channel, flagged in the header.
    if ((flags & 0x10) && !kept.includes('transparency (ALPH)')) kept.push('transparency (alpha channel)')
    // The header's flags say which of the kept chunks follow.
    const header = Buffer.from(first.data)
    header[0] = (flags & ~(WEBP_ICC | WEBP_EXIF | WEBP_XMP)) | (icc ? WEBP_ICC : 0) | (exif?.tiff ? WEBP_EXIF : 0)
    parts.push(riffChunk('VP8X', header), ...body)
  } else {
    untreatable(label, 'does not start with a picture chunk')
  }
  if (end < bytes.length) removed.push(`data after the end of the picture (${bytes.length - end} bytes)`)
  const length = parts.reduce((sum, part) => sum + part.length, 4)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(length, 4)
  riff.write('WEBP', 8, 'latin1')
  return { width: frame.width, height: frame.height, parts: [riff, ...parts], removed, kept }
}

// ---------------------------------------------------------------------------------------------

/**
 * One picture made ready to send: `{ media_type, width, height, bytes, sha256, before: { bytes,
 * sha256 }, removed, kept }`, `bytes` what the teammate is given and `removed` / `kept` named by
 * field, never by value. Refuses (InputRefusal) another type, a picture over the limits of side or
 * decoded pixels, and one whose structure BMN cannot walk to its end.
 */
export function treatPicture(bytes, label) {
  const type = pictureType(bytes)
  if (type === 'image/gif') throw new InputRefusal('INPUT_INVALID', `${label} is a GIF; BMN sends PNG, JPEG and WebP pictures (a GIF may be animated and keeps its text where BMN does not take it out); give it as a PNG`)
  if (type === null) throw new InputRefusal('INPUT_INVALID', `${label} is not a PNG, JPEG or WebP picture`)
  const treated = type === 'image/png' ? treatPng(bytes, label) : type === 'image/jpeg' ? treatJpeg(bytes, label) : treatWebp(bytes, label)
  const { width, height } = treated
  if (width < 1 || height < 1) untreatable(label, 'has no size')
  if (width > LIMITS.pictureSide || height > LIMITS.pictureSide) throw new InputRefusal('INPUT_TOO_LARGE', `${label} is ${width}x${height} pixels; a side may be at most ${LIMITS.pictureSide}`)
  if (width * height > LIMITS.picturePixels) throw new InputRefusal('INPUT_TOO_LARGE', `${label} is ${width}x${height}, ${(width * height / 1e6).toFixed(1)} million pixels once drawn; a picture may have at most ${(LIMITS.picturePixels / 1e6).toFixed(1)} million`)
  const sent = Buffer.concat(treated.parts)
  return { media_type: type, width, height, bytes: sent, sha256: sha256Of(sent), before: { bytes: bytes.length, sha256: sha256Of(bytes) }, removed: treated.removed, kept: treated.kept }
}

/** A `--image`: a PNG, JPEG or WebP file the asker may give (72.2's file rules), inside the limits, treated. */
export function pictureFile(path, options = {}) {
  const file = readInputFile(path, { ...options, kind: 'image', limit: LIMITS.picture })
  return { path: file.path, real: file.real, ...treatPicture(file.bytes, path) }
}
