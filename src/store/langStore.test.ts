import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Иврит-only прод (P3-14): без VITE_ENABLE_INTERNAL_RUSSIAN касса живёт
 * только на иврите. Флаг читается при импорте модуля, поэтому каждый кейс
 * пересоздаёт store через resetModules + dynamic import.
 */
describe('langStore he-only (P3-14)', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('без флага: дефолт he, setLang(ru) игнорируется', async () => {
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore, RUSSIAN_UI_ENABLED } = await import('./langStore')
    expect(RUSSIAN_UI_ENABLED).toBe(false)
    expect(useLangStore.getState().lang).toBe('he')

    useLangStore.getState().setLang('ru')
    expect(useLangStore.getState().lang).toBe('he')
    expect(document.documentElement.lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('без флага: persisted ru от старой сборки приводится к he', async () => {
    localStorage.setItem('kassa-lang', JSON.stringify({ state: { lang: 'ru' }, version: 0 }))
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore } = await import('./langStore')
    expect(useLangStore.getState().lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('с флагом: переключение работает в обе стороны и ведёт <html lang>', async () => {
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', 'true')
    const { useLangStore } = await import('./langStore')

    useLangStore.getState().setLang('he')
    expect(useLangStore.getState().lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')

    useLangStore.getState().setLang('ru')
    expect(useLangStore.getState().lang).toBe('ru')
    expect(document.documentElement.lang).toBe('ru')
    expect(document.documentElement.dir).toBe('ltr')
  })
})
