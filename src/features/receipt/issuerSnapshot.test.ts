import { describe, it, expect, beforeAll } from 'vitest'
import { renderReceiptCanvas, renderRefundReceiptCanvas } from './printCanvas'
import type { Receipt, RefundReceipt, ReceiptLine } from './api'
import type { Location } from '../../types'

/**
 * Перепечатка обязана повторять оригинал.
 *
 * До слепка (150) шапка чека собиралась из ТЕКУЩИХ настроек точки:
 * `location.receipt_business_name`, адрес и ח.פ читались в момент печати.
 * Поэтому смена реквизитов задним числом меняла содержимое уже выданных
 * документов — и повторная печать вчерашнего чека выходила с новым ח.פ.
 *
 * Здесь проверяется само обещание, а не механизм: документу дан слепок,
 * настройкам точки — ДРУГИЕ значения, и на бумагу обязан уйти слепок.
 * Плюс обратная половина: у документа без слепка (выпущен до 150, либо
 * это временный офлайн-чек) фолбэк на настройки точки сохраняется.
 */

/** Записывающий 2d-контекст: нам нужен текст, который ушёл на холст */
let printed: string[] = []

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
        if (prop === 'measureText') return () => ({ width: 10 })
        if (prop === 'fillText') {
          return (text: string) => { printed.push(String(text)) }
        }
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

/** Настройки точки СЕГОДНЯ — намеренно другие, чем в документе */
const locationNow = {
  id: 'loc-1',
  name: 'Pinsker',
  receipt_business_name: 'עסק אחר בע״מ',
  receipt_address: 'רוטשילד 15',
  receipt_tax_id: '515999999',
  receipt_phone: '03-000-0000',
  receipt_footer: null,
} as unknown as Location

const line: ReceiptLine = {
  name: 'קפוצ׳ינו',
  variant_name: null,
  qty: 1,
  unit_price: 1200,
  line_total: 1200,
  modifiers: [],
  notes: null,
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    order_id: 'o1',
    daily_number: 1,
    receipt_number: 1,
    doc_type: 'receipt',
    allocation_number: null,
    issuer_name: 'בולוצ׳קה בע״מ',
    issuer_tax_id: '515111111',
    issuer_address: 'פינסקר 29',
    buyer_name: null,
    buyer_tax_id: null,
    order_type: 'takeaway',
    customer_name: null,
    table_label: null,
    status: 'paid',
    subtotal: 1200,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    loyalty_discount: 0,
    vat_rate: 18,
    vat_amount: 183,
    total: 1200,
    tip_amount: 0,
    paid_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    staff_name: null,
    lines: [line],
    payments: [{ method: 'cash', amount: 1200, tendered: 1200, change_due: 0 }],
    ...over,
  }
}

function refund(over: Partial<RefundReceipt> = {}): RefundReceipt {
  return {
    refund_id: 'r1',
    refund_number: 3,
    amount: 500,
    method: 'cash',
    reason: null,
    items: null,
    created_at: new Date().toISOString(),
    staff_name: null,
    daily_number: 1,
    receipt_number: 1,
    doc_type: 'invoice_receipt',
    vat_rate: 18,
    vat_amount: 76,
    issuer_name: 'בולוצ׳קה בע״מ',
    issuer_tax_id: '515111111',
    issuer_address: 'פינסקר 29',
    ...over,
  }
}

describe('чек печатается из слепка эмитента, а не из текущих настроек', () => {
  it('шапка берёт название, адрес и ח.פ из документа', () => {
    printed = []
    renderReceiptCanvas(receipt(), locationNow)
    const text = printed.join('\n')

    expect(text).toContain('בולוצ׳קה בע״מ')
    expect(text).toContain('פינסקר 29')
    expect(text).toContain('ע.מ/ח.פ: 515111111')

    // Сегодняшних реквизитов на выданном документе быть не должно
    expect(text).not.toContain('עסק אחר בע״מ')
    expect(text).not.toContain('רוטשילד 15')
    expect(text).not.toContain('515999999')
  })

  it('телефон остаётся живым — это оформление, а не реквизит документа', () => {
    printed = []
    renderReceiptCanvas(receipt(), locationNow)
    expect(printed.join('\n')).toContain('03-000-0000')
  })

  it('документ без слепка печатается из настроек точки — как раньше', () => {
    // Так выглядит чек, выпущенный до 150, и временный офлайн-чек
    printed = []
    renderReceiptCanvas(
      receipt({ issuer_name: null, issuer_tax_id: null, issuer_address: null }),
      locationNow,
    )
    const text = printed.join('\n')
    expect(text).toContain('עסק אחר בע״מ')
    expect(text).toContain('ע.מ/ח.פ: 515999999')
  })

  it('зикуй печатается из своего слепка так же, как чек', () => {
    printed = []
    renderRefundReceiptCanvas(refund(), locationNow)
    const text = printed.join('\n')
    expect(text).toContain('בולוצ׳קה בע״מ')
    expect(text).toContain('ע.מ/ח.פ: 515111111')
    expect(text).not.toContain('515999999')
  })
})
