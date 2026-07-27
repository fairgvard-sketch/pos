import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdleReset, CONFIRM_SEC } from './useIdleReset'

/**
 * Киоск-режим: минута без касаний → вопрос → 20 секунд → сброс.
 * Логика на таймерах, ошибку в ней глазами не поймать: гость либо
 * теряет собранную корзину раньше времени, либо чужой заказ висит на
 * планшете до следующего посетителя.
 */
describe('useIdleReset', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('минуту молчит, потом показывает вопрос', () => {
    const onReset = vi.fn()
    const { result } = renderHook(() => useIdleReset(true, onReset))

    expect(result.current.countdown).toBeNull()
    act(() => { vi.advanceTimersByTime(59_000) })
    expect(result.current.countdown).toBeNull()

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(result.current.countdown).toBe(CONFIRM_SEC)
    expect(onReset).not.toHaveBeenCalled()
  })

  it('без ответа за 20 секунд — сброс', () => {
    const onReset = vi.fn()
    const { result } = renderHook(() => useIdleReset(true, onReset))

    act(() => { vi.advanceTimersByTime(60_000) })
    act(() => { vi.advanceTimersByTime(CONFIRM_SEC * 1000) })

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(result.current.countdown).toBeNull()
  })

  it('«я здесь» снимает вопрос и начинает отсчёт заново', () => {
    const onReset = vi.fn()
    const { result } = renderHook(() => useIdleReset(true, onReset))

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(result.current.countdown).toBe(CONFIRM_SEC)

    act(() => { result.current.stayActive() })
    expect(result.current.countdown).toBeNull()

    // Полминуты после ответа — вопроса быть не должно
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(result.current.countdown).toBeNull()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('касание сбрасывает отсчёт бездействия', () => {
    const onReset = vi.fn()
    const { result } = renderHook(() => useIdleReset(true, onReset))

    act(() => { vi.advanceTimersByTime(50_000) })
    act(() => { window.dispatchEvent(new Event('pointerdown')) })
    // Ещё 50 секунд: суммарно 100, но отсчёт начался заново
    act(() => { vi.advanceTimersByTime(50_000) })

    expect(result.current.countdown).toBeNull()
    expect(onReset).not.toHaveBeenCalled()
  })

  it('выключенный хук не сбрасывает (экран статуса заказа)', () => {
    const onReset = vi.fn()
    const { result } = renderHook(() => useIdleReset(false, onReset))

    act(() => { vi.advanceTimersByTime(120_000) })

    expect(result.current.countdown).toBeNull()
    expect(onReset).not.toHaveBeenCalled()
  })
})
