import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Жизненный цикл обновления кассы.
 *
 * Проверяется ровно то, из-за чего терминал месяцами отдавал старый
 * бандл: приложение обязано УВИДЕТЬ готовый воркер (в том числе тот, что
 * уже ждал до открытия вкладки), применить его по команде и перезагрузиться
 * РОВНО один раз — и не перезагружаться, когда его об этом не просили.
 */

let registerOptions: {
  onNeedRefresh?: () => void
  onRegisteredSW?: (url: string, reg: unknown) => void
  onRegisterError?: (e: unknown) => void
} = {}

vi.mock('virtual:pwa-register', () => ({
  registerSW: (options: typeof registerOptions) => {
    registerOptions = options
    return () => Promise.resolve()
  },
}))

interface FakeWorker {
  state: string
  postMessage: ReturnType<typeof vi.fn>
  addEventListener: (type: string, fn: () => void) => void
  fire: () => void
}

function makeWorker(state: string): FakeWorker {
  const listeners: (() => void)[] = []
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (_type, fn) => { listeners.push(fn) },
    fire: () => listeners.forEach((fn) => fn()),
  }
}

function makeRegistration(parts: { waiting?: FakeWorker; installing?: FakeWorker; active?: FakeWorker }) {
  return {
    ...parts,
    scope: '/',
    update: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  }
}

let controllerChange: (() => void)[] = []
let reload: ReturnType<typeof vi.fn>

function stubServiceWorker(controller: unknown) {
  controllerChange = []
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller,
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'controllerchange') controllerChange.push(fn)
      },
      getRegistrations: vi.fn().mockResolvedValue([]),
    },
  })
}

beforeEach(() => {
  vi.resetModules()
  registerOptions = {}
  reload = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, href: 'https://pos.example/sell' },
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('обнаружение готовой версии', () => {
  it('видит воркер, который уже ждал до запуска кассы', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, getSwDiagnostics } = await import('./swUpdate')
    const onNeed = vi.fn()

    setupSwUpdate(onNeed)
    const waiting = makeWorker('installed')
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ waiting }))

    expect(onNeed).toHaveBeenCalled()
    expect(getSwDiagnostics().waiting).toBe(true)
    expect(getSwDiagnostics().state).toBe('waiting')
  })

  it('дожидается воркера, который ставится прямо сейчас', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, getSwDiagnostics } = await import('./swUpdate')
    const onNeed = vi.fn()

    setupSwUpdate(onNeed)
    const installing = makeWorker('installing')
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ installing }))
    expect(onNeed).not.toHaveBeenCalled()
    expect(getSwDiagnostics().state).toBe('installing')

    installing.state = 'installed'
    installing.fire()
    expect(onNeed).toHaveBeenCalled()
  })

  it('первая установка на чистом устройстве — это не обновление', async () => {
    // Контроллера нет: приложение открыли впервые, обновлять нечего и
    // показывать плашку «доступна новая версия» бессмысленно.
    stubServiceWorker(null)
    const { setupSwUpdate, getSwDiagnostics } = await import('./swUpdate')
    const onNeed = vi.fn()

    setupSwUpdate(onNeed)
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ waiting: makeWorker('installed') }))

    expect(onNeed).not.toHaveBeenCalled()
    expect(getSwDiagnostics().waiting).toBe(false)
  })

  it('сбой регистрации попадает в диагностику, а не теряется', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, getSwDiagnostics } = await import('./swUpdate')
    setupSwUpdate(vi.fn())

    registerOptions.onRegisterError?.(new Error('bad MIME type'))
    expect(getSwDiagnostics().state).toBe('error')
    expect(getSwDiagnostics().error).toContain('bad MIME')
  })
})

describe('применение обновления', () => {
  it('будит ждущий воркер и перезагружается ровно один раз', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, applyUpdate } = await import('./swUpdate')
    setupSwUpdate(vi.fn())

    const waiting = makeWorker('installed')
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ waiting }))

    applyUpdate()
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reload).not.toHaveBeenCalled()

    // Новый воркер взял управление
    controllerChange.forEach((fn) => fn())
    expect(reload).toHaveBeenCalledTimes(1)

    // Повторные события и повторное нажатие не дают второй перезагрузки
    controllerChange.forEach((fn) => fn())
    applyUpdate()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('не перезагружает кассу, когда контроллер сменила другая вкладка', async () => {
    stubServiceWorker({})
    const { setupSwUpdate } = await import('./swUpdate')
    setupSwUpdate(vi.fn())
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ waiting: makeWorker('installed') }))

    controllerChange.forEach((fn) => fn())
    expect(reload).not.toHaveBeenCalled()
  })

  it('без ждущего воркера просто перезагружается, а не зависает', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, applyUpdate } = await import('./swUpdate')
    setupSwUpdate(vi.fn())
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ active: makeWorker('activated') }))

    applyUpdate()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('страховка добивает перезагрузку, если воркер не ответил', async () => {
    stubServiceWorker({})
    const { setupSwUpdate, applyUpdate } = await import('./swUpdate')
    setupSwUpdate(vi.fn())
    registerOptions.onRegisteredSW?.('/sw.js', makeRegistration({ waiting: makeWorker('installed') }))

    applyUpdate()
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3000)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
