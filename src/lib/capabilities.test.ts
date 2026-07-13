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
    expect(r.warnings).toHaveLength(0)
  })

  it('без CSS Grid/переменных — не ok, flex-gap уходит в fallback warning', () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const r = checkCapabilities()
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('CSS Grid')
    expect(r.missing).toContain('CSS variables')
    expect(r.warnings).toContain('flex gap fallback')
    expect(r.missing).not.toContain('flex gap')
  })

  it('Chrome 60 проходит критичный gate и включает flex-gap fallback', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 7.1) Chrome/60.0.3112.107 Mobile Safari/537.36',
    )
    const r = checkCapabilities()
    expect(r.ok).toBe(true)
    expect(r.warnings).toContain('flex gap fallback')
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
