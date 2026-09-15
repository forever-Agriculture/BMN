// MODULE: voice-wav.ts - mixes recorded audio to mono and encodes the 16-bit PCM WAV that whisper-cli reads

/** Averages every channel into one; a single channel is returned unchanged. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const [first] = channels
  if (!first) return new Float32Array(0)
  if (channels.length === 1) return first
  const length = Math.min(...channels.map((channel) => channel.length))
  const mixed = new Float32Array(length)
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) + (channel[index] ?? 0) / channels.length
    }
  }
  return mixed
}

/** Encodes mono float samples in [-1, 1] as a canonical 44-byte-header PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return bytes
}
