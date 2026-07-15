import { describe, expect, it } from 'vitest'
import { buildExport, type ExportConfig, type ExportDocument } from './build.ts'
import type { KassaOrderRow, KassaRefundRow } from './map.ts'
import { RECORD_LENGTHS } from './records.ts'

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

const cfg: ExportConfig = {
  taxId: 123456789,
  primaryId: 987654321012345,
  branchId: '',
  softwareRegistration: 0,
  softwareName: 'Kassa',
  softwareVersion: '1.1.0',
  vendorTaxId: 123456789,
  vendorName: 'Bulochka',
  businessName: 'Bulochka',
  taxYear: 2026,
  rangeStart: '20260101',
  rangeEnd: '20261231',
  processedAt: '2026-07-15T19:20:00Z',
  outputPath: '/OPENFRMT',
  archiverName: 'zip',
}

const order = (receipt: number, total: number): KassaOrderRow => ({
  receipt_number: receipt,
  doc_type: 'invoice_receipt',
  paid_at: '2026-07-15T10:00:00Z',
  customer_name: null,
  buyer_name: null,
  buyer_tax_id: null,
  subtotal: total,
  vat_rate: 18,
  vat_amount: Math.round((total * 18) / 118),
  total,
  discount_amount: 0,
  loyalty_discount: 0,
  items: [{ name: 'אספרסו', variant_name: null, unit_price: total, qty: 1, line_total: total }],
  payments: [{ method: 'cash', amount: total }],
})

const refund: KassaRefundRow = {
  refund_number: 5,
  created_at: '2026-07-15T11:00:00Z',
  amount: 1_000,
  method: 'cash',
  reason: null,
  vat_rate: 18,
  items: null,
}

const docs: ExportDocument[] = [
  { kind: 'order', row: order(1, 1_300) },
  { kind: 'order', row: order(2, 1_400) },
  { kind: 'refund', row: refund },
]

/** Обход BKMVDATA запись-за-записью: тип, номер, CRLF на месте. */
function walk(bkmvdata: Uint8Array): { type: string; number: number }[] {
  const out: { type: string; number: number }[] = []
  let offset = 0
  while (offset < bkmvdata.length) {
    const type = ascii(bkmvdata, offset, offset + 4) as keyof typeof RECORD_LENGTHS
    const length = RECORD_LENGTHS[type]
    if (!length) throw new Error(`неизвестный тип записи на смещении ${offset}: ${type}`)
    out.push({ type, number: Number(ascii(bkmvdata, offset + 4, offset + 13)) })
    expect(bkmvdata[offset + length]).toBe(0x0d)
    expect(bkmvdata[offset + length + 1]).toBe(0x0a)
    offset += length + 2
  }
  return out
}

describe('buildExport — BKMVDATA.TXT', () => {
  const result = buildExport(cfg, docs)

  it('структура: A100 → документы → Z900, сквозная нумерация без дыр', () => {
    const records = walk(result.bkmvdata)
    expect(records[0].type).toBe('A100')
    expect(records[records.length - 1].type).toBe('Z900')
    records.forEach((r, i) => expect(r.number).toBe(i + 1))
    // 2 продажи (C+D+D) + возврат (C+D+D) + рамка = 11
    expect(records).toHaveLength(11)
    expect(result.totalRecords).toBe(11)
  })

  it('порядок ленты сохранён: продажи, затем возврат 330', () => {
    const types = walk(result.bkmvdata).map((r) => r.type)
    expect(types).toEqual([
      'A100',
      'C100', 'D110', 'D120',
      'C100', 'D110', 'D120',
      'C100', 'D110', 'D120',
      'Z900',
    ])
  })

  it('счётчик Z900 включает A100 и сам Z900', () => {
    const z = result.bkmvdata.subarray(result.bkmvdata.length - RECORD_LENGTHS.Z900 - 2)
    expect(ascii(z, 45, 60)).toBe('000000000000011') // позиции 46–60
  })
})

describe('buildExport — INI.TXT и отчётность', () => {
  const result = buildExport(cfg, docs)

  it('A000 + summary на каждый встречающийся тип записи', () => {
    const expectedSize =
      RECORD_LENGTHS.A000 + 2 + 5 * (RECORD_LENGTHS.INI_SUMMARY + 2) // A100,C100,D110,D120,Z900
    expect(result.ini).toHaveLength(expectedSize)
    expect(ascii(result.ini, 0, 4)).toBe('A000')
    expect(ascii(result.ini, 9, 24)).toBe('000000000000011') // всего записей = Z900
    expect(result.recordCounts).toEqual({ A100: 1, C100: 3, D110: 3, D120: 3, Z900: 1 })
  })

  it('summary-запись C100 несёт фактическое количество', () => {
    const base = RECORD_LENGTHS.A000 + 2
    const second = result.ini.subarray(base + 21, base + 42) // вторая summary
    expect(ascii(second, 0, 4)).toBe('C100')
    expect(ascii(second, 4, 19)).toBe('000000000000003')
  })

  it('контрольный отчёт (2.6): количество и сумма по типам документов', () => {
    expect(result.controlReport).toEqual([
      { docTypeCode: 320, count: 2, totalIncVat: 2_700 },
      { docTypeCode: 330, count: 1, totalIncVat: 1_000 },
    ])
  })

  it('пустой период: только рамка и summary A100/Z900', () => {
    const empty = buildExport(cfg, [])
    const records = walk(empty.bkmvdata)
    expect(records.map((r) => r.type)).toEqual(['A100', 'Z900'])
    expect(empty.totalRecords).toBe(2)
    expect(empty.controlReport).toEqual([])
  })
})
