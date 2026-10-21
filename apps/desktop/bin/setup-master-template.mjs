// MODULE: setup-master-template.mjs - Owner-approved public pointers and setup-owned absent master installation
import { withDefaultsAdmission } from './defaults-admission.mjs'
import { masterPath } from './agents-rules.mjs'
import { readApproved } from './agents-state.mjs'
import { installSetupFile } from './setup-file-defaults.mjs'

// Exact text approved in owner card call_d573982af96e4bb5bc367c4dd99bc416 item1, 2026-10-20.
export const DEFAULT_SETUP_MASTER = `<!-- bmn:public -->
# Agent guide

- Session controls and current context: BMN's start brief.
- Available commands: \`bmn help agents\`.
- Account permissions: \`bmn policy\`.
- Task workflows: BMN's installed skills, including \`plan\`, \`team-ask\` and \`web-question\`.
<!-- /bmn:public -->
`

export function installSetupMaster({ setupId } = {}) {
  return withDefaultsAdmission(() => {
    try { readApproved() } catch (error) {
      return { code: error.code ?? 'STATE_CORRUPT', transaction: null, written: [], message: error.message }
    }
    const target = { kind: 'master', app: 'master', path: masterPath(), entry: 'master' }
    return installSetupFile(target, DEFAULT_SETUP_MASTER, { setupId })
  })
}
