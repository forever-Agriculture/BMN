// MODULE: voice-settings-writer.ts - one queue for whole-section voice saves, each built from the latest settings when sent
import type { AppSettings, VoiceSettings } from '@bmn/protocol'

export interface VoiceSettingsWriter {
  /**
   * Saves the voice section that `change` makes from the settings current when this save's turn comes, after every
   * earlier save has settled, so one field never writes back an older model, language or vocabulary. A `change`
   * that throws refuses the save without sending anything.
   */
  update(change: (current: VoiceSettings) => VoiceSettings): Promise<AppSettings>
}

export function createVoiceSettingsWriter(options: {
  current(): AppSettings
  put(voice: VoiceSettings): Promise<AppSettings>
  /** The saved settings, published before the next queued save reads `current`. */
  saved(settings: AppSettings): void
}): VoiceSettingsWriter {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    update(change) {
      const run = tail.then(async () => {
        const result = await options.put(change(options.current().voice))
        options.saved(result)
        return result
      })
      tail = run.catch(() => undefined)
      return run
    }
  }
}
