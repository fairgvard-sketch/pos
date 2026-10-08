import { describe, expect, it, vi } from 'vitest'
import { createRelay, failureCode, jobTicket, type RelayDeps, type WaiterPrintJob } from './waiterPrintRelay'

const job = (id: string, payload: unknown = { tableLabel: '5', staffName: 'Dana', fire: false, lines: [{ qty: 1, name: 'Salad', variantName: null, modifiers: [], notes: '' }] }): WaiterPrintJob => ({
  id, kind: 'kitchen', payload, created_at: '2026-10-09T10:00:00Z',
})

function deps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    claim: vi.fn().mockResolvedValue([]),
    finish: vi.fn().mockResolvedValue(undefined),
    print: vi.fn().mockResolvedValue({ ok: true, status: 'success', message: null }),
    canPrint: () => true,
    deviceName: () => 'Kitchen T2',
    notifyFailure: vi.fn(),
    ...over,
  }
}

describe('jobTicket', () => {
  it('собирает тикет дозаказа стола из снимка', () => {
    const t = jobTicket(job('a').payload, 'Kitchen T2')
    expect(t).toMatchObject({ dailyNumber: null, orderType: 'here', tableLabel: '5', staffName: 'Dana', deviceName: 'Kitchen T2', fire: false })
    expect(t.lines).toEqual([{ qty: 1, name: 'Salad', variantName: null, modifiers: [], notes: '' }])
  })

  it('битые строки отбрасываются, payload без полей не роняет печать', () => {
    const t = jobTicket({ fire: true, lines: [{ qty: 0, name: 'X' }, { qty: 2, name: '' }, 'junk', { qty: 2, name: 'Steak', modifiers: ['Medium', 3] }] }, '')
    expect(t.fire).toBe(true)
    expect(t.lines).toEqual([{ qty: 2, name: 'Steak', variantName: null, modifiers: ['Medium'], notes: '' }])
    expect(jobTicket(null, '').lines).toEqual([])
  })
})

describe('createRelay', () => {
  it('печатает забранные задания и отчитывается об успехе', async () => {
    const d = deps({ claim: vi.fn().mockResolvedValueOnce([job('a'), job('b')]).mockResolvedValue([]) })
    await createRelay(d).drain()
    expect(d.print).toHaveBeenCalledTimes(2)
    expect(d.finish).toHaveBeenCalledWith('a', true, null)
    expect(d.finish).toHaveBeenCalledWith('b', true, null)
  })

  it('ошибка принтера: сервер узнаёт причину, кассир получает «повторить»', async () => {
    const d = deps({
      claim: vi.fn().mockResolvedValueOnce([job('a')]).mockResolvedValue([]),
      print: vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 'no-paper', message: 'cover open' })
        .mockResolvedValue({ ok: true, status: 'success', message: null }),
    })
    await createRelay(d).drain()
    expect(d.finish).toHaveBeenCalledWith('a', false, 'no-paper: cover open')
    const retry = (d.notifyFailure as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void
    retry()
    await vi.waitFor(() => expect(d.finish).toHaveBeenLastCalledWith('a', true, null))
  })

  it('нет тихого пути печати — задание проваливается, а не висит', async () => {
    const d = deps({ claim: vi.fn().mockResolvedValueOnce([job('a')]).mockResolvedValue([]), canPrint: () => false })
    await createRelay(d).drain()
    expect(d.print).not.toHaveBeenCalled()
    expect(d.finish).toHaveBeenCalledWith('a', false, 'disconnected: no-print-path')
  })

  it('отчёт, не дошедший до сервера, отправляется следующим проходом', async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(undefined)
    const d = deps({ claim: vi.fn().mockResolvedValueOnce([job('a')]).mockResolvedValue([]), finish })
    const relay = createRelay(d)
    await relay.drain()
    await relay.drain()
    expect(finish).toHaveBeenNthCalledWith(2, 'a', true, null)
    expect(d.print).toHaveBeenCalledTimes(1)
  })

  it('полная пачка — забирает следующую сразу', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => job(`j${i}`))
    const d = deps({ claim: vi.fn().mockResolvedValueOnce(ten).mockResolvedValueOnce([job('last')]).mockResolvedValue([]) })
    await createRelay(d).drain()
    expect(d.print).toHaveBeenCalledTimes(11)
  })

  it('сбой claim не роняет цикл', async () => {
    const d = deps({ claim: vi.fn().mockRejectedValue(new Error('Failed to fetch')) })
    await expect(createRelay(d).drain()).resolves.toBeUndefined()
  })
})

describe('failureCode', () => {
  it('статус и деталь через двоеточие, без пустых частей', () => {
    expect(failureCode({ ok: false, status: 'timeout', message: null })).toBe('timeout')
    expect(failureCode({ ok: false, status: 'error', message: 'jam' })).toBe('error: jam')
  })
})
