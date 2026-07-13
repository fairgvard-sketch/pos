import { describe, it, expect, beforeAll } from 'vitest'
import { renderReceiptCanvas, renderKitchenTicketCanvas } from './printCanvas'
import type { Receipt } from './api'

/**
 * P2/P6: длинный чек/тикет не должен обрезаться. Раньше черновой холст был
 * фиксированной высоты (3000/2000px) — заказ на сотни позиций рисовался за
 * границей и хвост терялся. Проверяем, что высота итогового canvas растёт с
 * числом позиций и что максимальный чек не упирается в старый потолок.
 *
 * jsdom не рисует canvas — подменяем getContext на no-op 2d-контекст, нам
 * важна арифметика высоты (scratchHeight), а не пиксели.
 */

beforeAll(() => {
  const ctxStub = new Proxy(
    {
      canvas: null as unknown,
      font: '',
      textAlign: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    },
    {
      get(target, prop) {
        if (typeof prop === 'string' && prop in target) return (target as Record<string, unknown>)[prop]
        // Любой метод (fillText, fillRect, moveTo, …) — no-op; measureText → ширина
        if (prop === 'measureText') return () => ({ width: 10 })
        return () => undefined
      },
      set(target, prop, value) {
        if (typeof prop === 'string') (target as Record<string, unknown>)[prop] = value
        return true
      },
    }
  )
  // @ts-expect-error — тестовый стаб canvas 2d
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return ctxStub
  }
})

function baseReceipt(lineCount: number): Receipt {
  return {
    receipt_number: 1,
    doc_type: 'receipt',
    daily_number: 1,
    created_at: new Date().toISOString(),
    order_type: 'takeaway',
    customer_name: '',
    lines: Array.from({ length: lineCount }, (_, i) => ({
      name: `פריט ${i}`,
      variant_name: null,
      unit_price: 1200,
      qty: 1,
      line_total: 1200,
      modifiers: [],
    })),
    subtotal: 1200 * lineCount,
    discount_amount: 0,
    discount_type: null,
    discount_value: 0,
    loyalty_discount: 0,
    tip_amount: 0,
    total: 1200 * lineCount,
    vat_rate: 17,
    vat_amount: Math.round(1200 * lineCount * 17 / 117),
    payments: [{ method: 'cash', amount: 1200 * lineCount, tendered: null, change_due: null }],
  } as unknown as Receipt
}

describe('renderReceiptCanvas — высота по контенту', () => {
  it('короткий чек рендерится и имеет разумную высоту', () => {
    const c = renderReceiptCanvas(baseReceipt(1), undefined)
    expect(c.width).toBe(576)
    expect(c.height).toBeGreaterThan(0)
    expect(c.height).toBeLessThan(1500)
  })

  it('длинный чек выше короткого (не обрезан по старому потолку 3000px)', () => {
    const short = renderReceiptCanvas(baseReceipt(2), undefined)
    const long = renderReceiptCanvas(baseReceipt(200), undefined)
    expect(long.height).toBeGreaterThan(short.height)
    // 200 позиций × ~34px + шапка/подвал заведомо больше старого фикса 3000
    expect(long.height).toBeGreaterThan(3000)
  })

  it('максимальный чек не превышает страховочный потолок', () => {
    const huge = renderReceiptCanvas(baseReceipt(5000), undefined)
    expect(huge.height).toBeLessThanOrEqual(20000)
  })
})

describe('renderKitchenTicketCanvas — высота по контенту', () => {
  it('длинный тикет выше короткого', () => {
    const mk = (n: number) => ({
      dailyNumber: 1,
      orderType: 'takeaway' as const,
      tableLabel: '',
      customerName: '',
      labels: { takeaway: 'לקחת', here: 'כאן', delivery: 'משלוח', table: 'שולחן', addon: 'תוספת' },
      lines: Array.from({ length: n }, (_, i) => ({
        name: `פריט ${i}`,
        variantName: null,
        qty: 1,
        modifiers: [],
        notes: '',
      })),
    })
    const short = renderKitchenTicketCanvas(mk(2) as never)
    const long = renderKitchenTicketCanvas(mk(100) as never)
    expect(long.height).toBeGreaterThan(short.height)
    expect(long.height).toBeGreaterThan(2000) // старый фикс
  })
})
