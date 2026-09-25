// MODULE: voice-preferences.tsx - Preferences → Voice: engine status, model folder, downloads, language and the approved vocabulary
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  VOICE_LANGUAGES,
  VOICE_VOCABULARY_MAX_PROMPT_BYTES,
  VOICE_VOCABULARY_MAX_WORDS,
  addVocabularyWord,
  vocabularyPrompt,
  vocabularyPromptBytes,
  type AppSettings,
  type VoiceLanguage,
  type VoiceModelStatus,
  type VoiceSettings,
  type VoiceStatus
} from '@bmn/protocol'
import { failureDetail } from './bridge-error'
import { SHORTCUT_LABELS } from './keymap'
import { createVoiceStatusRunner, type VoiceStatusEvent } from './voice-status-runner'

const DOWNLOAD_POLL_MS = 500

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

export type VocabularySuggestion = { ok: true; words: string[] } | { ok: false; reason: string }

/** A suggested word the owner can edit before approving; a refused edit keeps its text and shows why. */
interface Candidate {
  id: number
  text: string
  error: string | null
}

export function VoicePreferences(props: {
  /** The app's latest voice settings; the panel never keeps its own copy, so a save elsewhere is never undone here. */
  settings: VoiceSettings
  /** Queues a save built from the latest settings when it is sent; the app publishes the result. */
  save(change: (current: VoiceSettings) => VoiceSettings): Promise<AppSettings>
  suggest(): VocabularySuggestion
}): React.JSX.Element {
  /** Shown while a save is in flight; the app's settings replace it when the save settles either way. */
  const [optimistic, setOptimistic] = useState<VoiceSettings | null>(null)
  const voice = optimistic ?? props.settings
  const latestVoice = useRef(voice)
  latestVoice.current = voice
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [suggestNote, setSuggestNote] = useState<string | null>(null)
  const [draftWord, setDraftWord] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const nextCandidateId = useRef(1)
  // Only the newest status request publishes: a response that captured a download error before
  // Dismiss must not restore it after the Dismiss's own refresh.
  const statusRunner = useRef(createVoiceStatusRunner(
    () => window.aiTerminal.getVoiceStatus(),
    (event: VoiceStatusEvent) => {
      if (event.kind === 'status') setStatus(event.status)
      else setError(failureDetail(event.cause, 'Could not load voice status'))
    }
  ))
  const refresh = useCallback(async (): Promise<void> => {
    await statusRunner.current.run()
  }, [])

  useEffect(() => {
    void refresh()
    return () => statusRunner.current.cancel()
  }, [refresh])

  const downloading = status?.models.some((model) => model.download && !model.download.error) ?? false
  useEffect(() => {
    if (!downloading) return
    const timer = setInterval(() => void refresh(), DOWNLOAD_POLL_MS)
    return () => clearInterval(timer)
  }, [downloading, refresh])

  /** Saves one change to the whole section; resolves the failure text when the save was refused, so a field can show it. */
  async function save(change: (current: VoiceSettings) => VoiceSettings): Promise<string | null> {
    setBusy(true)
    setError(null)
    try {
      setOptimistic(change(latestVoice.current))
      await props.save(change)
      return null
    } catch (failure) {
      const detail = failureDetail(failure, 'Could not save voice settings')
      setError(detail)
      return detail
    } finally {
      setOptimistic(null)
      setBusy(false)
    }
  }

  /** Approves one word: the shared validator first, so a refused word stays where it was typed with its reason. */
  async function approveWord(raw: string): Promise<string | null> {
    const checked = addVocabularyWord(latestVoice.current.vocabulary, raw)
    if (!checked.ok) return checked.reason
    // Checked again against the settings current when the save is sent.
    return save((current) => {
      const added = addVocabularyWord(current.vocabulary, raw)
      if (!added.ok) throw new Error(added.reason)
      return { ...current, vocabulary: added.words }
    })
  }

  function suggest(): void {
    const result = props.suggest()
    if (!result.ok) {
      setCandidates([])
      setSuggestNote(result.reason)
      return
    }
    setCandidates(result.words.map((text) => ({ id: nextCandidateId.current++, text, error: null })))
    setSuggestNote(result.words.length === 0
      ? 'No new words were found in the session\'s name or recent output.'
      : `${result.words.length} suggested. Edit a word if needed, then approve it; nothing is saved until you do.`)
  }

  function editCandidate(id: number, text: string): void {
    setCandidates((current) => current.map((candidate) => (candidate.id === id ? { ...candidate, text, error: null } : candidate)))
  }

  async function approveCandidate(candidate: Candidate): Promise<void> {
    const refused = await approveWord(candidate.text)
    setCandidates((current) => refused
      ? current.map((item) => (item.id === candidate.id ? { ...item, error: refused } : item))
      : current.filter((item) => item.id !== candidate.id))
  }

  function skipCandidate(id: number): void {
    setCandidates((current) => current.filter((item) => item.id !== id))
  }

  async function addDraftWord(): Promise<void> {
    const refused = await approveWord(draftWord)
    setDraftError(refused)
    if (!refused) setDraftWord('')
  }

  async function removeWord(word: string): Promise<void> {
    await save((current) => ({ ...current, vocabulary: current.vocabulary.filter((item) => item !== word) }))
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
    if (latestVoice.current.model !== model.id) await save((current) => ({ ...current, model: model.id }))
  }

  async function chooseFolder(): Promise<void> {
    setError(null)
    try {
      const picked = await window.aiTerminal.chooseVoiceModelFolder()
      if (picked) await save((current) => ({ ...current, modelFolder: picked.path }))
    } catch (failure) {
      setError(failureDetail(failure, 'Could not choose the model folder'))
    }
    await refresh()
  }

  async function useDefaultFolder(): Promise<void> {
    await save((current) => ({ ...current, modelFolder: null }))
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
            onChange={(event) => {
              const holdSpaceToTalk = event.target.checked
              void save((current) => ({ ...current, holdSpaceToTalk }))
            }}
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
                  onChange={() => void save((current) => ({ ...current, model: model.id }))}
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
            onChange={(event) => {
              const language = event.target.value as VoiceLanguage
              void save((current) => ({ ...current, language }))
            }}
          >
            {VOICE_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="preferences-row">
        <div className="preferences-row-label">
          <span id="preferences-voice-vocabulary-label">Vocabulary</span>
          <p className="preferences-help">
            Names Whisper should expect, such as project names and identifiers. Suggestions come from the session you are working in; approved words are passed to Whisper as a hint on every recording. Whisper may still miss a word. The hint holds at most {VOICE_VOCABULARY_MAX_PROMPT_BYTES} bytes; most non-English letters take two.
          </p>
        </div>
        <div className="preferences-row-control voice-vocabulary">
          <div className="preferences-button-row">
            <button type="button" disabled={busy} onClick={suggest}>Suggest from current session</button>
          </div>
          {suggestNote && <p className="preferences-help" role="status">{suggestNote}</p>}
          {candidates.length > 0 && (
            <ul className="voice-vocabulary-candidates" aria-label="Suggested words">
              {candidates.map((candidate, index) => (
                <li key={candidate.id}>
                  <div className="voice-vocabulary-candidate">
                    <input
                      type="text"
                      value={candidate.text}
                      aria-label={`Suggested word ${index + 1}`}
                      aria-invalid={candidate.error ? true : undefined}
                      aria-describedby={candidate.error ? `preferences-voice-candidate-${candidate.id}-error` : undefined}
                      disabled={busy}
                      onChange={(event) => editCandidate(candidate.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void approveCandidate(candidate)
                        }
                      }}
                    />
                    <button type="button" disabled={busy} onClick={() => void approveCandidate(candidate)}>Approve</button>
                    <button type="button" disabled={busy} aria-label={`Skip ${candidate.text}`} onClick={() => skipCandidate(candidate.id)}>Skip</button>
                  </div>
                  {candidate.error && (
                    <p id={`preferences-voice-candidate-${candidate.id}-error`} className="preferences-error" role="alert">{candidate.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {voice.vocabulary.length === 0 ? (
            <p className="preferences-help">No approved words yet; dictation works as before.</p>
          ) : (
            <ul className="voice-vocabulary-list" aria-labelledby="preferences-voice-vocabulary-label">
              {voice.vocabulary.map((word) => (
                <li key={word} className="voice-vocabulary-chip">
                  <code>{word}</code>
                  <button type="button" disabled={busy} aria-label={`Remove ${word}`} onClick={() => void removeWord(word)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="voice-vocabulary-add"
            onSubmit={(event) => {
              event.preventDefault()
              void addDraftWord()
            }}
          >
            <label htmlFor="preferences-voice-add-word" className="visually-hidden">Add word</label>
            <input
              id="preferences-voice-add-word"
              type="text"
              placeholder="Add a word"
              value={draftWord}
              aria-invalid={draftError ? true : undefined}
              aria-describedby={draftError ? 'preferences-voice-add-word-error' : undefined}
              disabled={busy}
              onChange={(event) => {
                setDraftWord(event.target.value)
                setDraftError(null)
              }}
            />
            <button type="submit" disabled={busy}>Add</button>
          </form>
          {draftError && (
            <p id="preferences-voice-add-word-error" className="preferences-error" role="alert">{draftError}</p>
          )}
          <div className="voice-vocabulary-prompt">
            <div className="voice-vocabulary-prompt-head">
              <span className="eyebrow">Sent to Whisper</span>
              <span className="voice-vocabulary-count">
                {voice.vocabulary.length} of {VOICE_VOCABULARY_MAX_WORDS} words · {vocabularyPromptBytes(voice.vocabulary)} of {VOICE_VOCABULARY_MAX_PROMPT_BYTES} bytes
              </span>
            </div>
            {voice.vocabulary.length === 0
              ? <p className="preferences-help">Nothing is sent to Whisper.</p>
              : <code className="voice-vocabulary-prompt-text" data-testid="voice-vocabulary-prompt">{vocabularyPrompt(voice.vocabulary)}</code>}
          </div>
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
