import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hardReload, updateDiagnosticsText } from './appUpdate'

/**
 * Принудительная переустановка оболочки.
 *
 * Главное требование — не потерять работу кассы. В `localStorage` и
 * IndexedDB лежат офлайн-очередь продаж, сессия устройства и кэш каталога;
 * снести их ради обновления фронтенда нельзя ни при каких условиях.
 * Чистятся только Cache Storage и регистрации service worker.
 */

let replaced: string | null = null
const unregister = vi.fn().mockResolvedValue(true)
const cacheDelete = vi.fn().mockResolvedValue(true)

beforeEach(() => {
  replaced = null
  unregister.mockClear()
  cacheDelete.mockClear()

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
  })
  Object.defineProperty(window, 'caches', {
    configurable: true,
    value: { keys: vi.fn().mockResolvedValue(['shell-v1', 'shell-v2']), delete: cacheDelete },
  })
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: 'https://pos.example/sell',
      origin: 'https://pos.example',
      pathname: '/sell',
      replace: (url: string) => { replaced = url },
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hardReload', () => {
  it('сносит оболочку и регистрации, но не трогает данные кассы', async () => {
    localStorage.setItem('kassa-query-cache', '{"offline":"queue"}')
    const clear = vi.spyOn(Storage.prototype, 'clear')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')

    await hardReload()

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    // Очередь офлайн-продаж переживает обновление — иначе цена ошибки
    // выше, чем сама проблема
    expect(clear).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(localStorage.getItem('kassa-query-cache')).toBe('{"offline":"queue"}')
  })

  it('уходит на свежий документ с кэш-бастером', async () => {
    await hardReload()
    expect(replaced).toMatch(/^https:\/\/pos\.example\/sell\?v=\d+$/)
  })

  it('переживает запрет на доступ к кэшам и всё равно перезагружается', async () => {
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: { keys: vi.fn().mockRejectedValue(new Error('denied')), delete: cacheDelete },
    })
    await hardReload()
    expect(replaced).toContain('?v=')
  })
})

describe('updateDiagnosticsText', () => {
  it('собирает то, что нужно поддержке, и ничего лишнего', () => {
    const text = updateDiagnosticsText()
    expect(text).toContain('app: ')
    expect(text).toContain('sw: ')
    expect(text).toContain('sw controlled: ')
    // Адрес без query: в нём могут быть идентификаторы точки и стола
    expect(text).toContain('url: https://pos.example/sell')
    expect(text).not.toContain('?')
  })
})
