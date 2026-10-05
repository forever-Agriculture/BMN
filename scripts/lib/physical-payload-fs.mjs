// Sealed payloads describe physical bytes. Electron's ordinary filesystem treats
// app.asar as a virtual directory; module loading continues to use that view.
import filesystem from 'node:fs'
import { createRequire } from 'node:module'

// process.execPath stays absolute in the installed CJS worker bundle. Failure to
// obtain Electron's physical filesystem must never fall back to its virtual view.
export const physicalPayloadFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs') : filesystem
