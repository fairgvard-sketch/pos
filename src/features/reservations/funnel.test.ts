import { beforeEach, describe, expect, it } from 'vitest'
import { captureAttribution } from './funnel'

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
