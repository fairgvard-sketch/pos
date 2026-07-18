import { describe, it, expect } from 'vitest'
import { transactionsToCsv } from './exportCsv'
import type { Transaction } from './api'

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    daily_number: 42,
    receipt_number: 1042,
    total: 3600,
    status: 'paid',
    paid_at: new Date(2026, 6, 18, 12, 30).toISOString(),
    created_at: new Date(2026, 6, 18, 12, 0).toISOString(),
    customer_name: 'דניאל',
    table_label: null,
    staff: { name: 'קיריל' },
    payments: [{ method: 'cash', amount: 3600 }],
    ...over,
  }
}

describe('transactionsToCsv', () => {
  it('BOM + шапка + строка с суммой в шекелях', () => {
    const csv = transactionsToCsv([tx()])
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('תאריך')
    expect(lines[1]).toContain('36.00')
    expect(lines[1]).toContain('1042')
    expect(lines[1]).toContain('קיריל')
  })

  it('запятая/кавычки в имени экранируются', () => {
    const csv = transactionsToCsv([tx({ customer_name: 'ООО "Рога", копыта' })])
    expect(csv).toContain('"ООО ""Рога"", копыта"')
  })

  it('возвращённая сумма — отдельной колонкой', () => {
    const csv = transactionsToCsv([
      tx({ payments: [{ method: 'card', amount: 3600 }, { method: 'card', amount: -1200 }] }),
    ])
    expect(csv).toContain('12.00')
  })
})
