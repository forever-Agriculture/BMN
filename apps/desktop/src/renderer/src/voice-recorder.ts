// MODULE: voice-recorder.ts - records the microphone and returns 16 kHz mono WAV bytes for local transcription
import { encodeWav, mixToMono } from './voice-wav'

export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_MAX_SECONDS = 120

export interface VoiceRecording {
  /** Stops the microphone and resolves the recording as WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Stops the microphone and discards the recording. */
  cancel(): void
}

/**
 * What to tell the owner when the microphone cannot be opened, by the error's DOMException name; null when the name
 * says nothing specific (the caller then reports the error itself).
 */
export function microphoneFailure(name: string, platform: string): string | null {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return platform === 'win32'
      ? 'Microphone access was refused. Allow desktop apps to use the microphone in Settings › Privacy & security › Microphone.'
      : 'Microphone access was refused.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.'
  if (name === 'NotReadableError' || name === 'AbortError') {
    return platform === 'win32'
      ? 'The microphone could not be opened. Another app may be using it, or Windows may be blocking it (Settings › Privacy & security › Microphone).'
      : 'The microphone could not be opened. Another app may be using it.'
  }
  return null
}

/**
 * Starts recording. `onInterrupted` runs once if the microphone stops on its own while recording (unplugged, turned
 * off, taken by the system or another app) or the recorder fails; never for this recording's own stop or cancel.
 */
export async function startVoiceRecording(onInterrupted?: () => void): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  let finished = false
  const interrupted = (): void => {
    if (finished) return
    finished = true
    onInterrupted?.()
  }
  // A track's `ended` fires when its source goes away, not when this code stops it.
  for (const track of stream.getAudioTracks()) track.addEventListener('ended', interrupted, { once: true })
  const release = (): void => {
    finished = true
    for (const track of stream.getTracks()) track.stop()
  }
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream)
  } catch (error) {
    release()
    throw error
  }
  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }))
  recorder.addEventListener('error', interrupted, { once: true })
  recorder.start(250)

  return {
    async stop() {
      finished = true
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      release()
      const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()
      if (encoded.byteLength === 0) return encodeWav(new Float32Array(0), VOICE_SAMPLE_RATE)
      // Decoding in a 16 kHz context resamples the compressed recording to what Whisper expects.
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
      try {
        const audio = await context.decodeAudioData(encoded)
        const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
        const samples = mixToMono(channels).subarray(0, VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE)
        return encodeWav(samples, VOICE_SAMPLE_RATE)
      } finally {
        void context.close()
      }
    },
    cancel() {
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    }
  }
}
