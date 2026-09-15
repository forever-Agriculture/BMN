// MODULE: voice-readiness.ts - decides whether Speak can record and which installed model it transcribes with
import type { VoiceModelStatus, VoiceStatus } from '@ai-terminal/protocol'

export type VoiceReadiness =
  /** `replacesChoice` is true when the chosen model is neither installed nor downloading, so the installed one should become the saved choice. */
  | { kind: 'ready'; model: VoiceModelStatus; replacesChoice: boolean }
  | { kind: 'engine-missing' }
  | { kind: 'folder-unavailable'; path: string }
  | { kind: 'downloading'; model: VoiceModelStatus }
  | { kind: 'no-model' }

/** The model's short name, such as "Small", without the speed note. */
export const modelName = (model: VoiceModelStatus): string => model.label.split(' — ')[0] ?? model.label

const downloading = (model: VoiceModelStatus | undefined): model is VoiceModelStatus => !!model?.download && !model.download.error

/** The chosen model wins when installed; otherwise a downloaded one is used, so a download works whether or not it was selected. */
export function voiceReadiness(status: VoiceStatus, chosen: VoiceModelStatus['id']): VoiceReadiness {
  if (!status.engineAvailable) return { kind: 'engine-missing' }
  if (!status.modelFolder.available) return { kind: 'folder-unavailable', path: status.modelFolder.path }
  const chosenStatus = status.models.find((candidate) => candidate.id === chosen)
  if (chosenStatus?.installed) return { kind: 'ready', model: chosenStatus, replacesChoice: false }
  const installed = status.models.find((candidate) => candidate.installed)
  if (installed) return { kind: 'ready', model: installed, replacesChoice: !downloading(chosenStatus) }
  const pending = downloading(chosenStatus) ? chosenStatus : status.models.find(downloading)
  return pending ? { kind: 'downloading', model: pending } : { kind: 'no-model' }
}
