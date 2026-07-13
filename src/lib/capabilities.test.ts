import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkCapabilities, chromeMajor } from './capabilities'

/**
 * P2: гейт совместимости. jsdom обычно рапортует поддержку CSS/Proxy, поэтому
 * проверяем «зелёный» путь и умение отчёта собрать список отсутствующих фич,
 * когда CSS.supports искусственно отключён (эмуляция древнего движка).
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkCapabilities', () => {
  it('на современном движке — ok, missing пуст', () => {
    // jsdom: CSS.supports может отсутствовать — подставим «всё поддерживается»
    vi.stubGlobal('CSS', { supports: () => true })
    const r = checkCapabilities()
    expect(r.ok).toBe(true)
    expect(r.missing).toHaveLength(0)
  })

  it('без CSS Grid/flex-gap/переменных — не ok, фичи в missing', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const r = checkCapabilities()
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('CSS Grid')
    expect(r.missing).toContain('flex gap')
    expect(r.missing).toContain('CSS variables')
  })

  it('chromeMajor парсит версию из UA', () => {
    const spy = vi.spyOn(navigator, 'userAgent', 'get')
    spy.mockReturnValue('Mozilla/5.0 (Linux; Android 7.1) Chrome/52.0.2743.98 Mobile Safari/537.36')
    expect(chromeMajor()).toBe(52)
  })

  it('chromeMajor → null на не-Chrome UA', () => {
    const spy = vi.spyOn(navigator, 'userAgent', 'get')
    spy.mockReturnValue('Mozilla/5.0 (Macintosh) Safari/605')
    expect(chromeMajor()).toBeNull()
  })
})
