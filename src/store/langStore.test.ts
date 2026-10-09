import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Язык интерфейса: иврит по умолчанию, английский и русский — выбором.
 * Флаг читается при импорте модуля, поэтому каждый кейс пересоздаёт store
 * через resetModules + dynamic import.
 */
describe('langStore', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('по умолчанию иврит и RTL', async () => {
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore } = await import('./langStore')
    expect(useLangStore.getState().lang).toBe('he')
  })

  it('английский и русский выбираются в любой сборке и ведут <html lang>', async () => {
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore } = await import('./langStore')

    useLangStore.getState().setLang('en')
    expect(useLangStore.getState().lang).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.documentElement.dir).toBe('ltr')

    useLangStore.getState().setLang('ru')
    expect(document.documentElement.lang).toBe('ru')

    useLangStore.getState().setLang('he')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('выбор переживает перезапуск', async () => {
    localStorage.setItem('kassa-lang', JSON.stringify({ state: { lang: 'en' }, version: 0 }))
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore } = await import('./langStore')
    expect(useLangStore.getState().lang).toBe('en')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('повреждённое значение в storage — язык по умолчанию', async () => {
    localStorage.setItem('kassa-lang', JSON.stringify({ state: { lang: 'xx' }, version: 0 }))
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', '')
    const { useLangStore } = await import('./langStore')
    expect(useLangStore.getState().lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('флаг внутренних стендов меняет только язык по умолчанию', async () => {
    vi.stubEnv('VITE_ENABLE_INTERNAL_RUSSIAN', 'true')
    const { useLangStore } = await import('./langStore')
    expect(useLangStore.getState().lang).toBe('ru')
    useLangStore.getState().setLang('en')
    expect(useLangStore.getState().lang).toBe('en')
  })
})
