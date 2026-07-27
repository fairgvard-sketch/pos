import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PublicApiError, fetchPublicStatus } from './publicApi'

/**
 * Таймаут сетевых запросов. Без него на слабом Wi-Fi кафе запрос висит
 * бесконечно: кнопка залипает в «отправка», и гость не знает, ушёл заказ
 * или нет. Защита невидимая — сломать её можно, не заметив, поэтому тест.
 */
describe('publicApi: таймаут', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('зависший запрос обрывается ошибкой network, а не висит вечно', async () => {
    // fetch, который никогда не ответит — но уважает signal
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))

    const promise = fetchPublicStatus('11111111-1111-4111-8111-111111111111')
    const assertion = expect(promise).rejects.toMatchObject({ code: 'network' })

    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('сетевой сбой отдаётся как PublicApiError, а не сырым TypeError', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))

    await expect(fetchPublicStatus('11111111-1111-4111-8111-111111111111'))
      .rejects.toBeInstanceOf(PublicApiError)
  })
})
