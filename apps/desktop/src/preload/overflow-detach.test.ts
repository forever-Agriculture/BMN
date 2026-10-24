import { describe, expect, it, vi } from 'vitest'
import { recoverAfterTransportFailure } from './overflow-detach'

describe('preload transport overflow detach', () => {
  it('consumes a rejected fresh-view recovery after a transport failure', async () => {
    const recover = vi.fn(() => Promise.reject(new Error('renderer was already replaced')))

    await expect(recoverAfterTransportFailure(recover)).resolves.toBeUndefined()

    expect(recover).toHaveBeenCalledOnce()
  })
})
