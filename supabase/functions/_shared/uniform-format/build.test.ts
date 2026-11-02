import { describe, expect, it } from 'vitest'
import {
  NO_REGISTRATION_CERTIFICATE,
  buildExport,
  outputDirFor,
  type ExportConfig,
  type ExportDocument,
} from './build.ts'
import type { KassaOrderRow, KassaRefundRow } from './map.ts'
import { RECORD_LENGTHS } from './records.ts'
import { validateExport } from './validate.ts'

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

const cfg: ExportConfig = {
  taxId: 123456789,
  primaryId: 987654321012345,
  branchId: '',
  softwareRegistration: NO_REGISTRATION_CERTIFICATE,
  softwareName: 'Kassa',
  softwareVersion: '1.1.0',
  vendorTaxId: 123456789,
  vendorName: 'Bulochka',
  businessName: 'Bulochka',
  taxYear: 2026,
  rangeStart: '20260101',
  rangeEnd: '20261231',
  processedAt: '2026-07-15T19:20:00Z',
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
  base_receipt_number: 1,
  base_doc_type: 'invoice_receipt',
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
    // 2 продажи (C+D+D) + возврат (C+D) + карточка WALKIN (B110) + рамка = 11
    expect(records).toHaveLength(11)
    expect(result.totalRecords).toBe(11)
  })

  it('порядок ленты сохранён: продажи, возврат 330 без D120, карточки клиентов', () => {
    const types = walk(result.bkmvdata).map((r) => r.type)
    expect(types).toEqual([
      'A100',
      'C100', 'D110', 'D120',
      'C100', 'D110', 'D120',
      'C100', 'D110',
      'B110',
      'Z900',
    ])
  })

  it('B110: карточка разовых покупателей, дебет = кредит = сумма документов', () => {
    const b = result.bkmvdata.subarray(
      result.bkmvdata.length - RECORD_LENGTHS.Z900 - 2 - RECORD_LENGTHS.B110 - 2,
    )
    expect(ascii(b, 0, 4)).toBe('B110')
    expect(ascii(b, 22, 37).trimEnd()).toBe('WALKIN')
    expect(ascii(b, 277, 292)).toBe('+00000000000000') // остаток на начало
    expect(ascii(b, 292, 307)).toBe('+00000000003700') // 1 300 + 1 400 + 1 000
    expect(ascii(b, 307, 322)).toBe('+00000000003700')
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
      RECORD_LENGTHS.A000 + 2 + 6 * (RECORD_LENGTHS.INI_SUMMARY + 2) // A100,C100,D110,D120,B110,Z900
    expect(result.ini).toHaveLength(expectedSize)
    expect(ascii(result.ini, 0, 4)).toBe('A000')
    expect(ascii(result.ini, 9, 24)).toBe('000000000000011') // всего записей = Z900
    expect(result.recordCounts).toEqual({ A100: 1, C100: 3, D110: 3, D120: 2, B110: 1, Z900: 1 })
  })

  it('summary-запись C100 несёт фактическое количество', () => {
    const base = RECORD_LENGTHS.A000 + 2
    const second = result.ini.subarray(base + 21, base + 42) // вторая summary
    expect(ascii(second, 0, 4)).toBe('C100')
    expect(ascii(second, 4, 19)).toBe('000000000000003')
  })

  it('контрольный отчёт (2.6): все типы приложения 1, невыпускаемые — нулями', () => {
    expect(result.controlReport).toHaveLength(27)
    expect(result.controlReport.find((r) => r.docTypeCode === 320)).toEqual({
      docTypeCode: 320,
      name: 'חשבונית מס/קבלה',
      count: 2,
      totalIncVat: 2_700,
    })
    expect(result.controlReport.find((r) => r.docTypeCode === 330)?.count).toBe(1)
    expect(result.controlReport.find((r) => r.docTypeCode === 305)).toMatchObject({ count: 0, totalIncVat: 0 })
  })

  it('путь набора по разделу 2.2 — в результате и в A000 (поле 1012)', () => {
    expect(result.outputDir).toBe('OPENFRMT\\12345678.26\\07152220') // 19:20 UTC = 22:20 IL
    expect(ascii(result.ini, 134, 184).trimEnd()).toBe(result.outputDir)
    expect(outputDirFor(2_233_445, { date: '20070923', time: '1025' })).toBe('OPENFRMT\\00223344.07\\09231025')
  })

  it('свидетельства нет — 99999999 в поле 1006', () => {
    expect(ascii(result.ini, 56, 64)).toBe('99999999')
  })

  it('пустой период: только рамка и summary A100/Z900', () => {
    const empty = buildExport(cfg, [])
    const records = walk(empty.bkmvdata)
    expect(records.map((r) => r.type)).toEqual(['A100', 'Z900'])
    expect(empty.totalRecords).toBe(2)
    expect(empty.controlReport.every((r) => r.count === 0)).toBe(true)
  })
})

