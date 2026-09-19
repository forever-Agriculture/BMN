export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 2 } as const)

export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024
export const MAX_TERMINAL_CHUNK_BYTES = 256 * 1024

export const METHOD_REGISTRY = Object.freeze({
  hello: 'hello',
  healthGet: 'health.get',
  workspaceList: 'workspace.list',
  workspaceCreate: 'workspace.create',
  workspaceUpdate: 'workspace.update',
  sessionCreate: 'session.create',
  sessionList: 'session.list',
  sessionUpdate: 'session.update',
  sessionBindingGet: 'session.binding.get',
  sessionBindingReplace: 'session.binding.replace',
  sessionBindingClear: 'session.binding.clear',
  sessionResume: 'session.resume',
  sessionRelaunch: 'session.relaunch',
  sessionStop: 'session.stop',
  templateList: 'template.list',
  templateCreate: 'template.create',
  layoutGet: 'layout.get',
  layoutPut: 'layout.put',
  terminalAttach: 'terminal.attach',
  terminalActivate: 'terminal.activate',
  terminalWrite: 'terminal.write',
  terminalResize: 'terminal.resize',
  terminalDetach: 'terminal.detach',
  terminalSnapshotSave: 'terminal.snapshot.save',
  terminalFinalCaptureUnavailable: 'terminal.savedOutput.finalCaptureUnavailable',
  terminalSavedOutputGet: 'terminal.savedOutput.get',
  artifactList: 'artifact.list',
  artifactImport: 'artifact.import',
  artifactImportBytes: 'artifact.importBytes',
  artifactSaveAs: 'artifact.saveAs',
  artifactPreview: 'artifact.preview',
  artifactDeliver: 'artifact.deliver',
  fileReferenceRead: 'file.reference.read',
  attentionList: 'attention.list',
  attentionSeen: 'attention.seen',
  attentionResolve: 'attention.resolve',
  progressList: 'progress.list',
  draftList: 'draft.list',
  draftSave: 'draft.save',
  draftRetry: 'draft.retry',
  draftSend: 'draft.send',
  draftDiscard: 'draft.discard',
  settingsGet: 'settings.get',
  settingsPut: 'settings.put',
  backupExport: 'backup.export',
  backupVerify: 'backup.verify',
  telegramConfigure: 'telegram.configure',
  telegramStatus: 'telegram.status',
  telegramTest: 'telegram.test',
  controlInfo: 'control.info',
  presenceSet: 'presence.set'
} as const)

export type ProtocolMethod = (typeof METHOD_REGISTRY)[keyof typeof METHOD_REGISTRY]

const methodSet: ReadonlySet<string> = new Set(Object.values(METHOD_REGISTRY))

export function isProtocolMethod(value: unknown): value is ProtocolMethod {
  return typeof value === 'string' && methodSet.has(value)
}
