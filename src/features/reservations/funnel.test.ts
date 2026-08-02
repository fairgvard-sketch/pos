import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureAttribution } from './funnel'

vi.mock('../online/publicApi', () => ({
  resolveLocationId: async (id: string) => id,
}))

/**
 * Канал привода читается из адреса ОДИН раз за вкладку: страница
 * переписывает свой URL, получив бронь (118), и к моменту отправки
 * исходных меток в адресе уже нет. Если это сломать, вся атрибуция
 * молча схлопнется в 'direct' — незаметно и необратимо.
 */
describe('captureAttribution', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('читает utm-метки и наш src', () => {
    const attribution = captureAttribution(
      '?src=qr&utm_source=instagram&utm_campaign=summer&utm_medium=story'
    )
    expect(attribution.src).toBe('qr')
    expect(attribution.utm).toEqual({
      source: 'instagram',
      campaign: 'summer',
      medium: 'story',
    })
  })

  it('запоминает первое значение и переживает потерю меток из адреса', () => {
    captureAttribution('?src=qr&utm_source=instagram')
    // Тот же вызов уже с пустым адресом — так выглядит страница после
    // writeBookingUrl, и канал не должен обнулиться.
    expect(captureAttribution('').src).toBe('qr')
    expect(captureAttribution('?src=link').src).toBe('qr')
  })

  it('без меток отдаёт пустую атрибуцию, а не выдумывает канал', () => {
    const attribution = captureAttribution('')
    expect(attribution.src).toBeNull()
    expect(attribution.utm).toEqual({})
  })

  it('игнорирует пустые метки и режет слишком длинные', () => {
    const attribution = captureAttribution(`?src=%20&utm_source=${'x'.repeat(200)}`)
    expect(attribution.src).toBeNull()
    expect(attribution.utm.source).toHaveLength(64)
  })
})

/**
 * Сессия — единица отчёта (125): шаги считаются РАЗНЫМИ сессиями. Если
 * один гость раздаётся на несколько сессий или новая сессия начинается
 * без вершины, воронка перестаёт сходиться — у владельца выходит
 * «выбрали время 2 из 1 открывших страницу», то есть 200 %.
 */
describe('сессия воронки', () => {
  const sessions: string[] = []

  async function load() {
    vi.resetModules()
    sessions.length = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sessions.push(JSON.parse(String(init.body)).session_id)
      return { ok: true } as Response
    }))
    return import('./funnel')
  }

  /** Телеметрия уходит фоном: ждём, пока очередь микрозадач опустеет. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('держит один id на все шаги одного гостя', async () => {
    const { trackReserveStep } = await load()
    trackReserveStep('loc', 'page_view')
    trackReserveStep('loc', 'availability', { party_size: 2, wanted_date: '2026-08-10' })
    trackReserveStep('loc', 'slot_selected', { party_size: 2, wanted_date: '2026-08-10' })
    await settle()

    expect(sessions).toHaveLength(3)
    expect(new Set(sessions).size).toBe(1)
  })

  it('вторая заявка начинает новую сессию', async () => {
    const { trackReserveStep, resetFunnelSession } = await load()
    trackReserveStep('loc', 'page_view')
    await settle()
    resetFunnelSession()
    trackReserveStep('loc', 'page_view')
    await settle()

    expect(sessions).toHaveLength(2)
    expect(sessions[0]).not.toBe(sessions[1])
  })

  it('без sessionStorage гость остаётся одним гостем, а не пятью', async () => {
    // Приватный режим и встроенный кадр: хранилище бросает на любой вызов.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })

    const { trackReserveStep } = await load()
    trackReserveStep('loc', 'page_view')
    trackReserveStep('loc', 'availability', { party_size: 2, wanted_date: '2026-08-10' })
    trackReserveStep('loc', 'submitted', { party_size: 2, wanted_date: '2026-08-10' })
    await settle()

    expect(sessions).toHaveLength(3)
    expect(new Set(sessions).size).toBe(1)
  })

  it('сброс сессии работает и без хранилища', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })

    const { trackReserveStep, resetFunnelSession } = await load()
    trackReserveStep('loc', 'page_view')
    await settle()
    resetFunnelSession()
    trackReserveStep('loc', 'page_view')
    await settle()

    expect(new Set(sessions).size).toBe(2)
  })
})
