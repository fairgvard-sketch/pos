import { onlineManager } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { createPublicQueryClient } from './publicQueryClient'

describe('public app query client', () => {
  it('does not pause guest requests on a stale browser offline signal', async () => {
    const client = createPublicQueryClient()
    const queryFn = vi.fn().mockResolvedValue('restaurant')

    onlineManager.setOnline(false)
    try {
      await expect(client.fetchQuery({ queryKey: ['restaurant'], queryFn }))
        .resolves.toBe('restaurant')
      expect(queryFn).toHaveBeenCalledTimes(1)
    } finally {
      onlineManager.setOnline(true)
      client.clear()
    }
  })
})
