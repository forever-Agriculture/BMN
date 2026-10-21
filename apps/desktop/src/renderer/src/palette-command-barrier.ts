// MODULE: palette-command-barrier.ts - One-shot command-entry control, exposed only by test-mode terminal hooks.
export class PaletteCommandBarrier {
  private pending: { command: string; session: string; phase: 'armed' | 'held' | 'released' | 'failed'; run?: () => void } | null = null

  arm(command: string, session: string): void {
    if (this.pending || !command || !session) throw new Error('Palette command barrier was already armed or has no target')
    this.pending = { command, session, phase: 'armed' }
  }

  state(): { command: string; session: string; phase: string } | null {
    return this.pending ? { command: this.pending.command, session: this.pending.session, phase: this.pending.phase } : null
  }

  intercept(command: string, session: string | null, run: () => void): boolean {
    const pending = this.pending
    if (!pending || pending.command !== command) return false
    if (pending.phase !== 'armed' || pending.session !== session) {
      pending.phase = 'failed'
      delete pending.run
      throw new Error('Palette command barrier received a duplicate command or a different session')
    }
    pending.phase = 'held'
    pending.run = run
    return true
  }

  release(command: string, session: string): void {
    const pending = this.pending
    if (!pending || pending.phase !== 'held' || pending.command !== command || pending.session !== session || !pending.run) {
      throw new Error('Palette command barrier is not holding this command and session')
    }
    const run = pending.run
    delete pending.run
    pending.phase = 'released'
    run()
  }
}

/** No barrier exists outside test mode; ordinary commands still run inside their original deferred callback. */
export function runDeferredPaletteCommand(command: string, session: string | null, run: () => void, barrier?: PaletteCommandBarrier): void {
  if (!barrier?.intercept(command, session, run)) run()
}
