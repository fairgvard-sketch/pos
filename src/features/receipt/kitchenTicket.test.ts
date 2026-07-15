import { describe, it, expect } from 'vitest'
import { receiptToKitchenTicket, billToKitchenTicket } from './kitchenTicket'
import type { Receipt } from './api'
import type { BillLine } from '../tables/api'

/**
 * Перепечатка тикета собирается из снапшота заказа, а не из живой корзины —
 * проверяем, что маппинг сохраняет всё, что печатает renderKitchenTicketCanvas:
 * номер, тип, стол, заметки и модификаторы. Пометки «повтор» нет by design.
 */

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    order_id: 'o1',
    daily_number: 42,
    receipt_number: 7,
    doc_type: 'receipt',
    allocation_number: null,
    buyer_name: null,
    buyer_tax_id: null,
    order_type: 'takeaway',
    customer_name: 'דנה',
    table_label: null,
    status: 'paid',
    subtotal: 2400,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    loyalty_discount: 0,
    vat_rate: 18,
    vat_amount: 366,
    total: 2400,
    tip_amount: 0,
    paid_at: '2026-07-15T09:00:00Z',
    created_at: '2026-07-15T09:00:00Z',
    staff_name: 'יוסי',
    lines: [
      {
        name: 'קפוצ׳ינו',
        variant_name: 'גדול',
        qty: 2,
        unit_price: 1200,
        line_total: 2400,
        modifiers: [{ name: 'חלב שיבולת שועל', price_delta: 200 }],
        notes: 'בלי סוכר',
      },
    ],
    payments: [],
    ...over,
  }
}

describe('receiptToKitchenTicket', () => {
  it('переносит номер, тип, имена и строки со заметками', () => {
    const t = receiptToKitchenTicket(receipt(), 'קופה 1')
    expect(t.dailyNumber).toBe(42)
    expect(t.orderType).toBe('takeaway')
    expect(t.customerName).toBe('דנה')
    expect(t.staffName).toBe('יוסי')
    expect(t.deviceName).toBe('קופה 1')
    expect(t.lines).toEqual([
      {
        qty: 2,
        name: 'קפוצ׳ינו',
        variantName: 'גדול',
        modifiers: ['חלב שיבולת שועל'],
        notes: 'בלי סוכר',
      },
    ])
  })

  it('null-поля становятся пустыми строками, а не «null» на бумаге', () => {
    const t = receiptToKitchenTicket(
      receipt({
        customer_name: null,
        staff_name: null,
        lines: [
          { name: 'אספרסו', variant_name: null, qty: 1, unit_price: 800, line_total: 800, modifiers: [], notes: null },
        ],
      }),
      ''
    )
    expect(t.customerName).toBe('')
    expect(t.staffName).toBe('')
    expect(t.tableLabel).toBe('')
    expect(t.lines[0].notes).toBe('')
  })

  it('офлайн-заказ до синка печатается под локальным номером K-n', () => {
    const t = receiptToKitchenTicket(receipt({ provisional: true, provisional_number: 'K-3' }), '')
    expect(t.dailyNumber).toBe('K-3')
  })
})

describe('billToKitchenTicket', () => {
  it('открытый счёт стола → тикет с номером заказа и столом', () => {
    const lines: BillLine[] = [
      { id: 'i1', name: 'כריך', variant_name: null, qty: 1, line_total: 3200, modifiers: ['ללא בצל'], notes: 'לחלק לשניים' },
      { id: 'i2', name: 'לימונדה', variant_name: 'קטן', qty: 3, line_total: 3600, modifiers: [], notes: null },
    ]
    const t = billToKitchenTicket({ dailyNumber: 17, tableLabel: '5', staffName: 'רות', deviceName: 'קופה 2', lines })
    expect(t.dailyNumber).toBe(17)
    expect(t.orderType).toBe('here')
    expect(t.tableLabel).toBe('5')
    expect(t.lines).toEqual([
      { qty: 1, name: 'כריך', variantName: null, modifiers: ['ללא בצל'], notes: 'לחלק לשניים' },
      { qty: 3, name: 'לימונדה', variantName: 'קטן', modifiers: [], notes: '' },
    ])
  })
})
