// MODULE: voice-preferences.tsx - Preferences → Voice: local engine status, model folder, model downloads and dictation language
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  VOICE_LANGUAGES,
  type AppSettings,
  type VoiceLanguage,
  type VoiceModelStatus,
  type VoiceSettings,
  type VoiceStatus
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { SHORTCUT_LABELS } from './keymap'

const DOWNLOAD_POLL_MS = 500

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function VoicePreferences(props: {
  settings: VoiceSettings
  onSettings(next: AppSettings): void
}): React.JSX.Element {
  const onSettings = useRef(props.onSettings)
  onSettings.current = props.onSettings
  const [voice, setVoice] = useState<VoiceSettings>(props.settings)
  const latestVoice = useRef(voice)
  latestVoice.current = voice
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.aiTerminal.getVoiceStatus())
    } catch (failure) {
      setError(failureDetail(failure, 'Could not load voice status'))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const downloading = status?.models.some((model) => model.download && !model.download.error) ?? false
  useEffect(() => {
    if (!downloading) return
    const timer = setInterval(() => void refresh(), DOWNLOAD_POLL_MS)
    return () => clearInterval(timer)
  }, [downloading, refresh])

  async function save(next: VoiceSettings): Promise<void> {
    const previous = latestVoice.current
    latestVoice.current = next
    setVoice(next)
    setBusy(true)
    setError(null)
    try {
      const result = await window.aiTerminal.putSettings('voice', next)
      setVoice(result.voice)
      onSettings.current(result)
    } catch (failure) {
      setVoice(previous)
      setError(failureDetail(failure, 'Could not save voice settings'))
    } finally {
      setBusy(false)
    }
  }

  async function act(run: () => Promise<unknown>, fallback: string): Promise<void> {
    setError(null)
    try {
      await run()
    } catch (failure) {
      setError(failureDetail(failure, fallback))
    }
    await refresh()
  }

  /** Downloading a model also makes it the choice, so Speak uses it as soon as the download finishes. */
  async function download(model: VoiceModelStatus): Promise<void> {
    setError(null)
    try {
      await window.aiTerminal.downloadVoiceModel(model.id)
    } catch (failure) {
      setError(failureDetail(failure, 'Could not start the download'))
      await refresh()
      return
    }
    await refresh()
    // Read the choice after the awaits: a language picked meanwhile must not be saved back to its old value.
    const current = latestVoice.current
    if (current.model !== model.id) await save({ ...current, model: model.id })
  }

  async function chooseFolder(): Promise<void> {
    setError(null)
    try {
      const picked = await window.aiTerminal.chooseVoiceModelFolder()
      if (picked) await save({ ...voice, modelFolder: picked.path })
    } catch (failure) {
      setError(failureDetail(failure, 'Could not choose the model folder'))
    }
    await refresh()
  }

  async function useDefaultFolder(): Promise<void> {
    await save({ ...voice, modelFolder: null })
    await refresh()
  }

  function modelState(model: VoiceModelStatus): React.JSX.Element {
    if (!status?.modelFolder.available) return <span className="preferences-help">Folder unavailable</span>
    if (model.installed) return <span className="preferences-help">Installed</span>
    if (model.download?.error) {
      return (
        <>
          <span className="preferences-error">{model.download.error}</span>
          <button type="button" onClick={() => void act(() => window.aiTerminal.cancelVoiceModelDownload(model.id), 'Could not dismiss')}>
            Dismiss
          </button>
        </>
      )
    }
    if (model.download) {
      const percent = Math.floor((model.download.receivedBytes / model.bytes) * 100)
      return (
        <>
          <progress max={model.bytes} value={model.download.receivedBytes} aria-label={`${model.label} download`} />
          <span className="preferences-help">{percent}%</span>
          <button type="button" onClick={() => void act(() => window.aiTerminal.cancelVoiceModelDownload(model.id), 'Could not cancel the download')}>
            Cancel
          </button>
        </>
      )
    }
    return (
      <button type="button" disabled={busy} onClick={() => void download(model)}>
        Download ({megabytes(model.bytes)})
      </button>
    )
  }

  return (
    <section className="preferences-section">
      <h3>Voice</h3>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <span>Dictation engine</span>
          <p className="preferences-help">
            Whisper runs on this computer. Recordings are deleted right after transcription.
          </p>
        </div>
        <div className="preferences-row-control">
          {!status ? (
            <p className="preferences-help">Checking…</p>
          ) : status.engineAvailable ? (
            <p className="preferences-help">
              Ready. Hold Space in a terminal, or press Speak or {SHORTCUT_LABELS['voice-toggle']} to start and again to stop; the transcript is pasted without Enter.
            </p>
          ) : (
            <p className="preferences-error">
              Not built. Run <code className="preferences-mono">pnpm run voice:build</code>, then rebuild the app.
            </p>
          )}
        </div>
      </div>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <label htmlFor="preferences-voice-hold-space">Hold Space to talk</label>
          <p className="preferences-help">
            In any terminal, hold Space to record and release it to paste. A quick tap still types a space. Turn off for programs that use a held Space, such as paging in less.
          </p>
        </div>
        <div className="preferences-row-control">
          <input
            id="preferences-voice-hold-space"
            type="checkbox"
            checked={voice.holdSpaceToTalk}
            disabled={busy}
            onChange={(event) => void save({ ...latestVoice.current, holdSpaceToTalk: event.target.checked })}
          />
        </div>
      </div>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <span>Model folder</span>
          <p className="preferences-help">Downloads go here. A folder that already holds the model files is used as is.</p>
        </div>
        <div className="preferences-row-control voice-folder">
          {status && (
            <>
              <code className="preferences-mono">{status.modelFolder.path}</code>
              {!status.modelFolder.available && (
                <p className="preferences-error">This folder is not available. Is its disk mounted?</p>
              )}
              <div className="preferences-button-row">
                <button type="button" disabled={busy || downloading} onClick={() => void chooseFolder()}>
                  Change…
                </button>
                {status.modelFolder.custom && (
                  <button type="button" disabled={busy || downloading} onClick={() => void useDefaultFolder()}>
                    Use default
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <span>Model</span>
          <p className="preferences-help">Downloaded once from Hugging Face and checked against a pinned checksum.</p>
        </div>
        <div className="preferences-row-control voice-models" role="radiogroup" aria-label="Voice model">
          {(status?.models ?? []).map((model) => (
            <div className="voice-model" key={model.id}>
              <label className="preferences-radio">
                <input
                  type="radio"
                  name="preferences-voice-model"
                  checked={voice.model === model.id}
                  disabled={busy}
                  onChange={() => void save({ ...voice, model: model.id })}
                />
                {model.label}
              </label>
              <div className="voice-model-state">{modelState(model)}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <label htmlFor="preferences-voice-language">Language</label>
          <p className="preferences-help">Choosing your language is faster and more accurate than detection.</p>
        </div>
        <div className="preferences-row-control">
          <select
            id="preferences-voice-language"
            value={voice.language}
            disabled={busy}
            onChange={(event) => void save({ ...voice, language: event.target.value as VoiceLanguage })}
          >
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="preferences-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
