import { describe, expect, it } from 'vitest'
import {
  WALK_IN_CUSTOMER_KEY,
  allocate,
  ilDateTime,
  mapRefund,
  paymentsForDocument,
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

describe('allocate — раскладка без потери агоры', () => {
  it('сумма частей равна целому, остаток — по наибольшему остатку', () => {
    expect(allocate(686_441, [2_800, 807_200])).toEqual([2_373, 684_068])
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(allocate(0, [5, 5])).toEqual([0, 0])
  })
  it('нулевые веса — всё в первую строку', () => {
    expect(allocate(100, [0, 0])).toEqual([100, 0])
  })
})

describe('paymentsForDocument — чаевые вне документа', () => {
  it('излишек снимается с последних строк оплаты', () => {
    expect(
      paymentsForDocument(
        [
          { method: 'cash', amount: 1_000 },
          { method: 'card', amount: 2_500 },
        ],
        3_000,
      ),
    ).toEqual([
      { method: 'cash', amount: 1_000 },
      { method: 'card', amount: 2_000 },
    ])
  })
  it('строка, целиком ушедшая на чаевые, исчезает', () => {
    expect(
      paymentsForDocument(
        [
          { method: 'card', amount: 3_000 },
          { method: 'cash', amount: 500 },
        ],
        3_000,
      ),
    ).toEqual([{ method: 'card', amount: 3_000 }])
  })
})

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

  it('C100: суммы без НДС, скидка со знаком «−», 1219+1220=1221, 1221+1222=1223', () => {
    const rec = mapSaleOrder(order, ctx, seq()).records[0]
    expect(rec).toHaveLength(RECORD_LENGTHS.C100 + 2)
    expect(slice(rec, 23, 25)).toBe('320')
    expect(slice(rec, 26, 45).trimEnd()).toBe('1042')
    expect(slice(rec, 46, 53)).toBe('20260715')
    expect(slice(rec, 288, 302)).toBe('+00000000686441') // до скидки, без НДС
    expect(slice(rec, 303, 317)).toBe('-00000000008475') // скидка без НДС, минус
    expect(slice(rec, 318, 332)).toBe('+00000000677966') // после скидок, без НДС
    expect(slice(rec, 333, 347)).toBe('+00000000122034') // НДС
    expect(slice(rec, 348, 362)).toBe('+00000000800000') // итог
  })

  it('C100: разовый покупатель — имя и ключ клиента заполнены (обязательны для 100–710)', () => {
    const rec = mapSaleOrder(order, ctx, seq()).records[0]
    expect(slice(rec, 375, 389).trimEnd()).toBe(WALK_IN_CUSTOMER_KEY)
    expect(rec[57]).toBe(0xec) // «לקוח מזדמן» начинается с ל
  })

  it('D110: строки без НДС в сумме = 1219, количество × цена + скидка = итог', () => {
    const recs = mapSaleOrder(order, ctx, seq()).records
    expect(recs[1][93]).toBe(0xf7) // позиция 94: ק (U+05E7 → 0xF7)
    expect(slice(recs[1], 224, 240)).toBe('+0000000000020000') // 2 шт
    expect(slice(recs[1], 241, 255)).toBe('+00000000001187') // цена вверх
    expect(slice(recs[1], 256, 270)).toBe('-00000000000001') // остаток округления
    expect(slice(recs[1], 271, 285)).toBe('+00000000002373')
    expect(slice(recs[1], 286, 289)).toBe('1800')
    expect(slice(recs[2], 271, 285)).toBe('+00000000684068') // 2 373 + 684 068 = 686 441
  })

  it('D120: коды способов оплаты — наличные 1, карта 3', () => {
    const recs = mapSaleOrder(order, ctx, seq()).records
    expect(slice(recs[3], 50, 50)).toBe('1')
    expect(slice(recs[3], 104, 118)).toBe('+00000000080000')
    expect(slice(recs[4], 50, 50)).toBe('3')
    expect(slice(recs[4], 104, 118)).toBe('+00000000720000')
  })

  it('чаевые не попадают в оплаты документа: D120 = итог 1223', () => {
    const recs = mapSaleOrder(
      { ...order, payments: [{ method: 'card', amount: 810_000 }] }, // 100 ₪ чаевых
      ctx,
      seq(),
    ).records
    expect(slice(recs[3], 104, 118)).toBe('+00000000800000')
  })

  it('чек на компанию: имя, ח.פ и ключ клиента — по покупателю', () => {
    const rec = mapSaleOrder(
      { ...order, buyer_name: 'חברה בע"מ', buyer_tax_id: '51-234567-8' },
      ctx,
      seq(),
    ).records[0]
    expect(slice(rec, 253, 261)).toBe('512345678')
    expect(slice(rec, 375, 389).trimEnd()).toBe('512345678')
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
  base_receipt_number: 1042,
  base_doc_type: 'invoice_receipt',
}

describe('mapRefund', () => {
  it('возврат суммой: 330, одна строка «החזר», без строк оплаты D120', () => {
    const doc = mapRefund(refund, ctx, seq())
    expect(doc.records).toHaveLength(2) // C100 + D110: D120 у זיכוי симулятор отвергает
    expect(doc.counts).toEqual({ C100: 1, D110: 1, D120: 0 })
    expect(doc.records.map((r) => slice(r, 1, 4))).toEqual(['C100', 'D110'])
    expect(doc.docTypeCode).toBe(330)
    expect(slice(doc.records[0], 23, 25)).toBe('330')
    expect(slice(doc.records[0], 288, 302)).toBe('+00000000067797') // без НДС
    expect(slice(doc.records[0], 333, 347)).toBe('+00000000012203') // НДС из суммы
    expect(slice(doc.records[0], 348, 362)).toBe('+00000000080000')
    expect(slice(doc.records[0], 375, 389).trimEnd()).toBe(WALK_IN_CUSTOMER_KEY)
    expect(slice(doc.records[1], 271, 285)).toBe('+00000000067797')
    expect(doc.customer).toEqual({ key: WALK_IN_CUSTOMER_KEY, name: 'לקוחות מזדמנים' })
  })

  it('строки ссылаются на исходный чек как на документ-основание (разъяснение 6)', () => {
    const line = mapRefund(refund, ctx, seq()).records[1]
    expect(slice(line, 50, 52)).toBe('320')
    expect(slice(line, 53, 72).trimEnd()).toBe('1042')
  })

  it('выборка до миграции 185 (без основания) — поля основания пустые, не мусор', () => {
    const line = mapRefund(
      { ...refund, base_receipt_number: undefined, base_doc_type: undefined },
      ctx,
      seq(),
    ).records[1]
    expect(slice(line, 50, 52)).toBe('000')
    expect(slice(line, 53, 72).trim()).toBe('')
  })

  it('возврат по позициям: строка на каждую позицию снапшота', () => {
    const doc = mapRefund(
      { ...refund, amount: 2_800, items: [{ name: 'קפוצ׳ינו', qty: 2, amount: 2_800 }] },
      ctx,
      seq(),
    )
    expect(doc.counts.D110).toBe(1)
    expect(slice(doc.records[1], 224, 240)).toBe('+0000000000020000')
    expect(slice(doc.records[1], 271, 285)).toBe('+00000000002373')
  })

  it('покупатель возврата — тот же, что в исходном чеке', () => {
    const rec = mapRefund(
      { ...refund, buyer_name: 'חברה בע"מ', buyer_tax_id: '512345678' },
      ctx,
      seq(),
    ).records[0]
    expect(slice(rec, 253, 261)).toBe('512345678')
  })
})

describe('клиент документа — для карточки B110', () => {
  it('чек на компанию — карточка по ח.פ, разовый покупатель — общая карточка', () => {
    expect(
      mapSaleOrder({ ...order, buyer_name: 'חברה בע"מ', buyer_tax_id: '512345678' }, ctx, seq()).customer,
    ).toEqual({ key: '512345678', name: 'חברה בע"מ', taxId: 512345678 })
    // имя у стойки («Маша») карточкой не становится
    expect(mapSaleOrder({ ...order, customer_name: 'Маша' }, ctx, seq()).customer.key).toBe(
      WALK_IN_CUSTOMER_KEY,
    )
  })
})