describe('buildExport → validateExport: собранный набор проходит независимую проверку', () => {
  it('продажи со скидкой, чаевыми и несколькими позициями + возвраты', () => {
    const rich: ExportDocument[] = [
      ...docs,
      {
        kind: 'order',
        row: {
          ...order(3, 0),
          subtotal: 5_300,
          total: 4_770, // скидка 10%
          vat_amount: Math.round((4_770 * 18) / 118),
          discount_amount: 530,
          items: [
            { name: 'קפוצ׳ינו', variant_name: 'גדול', unit_price: 1_600, qty: 2, line_total: 3_200 },
            { name: 'Чизкейк', variant_name: null, unit_price: 2_100, qty: 1, line_total: 2_100 },
          ],
          payments: [
            { method: 'cash', amount: 2_000 },
            { method: 'card', amount: 3_270 }, // 5 ₪ чаевых
          ],
        },
      },
      {
        kind: 'order',
        row: { ...order(4, 5_000), buyer_name: 'חברה בע"מ', buyer_tax_id: '512345678' },
      },
      {
        kind: 'refund',
        row: {
          ...refund,
          refund_number: 6,
          amount: 3_200,
          method: 'card',
          items: [{ name: 'קפוצ׳ינו גדול', qty: 2, amount: 3_200 }],
          base_receipt_number: 3,
        },
      },
    ]
    const result = buildExport(cfg, rich)
    const check = validateExport(result.ini, result.bkmvdata)
    expect(check.errors).toEqual([])
    expect(check.documentCounts).toEqual({ 320: 4, 330: 2 })
    expect(check.recordCounts.B110).toBe(2) // WALKIN + компания
  })

  it('проверка ловит ключ клиента без карточки B110', () => {
    const result = buildExport(cfg, docs)
    const data = result.bkmvdata.slice()
    const b = data.length - RECORD_LENGTHS.Z900 - 2 - RECORD_LENGTHS.B110 - 2
    data[b + 22] = 0x58 // «WALKIN» → «XALKIN» в ключе карточки
    const check = validateExport(result.ini, data)
    expect(check.errors.some((e) => e.includes('без карточки B110'))).toBe(true)
  })

  it('проверка ловит порчу: неверная константа формата и разошедшийся итог', () => {
    const result = buildExport(cfg, docs)
    const ini = result.ini.slice()
    ini[55] = 0x20 // последний символ «&OF1.31&» → пробел
    const data = result.bkmvdata.slice()
    const c100 = RECORD_LENGTHS.A100 + 2 // первая C100
    data[c100 + 361] = data[c100 + 361] === 0x30 ? 0x31 : 0x30 // 1223 ± 1 агора
    const check = validateExport(ini, data)
    expect(check.ok).toBe(false)
    expect(check.errors.some((e) => e.includes('1005'))).toBe(true)
    expect(check.errors.some((e) => e.includes('1223'))).toBe(true)
  })
})
