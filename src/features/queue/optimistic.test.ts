import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

/**
 * P7: оптимистичная готовность в очереди бариста. Проверяем инвариант,
 * который реализован в QueuePage: onMutate правит кэш ['queue'] сразу, при
 * ошибке откатывается снапшот. Тест воспроизводит ту же логику против живого
 * QueryClient (мутация-обёртка не завязана на DOM).
 */

interface QItem { id: string; prep_status: 'pending' | 'ready' }
interface QOrder { id: string; order_items: QItem[] }

function seed(): QOrder[] {
  return [
    { id: 'o1', order_items: [{ id: 'i1', prep_status: 'pending' }, { id: 'i2', prep_status: 'pending' }] },
  ]
}

// Копия onMutate/onError из QueuePage.readyItem
function optimisticReadyItem(qc: QueryClient, id: string, ready: boolean) {
  const prev = qc.getQueryData<QOrder[]>(['queue'])
  qc.setQueryData<QOrder[]>(['queue'], (old) =>
    old?.map((o) => ({
      ...o,
      order_items: o.order_items.map((i) => (i.id === id ? { ...i, prep_status: ready ? 'ready' : 'pending' } : i)),
    }))
  )
  return prev
}

describe('оптимистичная готовность позиции', () => {
  it('onMutate помечает позицию ready сразу', () => {
    const qc = new QueryClient()
    qc.setQueryData(['queue'], seed())
    optimisticReadyItem(qc, 'i1', true)
    const o = qc.getQueryData<QOrder[]>(['queue'])![0]
    expect(o.order_items.find((i) => i.id === 'i1')!.prep_status).toBe('ready')
    expect(o.order_items.find((i) => i.id === 'i2')!.prep_status).toBe('pending')
  })

  it('откат восстанавливает прежнее состояние при ошибке', () => {
    const qc = new QueryClient()
    qc.setQueryData(['queue'], seed())
    const prev = optimisticReadyItem(qc, 'i1', true)
    // Сервер ответил ошибкой → откат
    qc.setQueryData(['queue'], prev)
    const o = qc.getQueryData<QOrder[]>(['queue'])![0]
    expect(o.order_items.every((i) => i.prep_status === 'pending')).toBe(true)
  })

  it('«всё готово» убирает заказ из очереди сразу, откат возвращает', () => {
    const qc = new QueryClient()
    qc.setQueryData(['queue'], seed())
    const prev = qc.getQueryData<QOrder[]>(['queue'])
    qc.setQueryData<QOrder[]>(['queue'], (old) => old?.filter((o) => o.id !== 'o1'))
    expect(qc.getQueryData<QOrder[]>(['queue'])).toHaveLength(0)
    qc.setQueryData(['queue'], prev)
    expect(qc.getQueryData<QOrder[]>(['queue'])).toHaveLength(1)
  })
})
