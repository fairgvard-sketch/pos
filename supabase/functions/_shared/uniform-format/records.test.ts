import { describe, expect, it } from 'vitest'
import { amount15, date8, signedNumber, time4 } from './fields.ts'
import {
  RECORD_LENGTHS,
  a000,
  a100,
  c100,
  d110,
  d120,
  iniSummary,
  z900,
  type DocumentHeader,
  type DocumentLine,
  type IniHeader,
  type PaymentLine,
} from './records.ts'

/** Срез по позициям спецификации (1-based, включительно) как ASCII-строка. */
const slice = (rec: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...rec.subarray(from - 1, to))

const identity = { taxId: 123456789, primaryId: 987654321012345 }

describe('примитивы: знаковые суммы и даты', () => {
  it('amount15: агороты с ведущим знаком и подразумеваемой запятой', () => {
    expect(String.fromCharCode(...amount15(600_000))).toBe('+00000000600000') // 6 000 ₪
    expect(String.fromCharCode(...amount15(-1_550))).toBe('-00000000001550') // −15,50 ₪
    expect(amount15(0)[0]).toBe(0x2b) // '+'
  })

  it('signedNumber: переполнение — ошибка', () => {
    expect(() => signedNumber(10 ** 15, 12, 2)).toThrow('uf_signed_overflow')
  })

  it('date8/time4: валидация формата, пустое — нули', () => {
    expect(String.fromCharCode(...date8('20260715'))).toBe('20260715')
    expect(String.fromCharCode(...date8(null))).toBe('00000000')
    expect(() => date8('2026-07-15')).toThrow('uf_bad_date')
    expect(String.fromCharCode(...time4('2143'))).toBe('2143')
    expect(() => time4('21:43')).toThrow('uf_bad_time')
  })
})

describe('служебные записи', () => {
  it('A100: длина, код, константа формата на 38–45', () => {
    const rec = a100(1, identity)
    expect(rec).toHaveLength(RECORD_LENGTHS.A100 + 2)
    expect(slice(rec, 1, 4)).toBe('A100')
    expect(slice(rec, 5, 13)).toBe('000000001')
    expect(slice(rec, 14, 22)).toBe('123456789')
    expect(slice(rec, 23, 37)).toBe('987654321012345')
    expect(slice(rec, 38, 45)).toBe('&OF1.31 ')
  })

  it('Z900: счётчик всех записей на 46–60', () => {
    const rec = z900(2042, identity, 2042)
    expect(rec).toHaveLength(RECORD_LENGTHS.Z900 + 2)
    expect(slice(rec, 1, 4)).toBe('Z900')
    expect(slice(rec, 46, 60)).toBe('000000000002042')
  })

  it('INI summary: код записи + количество', () => {
    const rec = iniSummary('C100', 512)
    expect(rec).toHaveLength(RECORD_LENGTHS.INI_SUMMARY + 2)
    expect(slice(rec, 1, 4)).toBe('C100')
    expect(slice(rec, 5, 19)).toBe('000000000000512')
  })
})

const docHeader: DocumentHeader = {
  recordNumber: 2,
  taxId: identity.taxId,
  docType: 320, // קבלה
  docNumber: '1042',
  docDate: '20260715',
  docTime: '2143',
  customerName: 'לקוח מזדמן',
  valueDate: '20260715',
  amountBeforeDiscount: 800_000, // 8 000 ₪ в агоротах
  documentDiscount: 0,
  amountExVat: 677_966,
  vatAmount: 122_034,
  amountIncVat: 800_000,
  customerKey: 'walkin',
  printDate: '20260715',
  branchId: '1',
  linkId: 42,
}

describe('C100 — заголовок документа', () => {
  it('длина и ключевые позиции', () => {
    const rec = c100(docHeader)
    expect(rec).toHaveLength(RECORD_LENGTHS.C100 + 2)
    expect(slice(rec, 1, 4)).toBe('C100')
    expect(slice(rec, 23, 25)).toBe('320')
    expect(slice(rec, 26, 45)).toBe('1042                ')
    expect(slice(rec, 46, 53)).toBe('20260715')
    expect(slice(rec, 54, 57)).toBe('2143')
    expect(slice(rec, 288, 302)).toBe('+00000000800000') // до скидки
    expect(slice(rec, 333, 347)).toBe('+00000000122034') // НДС
    expect(slice(rec, 348, 362)).toBe('+00000000800000') // с НДС
    expect(slice(rec, 363, 374)).toBe('+00000000000') // удержание X9(9)V99
    expect(slice(rec, 400, 400)).toBe(' ') // не отменён
    expect(slice(rec, 425, 431)).toBe('0000042') // link id
  })

  it('отменённый документ — «1» на позиции 400', () => {
    const rec = c100({ ...docHeader, isCanceled: true })
    expect(slice(rec, 400, 400)).toBe('1')
  })

  it('иврит в имени клиента кодируется однобайтово (позиция 58 = ל)', () => {
    const rec = c100(docHeader)
    expect(rec[57]).toBe(0xec) // ל = U+05DC → 0xE0 + 12 = 0xEC
  })
})

