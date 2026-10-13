// MODULE: electron.vite.config.ts - what the desktop app is built from: the main process with its host and worker entries, the preload script and the window
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@bmn/protocol'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'pty-host': resolve(__dirname, 'src/utility/pty-host.ts'),
          'database-worker': resolve(__dirname, 'src/utility/database-worker.ts'),
          'turn-changes-worker': resolve(__dirname, 'src/utility/turn-changes-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@bmn/protocol'] })]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()]
  }
})
