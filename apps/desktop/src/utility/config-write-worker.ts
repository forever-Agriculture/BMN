// MODULE: config-write-worker.ts - keep synchronous native config ACL/replace work off the PTY service event loop
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { ConfigWriteError } from './safe-config-write'

interface ConfigEdit {
  path: string
  text: string | null
  next: string
  expectedTarget: string
}

// Fixed source; paths/settings travel through local workerData, never code or argv.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
 try {
  const { writeConfigSafely } = await import(workerData.moduleUrl);
  const e = workerData.edit;
  const result = writeConfigSafely(e.path, e.text, e.next, { expectedTarget: e.expectedTarget });
  parentPort.postMessage({ ok: true, result });
 } catch (error) {
  parentPort.postMessage({ ok: false, code: error.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : 'IO_ERROR' });
 }
})();`

export function writeConfigInWorker(modulePath: string, edit: ConfigEdit): Promise<{ target: string; backup: string | null }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SOURCE, { eval: true, workerData: { moduleUrl: pathToFileURL(modulePath).href, edit } })
    let received = false
    worker.once('message', (message) => {
      received = true
      if (message?.ok === true) resolve(message.result)
      else reject(new ConfigWriteError(message?.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : 'IO_ERROR', 'Config write could not be confirmed'))
    })
    worker.once('error', () => reject(new ConfigWriteError('IO_ERROR', 'Config worker failed; inspect original and retained backup/staged files')))
    worker.once('exit', () => {
      if (!received) reject(new ConfigWriteError('IO_ERROR', 'Config worker exited without confirming the write'))
    })
    // Do not terminate a worker mid-replacement: the native writer bounds its operations,
    // and the application lifetime job owns all descendant processes on application exit.
  })
}
