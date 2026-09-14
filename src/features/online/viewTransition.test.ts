import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigateWithTransition } from './viewTransition'

interface DeferredTransition {
  finished: Promise<void>
  finish: () => void
  skipTransition: ReturnType<typeof vi.fn>
}

function deferredTransition(): DeferredTransition {
  let finish = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  return { finished, finish, skipTransition: vi.fn() }
}

afterEach(async () => {
  Reflect.deleteProperty(document, 'startViewTransition')
  delete document.documentElement.dataset.nav
  // Дать finally предыдущего перехода очистить модульное состояние.
  await Promise.resolve()
  vi.restoreAllMocks()
})

describe('navigateWithTransition', () => {
  it('не теряет быстрый повторный переход, пока предыдущая анимация ещё идёт', async () => {
    const first = deferredTransition()
    const startViewTransition = vi.fn((update: () => void) => {
      update()
      return first
    })
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })

    const states: string[] = []
    navigateWithTransition('back', () => states.push('hero'))
    navigateWithTransition('forward', () => states.push('menu'))

    expect(states).toEqual(['hero', 'menu'])
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(first.skipTransition).toHaveBeenCalledTimes(1)

    first.finish()
    await first.finished
    await Promise.resolve()
    expect(document.documentElement).not.toHaveAttribute('data-nav')
  })

  it('применяет навигацию, если браузерный API синхронно падает', () => {
    const startViewTransition = vi.fn(() => { throw new Error('snapshot failed') })
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })
    const commit = vi.fn()

    navigateWithTransition('forward', commit)

    expect(commit).toHaveBeenCalledTimes(1)
    expect(document.documentElement).not.toHaveAttribute('data-nav')
  })
})
