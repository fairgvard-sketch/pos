import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import {
  renderReceiptCanvas,
  renderRefundReceiptCanvas,
  renderKitchenTicketCanvas,
  renderZReportCanvas,
  renderTestPrintCanvas,
  renderQrFlyerCanvas,
  type ZReportData,
} from './printCanvas'
import { useDeviceStore } from '../../store/deviceStore'
import type { Receipt, RefundReceipt } from './api'

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

function baseRefund(itemCount: number): RefundReceipt {
  return {
    refund_id: 'r1',
    refund_number: 7,
    amount: 1600 * itemCount,
    method: 'cash',
    reason: null,
    items: itemCount > 0
      ? Array.from({ length: itemCount }, (_, i) => ({ name: `פריט ${i}`, qty: 2, amount: 3200 }))
      : null,
    created_at: new Date().toISOString(),
    staff_name: 'קיריל',
    daily_number: 5,
    receipt_number: 42,
    doc_type: 'invoice_receipt',
    vat_rate: 18,
    vat_amount: Math.round(1600 * itemCount * 18 / 118),
  }
}

describe('renderRefundReceiptCanvas — высота по контенту', () => {
  it('возврат суммой (без позиций) рендерится', () => {
    const c = renderRefundReceiptCanvas(baseRefund(0), undefined)
    expect(c.width).toBe(576)
    expect(c.height).toBeGreaterThan(0)
    expect(c.height).toBeLessThan(1200)
  })

  it('длинный возврат выше короткого (таблица позиций растит холст)', () => {
    const short = renderRefundReceiptCanvas(baseRefund(1), undefined)
    const long = renderRefundReceiptCanvas(baseRefund(100), undefined)
    expect(long.height).toBeGreaterThan(short.height)
  })
})

describe('renderKitchenTicketCanvas — высота по контенту', () => {
  it('длинный тикет выше короткого', () => {
    const mk = (n: number) => ({
      dailyNumber: 1,
      orderType: 'takeaway' as const,
      tableLabel: '',
      customerName: '',
      staffName: 'קיריל',
      deviceName: 'SUNMI',
      lines: Array.from({ length: n }, (_, i) => ({
        name: `פריט ${i}`,
        variantName: null,
        qty: 1,
        modifiers: [],
        notes: '',
      })),
    })
    const short = renderKitchenTicketCanvas(mk(2))
    const long = renderKitchenTicketCanvas(mk(100))
    expect(long.height).toBeGreaterThan(short.height)
    expect(long.height).toBeGreaterThan(2000) // старый фикс
  })
})

// ── Ширина ленты 58/80 мм ─────────────────────────────────

function baseZ(): ZReportData {
  return {
    zNumber: 3,
    openedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    staffName: 'קיריל',
    ordersCount: 10,
    grossCash: 10000,
    grossCard: 20000,
    grossWallets: [{ method: 'bit', amount: 5000 }],
    refundsTotal: 0,
    netTotal: 35000,
    vatTotal: 5340,
    tipsTotal: 0,
    openingFloat: 20000,
    cashIn: 0,
    cashOut: 0,
    expectedCash: 30000,
    countedCash: 30000,
    cashDiff: 0,
  }
}

describe('ширина ленты 58/80 мм', () => {
  afterEach(() => {
    useDeviceStore.setState({ tapeWidth: 80 })
  })

  it('каждый тип документа рендерится в 384px на 58мм и 576px на 80мм', () => {
    expect(renderReceiptCanvas(baseReceipt(3), undefined, { tape: 58 }).width).toBe(384)
    expect(renderReceiptCanvas(baseReceipt(3), undefined, { tape: 80 }).width).toBe(576)
    expect(renderRefundReceiptCanvas(baseRefund(2), undefined, { tape: 58 }).width).toBe(384)
    expect(renderRefundReceiptCanvas(baseRefund(2), undefined, { tape: 80 }).width).toBe(576)
    expect(renderZReportCanvas(baseZ(), undefined, 58).width).toBe(384)
    expect(renderZReportCanvas(baseZ(), undefined, 80).width).toBe(576)
    expect(renderTestPrintCanvas('עסק', 'SUNMI', 58).width).toBe(384)
    expect(renderTestPrintCanvas('עסק', 'SUNMI', 80).width).toBe(576)
    const mkTicket = {
      dailyNumber: 1,
      orderType: 'takeaway' as const,
      tableLabel: '',
      customerName: '',
      staffName: '',
      deviceName: '',
      lines: [{ name: 'קפה', variantName: null, qty: 1, modifiers: [], notes: '' }],
    }
    expect(renderKitchenTicketCanvas(mkTicket, 58).width).toBe(384)
    expect(renderKitchenTicketCanvas(mkTicket, 80).width).toBe(576)
    const qr = document.createElement('canvas')
    expect(renderQrFlyerCanvas('עסק', qr, 'סרקו', 58).width).toBe(384)
    expect(renderQrFlyerCanvas('עסק', qr, 'סרקו', 80).width).toBe(576)
  })

  it('без явного параметра ширина берётся из настройки устройства', () => {
    useDeviceStore.setState({ tapeWidth: 58 })
    expect(renderReceiptCanvas(baseReceipt(1), undefined).width).toBe(384)
    expect(renderZReportCanvas(baseZ(), undefined).width).toBe(384)
    useDeviceStore.setState({ tapeWidth: 80 })
    expect(renderReceiptCanvas(baseReceipt(1), undefined).width).toBe(576)
  })

  it('QR-флаер на 58мм ужимает QR, но оставляет его почти во всю ленту', () => {
    const qr = document.createElement('canvas')
    const narrow = renderQrFlyerCanvas('עסק', qr, 'סרקו', 58)
    const wide = renderQrFlyerCanvas('עסק', qr, 'סרקו', 80)
    // 384 − 84 = 300px QR + подпись; на 80мм — прежние 400px
    expect(narrow.height).toBe(520)
    expect(wide.height).toBe(620)
  })

  it('длинный чек на 58мм не обрезается (высота растёт с позициями)', () => {
    const short = renderReceiptCanvas(baseReceipt(2), undefined, { tape: 58 })
    const long = renderReceiptCanvas(baseReceipt(200), undefined, { tape: 58 })
    expect(long.height).toBeGreaterThan(short.height)
    expect(long.height).toBeGreaterThan(3000)
    expect(long.height).toBeLessThanOrEqual(20000)
  })
})