describe('D110 — строка документа', () => {
  const line: DocumentLine = {
    recordNumber: 3,
    taxId: identity.taxId,
    docType: 320,
    docNumber: '1042',
    lineNumber: 1,
    description: 'קפוצ׳ינו קטן',
    unitDescription: 'יחידה',
    quantity: 2_0000, // 2 шт в V9999
    unitPriceExVat: 1_186, // 11,86 ₪ без НДС
    lineDiscount: 0,
    lineTotal: 2_372,
    vatPercent: 1800, // 18,00 %
    branchId: '1',
    docDate: '20260715',
    linkId: 42,
  }

  it('длина, количество X9(12)V9999 и ставка НДС', () => {
    const rec = d110(line)
    expect(rec).toHaveLength(RECORD_LENGTHS.D110 + 2)
    expect(slice(rec, 1, 4)).toBe('D110')
    expect(slice(rec, 46, 49)).toBe('0001')
    expect(slice(rec, 224, 240)).toBe('+0000000000020000') // 2,0000 шт
    expect(slice(rec, 241, 255)).toBe('+00000000001186')
    expect(slice(rec, 286, 289)).toBe('1800')
    expect(slice(rec, 305, 311)).toBe('0000042')
  })
})

describe('D120 — строка оплаты', () => {
  const cash: PaymentLine = {
    recordNumber: 4,
    taxId: identity.taxId,
    docType: 320,
    docNumber: '1042',
    lineNumber: 1,
    paymentMethod: 1, // מזומן
    amount: 80_000,
    branchId: '1',
    docDate: '20260715',
    linkId: 42,
  }

  it('наличные: способ на позиции 50, сумма на 104–118', () => {
    const rec = d120(cash)
    expect(rec).toHaveLength(RECORD_LENGTHS.D120 + 2)
    expect(slice(rec, 50, 50)).toBe('1')
    expect(slice(rec, 51, 60)).toBe('0000000000') // банк — только для чеков
    expect(slice(rec, 104, 118)).toBe('+00000000080000')
  })

  it('карта: компания и тип операции', () => {
    const rec = d120({ ...cash, paymentMethod: 3, cardCompany: 2, cardTransactionType: 1 })
    expect(slice(rec, 50, 50)).toBe('3')
    expect(slice(rec, 119, 119)).toBe('2')
    expect(slice(rec, 140, 140)).toBe('1')
  })
})

describe('A000 — ведущая запись INI.TXT', () => {
  const ini: IniHeader = {
    ...identity,
    totalRecords: 2042,
    softwareRegistration: 12345678,
    softwareName: 'Kassa',
    softwareVersion: '1.1.0',
    vendorTaxId: 123456789,
    vendorName: 'Bulochka',
    softwareType: 2,
    outputPath: 'C:\\OPENFRMT',
    accountingType: 1,
    batchLevel: '',
    businessName: 'Bulochka',
    businessStreet: '',
    businessHouse: '',
    businessCity: '',
    businessZip: '',
    taxYear: 2026,
    rangeStart: '20260101',
    rangeEnd: '20261231',
    processDate: '20260715',
    processTime: '2143',
    charset: 1,
    archiverName: 'zip',
    currency: 'ILS',
    hasBranches: 0,
  }

  it('длина и ключевые позиции', () => {
    const rec = a000(ini)
    expect(rec).toHaveLength(RECORD_LENGTHS.A000 + 2)
    expect(slice(rec, 1, 4)).toBe('A000')
    expect(slice(rec, 10, 24)).toBe('000000000002042')
    expect(slice(rec, 49, 56)).toBe('&OF1.31 ')
    expect(slice(rec, 363, 366)).toBe('2026')
    expect(slice(rec, 395, 395)).toBe('0') // иврит
    expect(slice(rec, 396, 396)).toBe('1') // ISO-8859-8-i
    expect(slice(rec, 417, 419)).toBe('ILS')
  })
})
