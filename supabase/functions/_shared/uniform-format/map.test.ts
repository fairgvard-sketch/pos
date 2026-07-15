import { describe, expect, it } from 'vitest'
import {
  ilDateTime,
  mapRefund,
  mapSaleOrder,
  vatInside,
  type ExportSequence,
  type KassaOrderRow,
  type KassaRefundRow,
} from './map.ts'
import { RECORD_LENGTHS } from './records.ts'

const slice = (rec: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...rec.subarray(from - 1, to))

const ctx = { taxId: 123456789, branchId: '' }
const seq = (): ExportSequence => ({ record: 2, doc: 1 }) // 1 занята A100

describe('vatInside — формула сервера (009)', () => {
  it('совпадает с ROUND(total*rate/(100+rate))', () => {
    expect(vatInside(800_000, 18)).toBe(122_034) // как чек 8 000 ₪ на экране
    expect(vatInside(0, 18)).toBe(0)
    expect(vatInside(118, 18)).toBe(18)
  })
})

describe('ilDateTime — фискальная дата по Иерусалиму', () => {
  it('лето: UTC+3', () => {
    expect(ilDateTime('2026-07-15T18:43:00Z')).toEqual({ date: '20260715', time: '2143' })
  })
  it('переход суток: вечер UTC — уже завтра в Израиле', () => {
    expect(ilDateTime('2026-07-15T21:30:00Z')).toEqual({ date: '20260716', time: '0030' })
  })
  it('зима: UTC+2', () => {
    expect(ilDateTime('2026-01-15T20:00:00Z')).toEqual({ date: '20260115', time: '2200' })
  })
})

const order: KassaOrderRow = {
  receipt_number: 1042,
  doc_type: 'invoice_receipt',
  paid_at: '2026-07-15T18:43:00Z',
  customer_name: null,
  buyer_name: null,
  buyer_tax_id: null,
  subtotal: 810_000, // 8 100 ₪ позиции
  vat_rate: 18,
  vat_amount: 122_034,
  total: 800_000, // после скидки 100 ₪
  discount_amount: 10_000,
  loyalty_discount: 0,
  items: [
    { name: 'קפוצ׳ינו', variant_name: 'קטן', unit_price: 1_400, qty: 2, line_total: 2_800 },
    { name: 'פריט חופשי', variant_name: null, unit_price: 807_200, qty: 1, line_total: 807_200 },
  ],
  payments: [
    { method: 'cash', amount: 80_000 },
    { method: 'card', amount: 720_000 },
  ],
}

describe('mapSaleOrder', () => {
  it('C100 + D110 на позицию + D120 на оплату, сквозные номера записей', () => {
    const s = seq()
    const doc = mapSaleOrder(order, ctx, s)
    expect(doc.records).toHaveLength(5)
    expect(doc.counts).toEqual({ C100: 1, D110: 2, D120: 2 })
    expect(s.record).toBe(7) // 2..6 израсходованы
    // порядковые номера в записях
    expect(slice(doc.records[0], 5, 13)).toBe('000000002')
    expect(slice(doc.records[4], 5, 13)).toBe('000000006')
  })

  it('C100: тип 320, суммы согласованы (без НДС + НДС = итог)', () => {
    const rec = mapSaleOrder(order, ctx, seq()).records[0]
    expect(rec).toHaveLength(RECORD_LENGTHS.C100 + 2)
    expect(slice(rec, 23, 25)).toBe('320')
    expect(slice(rec, 26, 45).trimEnd()).toBe('1042')
    expect(slice(rec, 46, 53)).toBe('20260715')
    expect(slice(rec, 288, 302)).toBe('+00000000810000') // до скидки
    expect(slice(rec, 303, 317)).toBe('+00000000010000') // скидка
    expect(slice(rec, 318, 332)).toBe('+00000000677966') // без НДС
    expect(slice(rec, 333, 347)).toBe('+00000000122034') // НДС
    expect(slice(rec, 348, 362)).toBe('+00000000800000') // итог
  })

  it('D110: имя с вариантом, цена и итог строки без НДС, количество V9999', () => {
    const rec = mapSaleOrder(order, ctx, seq()).records[1]
    expect(rec[93]).toBe(0xf7) // позиция 94: ק (U+05E7 → 0xF7)
    expect(slice(rec, 224, 240)).toBe('+0000000000020000') // 2 шт
    expect(slice(rec, 241, 255)).toBe('+00000000001186') // 14 ₪ без НДС
    expect(slice(rec, 271, 285)).toBe('+00000000002373') // 28 ₪ без НДС
    expect(slice(rec, 286, 289)).toBe('1800')
  })

  it('D120: коды способов оплаты — наличные 1, карта 3', () => {
    const recs = mapSaleOrder(order, ctx, seq()).records
    expect(slice(recs[3], 50, 50)).toBe('1')
    expect(slice(recs[3], 104, 118)).toBe('+00000000080000')
    expect(slice(recs[4], 50, 50)).toBe('3')
    expect(slice(recs[4], 104, 118)).toBe('+00000000720000')
  })

  it('чек на компанию: имя и ИНН покупателя уходят в C100', () => {
    const rec = mapSaleOrder(
      { ...order, buyer_name: 'חברה בע"מ', buyer_tax_id: '512345678' },
      ctx,
      seq(),
    ).records[0]
    expect(slice(rec, 253, 261)).toBe('512345678')
  })

  it('без номера чека — ошибка, а не пустой документ', () => {
    expect(() => mapSaleOrder({ ...order, receipt_number: 0 }, ctx, seq())).toThrow(
      'uf_missing_receipt_number',
    )
  })
})

const refund: KassaRefundRow = {
  refund_number: 77,
  created_at: '2026-07-15T19:00:00Z',
  amount: 80_000,
  method: 'cash',
  reason: 'ошибочная операция',
  vat_rate: 18,
  items: null,
}

describe('mapRefund', () => {
  it('возврат суммой: 330, одна строка «החזר», выплата наличными', () => {
    const doc = mapRefund(refund, ctx, seq())
    expect(doc.records).toHaveLength(3)
    expect(doc.docTypeCode).toBe(330)
    expect(slice(doc.records[0], 23, 25)).toBe('330')
    expect(slice(doc.records[0], 348, 362)).toBe('+00000000080000')
    // НДС выделен из суммы возврата
    expect(slice(doc.records[0], 333, 347)).toBe('+00000000012203')
    expect(slice(doc.records[2], 50, 50)).toBe('1')
  })

  it('возврат по позициям: строка на каждую позицию снапшота', () => {
    const doc = mapRefund(
      { ...refund, items: [{ name: 'קפוצ׳ינו', qty: 2, amount: 2_800 }] },
      ctx,
      seq(),
    )
    expect(doc.counts.D110).toBe(1)
    expect(slice(doc.records[1], 224, 240)).toBe('+0000000000020000')
    expect(slice(doc.records[1], 271, 285)).toBe('+00000000002373')
  })
})
