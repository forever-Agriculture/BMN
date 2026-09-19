// MODULE: voice-probe.ts - what the Electron self-test proves about voice vocabulary and dictation, shared by renderer and main

export interface VoiceFlowProbe {
  /** Candidate texts after Suggest from the probe session, in the order shown. */
  suggested: string[]
  /** A suggested word edited before approval, as it appears in the approved list. */
  editedApproved: string
  addWordRejected: { message: string; inputPreserved: boolean; listUnchanged: boolean }
  duplicateRejected: { message: string; candidateKept: boolean }
  /** The approved list after one removal, and the prompt line shown for it. */
  approvedAfterRemove: string[]
  promptShown: string
  persistedInSettings: boolean
  /** Small was chosen but only Base is installed: the fallback save keeps the vocabulary saved before it. */
  fallback: { modelChosenBefore: string; modelAfter: string; vocabularyKept: boolean }
  /** Dictation into the probe session: the synthetic transcript arrives once, with no Enter. */
  recording: { pastedOnce: boolean; commandNotRun: boolean; announced: string }
  /** A word approved while recording is saved, but that recording keeps its snapshot (main checks the argv). */
  editDuringRecording: { savedWhileRecording: boolean; secondPastedOnce: boolean }
  /** The target was stopped and started again while recording: nothing reaches the new process. */
  restarted: { notice: string; pastedIntoNewIncarnation: boolean }
  /** Suggest with a stopped session selected explains why there are no candidates. */
  noLiveSessionMessage: string
}
