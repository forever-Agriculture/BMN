import { describe, expect, it, vi } from 'vitest'
import {
  detachAfterTransportOverflow,
  recoverAfterTransportFailure
} from './overflow-detach'

describe('preload transport overflow detach', () => {
  it('consumes a rejected best-effort detach without an unhandled rejection', async () => {
    const detach = vi.fn(() => Promise.reject(new Error('terminal host already exited')))

    await expect(detachAfterTransportOverflow(detach)).resolves.toBeUndefined()

    expect(detach).toHaveBeenCalledOnce()
  })

  it('consumes a rejected fresh-view recovery after a transport failure', async () => {
    const recover = vi.fn(() => Promise.reject(new Error('renderer was already replaced')))

    await expect(recoverAfterTransportFailure(recover)).resolves.toBeUndefined()

    expect(recover).toHaveBeenCalledOnce()
  })
})
