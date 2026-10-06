// MODULE: voice-recorder.test.ts - a microphone lost mid-recording is reported once and closed; open failures say what to do
import { afterEach, describe, expect, it, vi } from 'vitest'
import { microphoneFailure, startVoiceRecording } from './voice-recorder'

class FakeTrack extends EventTarget {
  stopped = false
  stop(): void {
    // Like a real track: stopping it from code does not fire `ended`.
    this.stopped = true
  }
}

class FakeRecorder extends EventTarget {
  static last: FakeRecorder
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  constructor() {
    super()
    FakeRecorder.last = this
  }
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

function microphone(): FakeTrack {
  const track = new FakeTrack()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({
    getTracks: () => [track], getAudioTracks: () => [track]
  })) } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  return track
}

afterEach(() => vi.unstubAllGlobals())

describe('voice recording (Story 53.8 AC2)', () => {
  it('reports a microphone that goes away while recording, once', async () => {
    const track = microphone()
    const interrupted = vi.fn()
    await startVoiceRecording(interrupted)
    track.dispatchEvent(new Event('ended'))
    FakeRecorder.last.dispatchEvent(new Event('error'))
    expect(interrupted).toHaveBeenCalledTimes(1)
  })

  it('reports a recorder failure as an interruption', async () => {
    microphone()
    const interrupted = vi.fn()
    await startVoiceRecording(interrupted)
    FakeRecorder.last.dispatchEvent(new Event('error'))
    expect(interrupted).toHaveBeenCalledTimes(1)
  })

  it('never reports its own cancel or stop, and closes the microphone either way', async () => {
    const cancelledTrack = microphone()
    const interrupted = vi.fn()
    const cancelled = await startVoiceRecording(interrupted)
    cancelled.cancel()
    cancelledTrack.dispatchEvent(new Event('ended'))
    expect(cancelledTrack.stopped).toBe(true)

    const stoppedTrack = microphone()
    const stopped = await startVoiceRecording(interrupted)
    const wav = await stopped.stop()
    stoppedTrack.dispatchEvent(new Event('ended'))
    expect(stoppedTrack.stopped).toBe(true)
    expect(wav.byteLength).toBe(44)
    expect(interrupted).not.toHaveBeenCalled()
  })

  it('says what to do when the microphone cannot be opened', () => {
    expect(microphoneFailure('NotAllowedError', 'win32')).toBe(
      'Microphone access was refused. Allow desktop apps to use the microphone in Settings › Privacy & security › Microphone.')
    expect(microphoneFailure('NotAllowedError', 'linux')).toBe('Microphone access was refused.')
    expect(microphoneFailure('NotFoundError', 'win32')).toBe('No microphone was found.')
    expect(microphoneFailure('NotReadableError', 'win32')).toBe(
      'The microphone could not be opened. Another app may be using it, or Windows may be blocking it (Settings › Privacy & security › Microphone).')
    expect(microphoneFailure('NotReadableError', 'linux')).toBe('The microphone could not be opened. Another app may be using it.')
    expect(microphoneFailure('TypeError', 'win32')).toBeNull()
  })
})
