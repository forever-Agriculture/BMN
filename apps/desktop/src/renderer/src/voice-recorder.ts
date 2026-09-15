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

export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const release = (): void => {
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
  recorder.start(250)

  return {
    async stop() {
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
