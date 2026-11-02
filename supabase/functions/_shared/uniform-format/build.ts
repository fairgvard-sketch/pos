/**
 * Сборка набора Единого формата 1.31: `BKMVDATA.TXT` + `INI.TXT`
 * из уже отобранных снапшотов Kassa за период.
 *
 * Модуль чистый: случайность (`primaryId`) и момент формирования
 * (`processedAt`) передаёт вызывающий — Edge Function экспорта.
 *
 * Структура BKMVDATA: A100 (запись №1) → документы (C100/D110/D120)
 * → карточки клиентов B110 → Z900 (последняя). Счётчик Z900 и поле A000 «всего записей»
 * включают открывающую и закрывающую записи (примечание в разделе 3).
 * INI.TXT: A000 + summary-запись на КАЖДЫЙ тип записи, встречающийся
 * в BKMVDATA (включая A100 и Z900) — раздел 2.5.б.
 *
 * Документы кладутся в порядке, переданном вызывающим (экспорт отдаёт
 * их хронологически: продажи и возвраты одной лентой по времени).
 */

import { UF_DOCUMENT_TYPES } from './document-types.ts'
import { mapRefund, mapSaleOrder, ilDateTime } from './map.ts'
import type { ExportSequence, KassaOrderRow, KassaRefundRow } from './map.ts'
import { a000, a100, b110, iniSummary, z900 } from './records.ts'
import type { IniHeader } from './records.ts'

export interface ExportConfig {
  taxId: number
  /** Уникальный ID набора (15 цифр) — генерирует вызывающий на выгрузку. */
  primaryId: number
  /** Идентификатор филиала; '' если филиалов нет. */
  branchId: string
  /**
   * Номер свидетельства регистрации ПО (8 цифр). Пока свидетельства нет —
   * `NO_REGISTRATION_CERTIFICATE`, как налоговая велит в своих API.
   */
  softwareRegistration: number
  softwareName: string
  softwareVersion: string
  /** Номер производителя ПО (поле 1009, 9 цифр) — не бизнеса-клиента. */
  vendorTaxId: number
  vendorName: string
  businessName: string
  businessStreet?: string
  businessHouse?: string
  businessCity?: string
  businessZip?: string
  taxYear: number
  rangeStart: string // YYYYMMDD
  rangeEnd: string // YYYYMMDD
  /** Момент формирования набора, ISO (UTC) — станет датой/временем по Иерусалиму. */
  processedAt: string
  /** Чем будет сжат BKMVDATA (например 'zip'). */
  archiverName: string
}

/** Хронологическая лента документов периода. */
export type ExportDocument =
  | { kind: 'order'; row: KassaOrderRow }
  | { kind: 'refund'; row: KassaRefundRow }

/** Группа מאזן בוחן для карточек клиентов (B110, поля 1405/1406). */
export const CUSTOMERS_TRIAL_BALANCE = { code: 'CUSTOMERS', name: 'לקוחות' } as const

/**
 * «Нет свидетельства регистрации» — 99999999: так налоговая просит
 * заполнять номер ПО до регистрации (Israel Invoice API v1, поле 1006).
 */
export const NO_REGISTRATION_CERTIFICATE = 99_999_999

/**
 * 15-значный уникальный ID набора (поля 1004/1103/1153, разъяснение 2):
 * случайный, свой на каждую выгрузку. Стабильно 15 знаков в пределах
 * safe integer: 1 + 7 + 7 случайных цифр.
 */
export function generatePrimaryId(): number {
  const buf = new Uint32Array(2)
  crypto.getRandomValues(buf)
  return 100_000_000_000_000 + (buf[0] % 9_000_000) * 10_000_000 + (buf[1] % 10_000_000)
}

/** Строка контрольного отчёта (раздел 2.6): тип документа → кол-во и сумма. */
export interface ControlReportRow {
  docTypeCode: number
  /** Название типа на иврите — как в приложении 1. */
  name: string
  count: number
  totalIncVat: number
}

export interface ExportResult {
  bkmvdata: Uint8Array
  ini: Uint8Array
  /** Всего записей BKMVDATA, включая A100 и Z900 (= счётчику Z900). */
  totalRecords: number
  /** Количество записей по типам — то, что ушло в summary INI.TXT. */
  recordCounts: Record<string, number>
  /**
   * Данные контрольной распечатки: ВСЕ типы приложения 1 по порядку кода,
   * невыпускаемые — нулями (раздел 2.6).
   */
  controlReport: ControlReportRow[]
  /** Путь набора по разделу 2.2: OPENFRMT\<8 цифр>.<ГГ>\<ММДДччмм>. */
  outputDir: string
}

/**
 * Путь сохранения набора (раздел 2.2): каталог OPENFRMT, в нём
 * «первые 8 цифр номера עוסק (без контрольной).две цифры года выгрузки»,
 * в нём — ММДДччмм момента выгрузки. Пишется в A000 (поле 1012).
 */
export function outputDirFor(taxId: number, processed: { date: string; time: string }): string {
  const dealer = String(taxId).padStart(9, '0').slice(0, 8)
  return `OPENFRMT\\${dealer}.${processed.date.slice(2, 4)}\\${processed.date.slice(4, 8)}${processed.time}`
}

function concat(records: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(records.reduce((s, r) => s + r.length, 0))
  let offset = 0
  for (const r of records) {
    out.set(r, offset)
    offset += r.length
  }
  return out
}

export function buildExport(cfg: ExportConfig, documents: readonly ExportDocument[]): ExportResult {
  const identity = { taxId: cfg.taxId, primaryId: cfg.primaryId }
  const ctx = { taxId: cfg.taxId, branchId: cfg.branchId }

  // A100 — запись №1; документы нумеруются дальше сквозным счётчиком.
  const seq: ExportSequence = { record: 2, doc: 1 }
  const body: Uint8Array[] = []
  const counts: Record<string, number> = { A100: 1, C100: 0, D110: 0, D120: 0, B110: 0, Z900: 1 }
  const control = new Map<number, { count: number; totalIncVat: number }>()
  const accounts = new Map<string, { name: string; taxId?: number; turnover: number }>()

  for (const doc of documents) {
    const mapped =
      doc.kind === 'order' ? mapSaleOrder(doc.row, ctx, seq) : mapRefund(doc.row, ctx, seq)
    body.push(...mapped.records)
    counts.C100 += mapped.counts.C100
    counts.D110 += mapped.counts.D110
    counts.D120 += mapped.counts.D120
    const row = control.get(mapped.docTypeCode) ?? { count: 0, totalIncVat: 0 }
    row.count += 1
    row.totalIncVat += mapped.totalIncVat
    control.set(mapped.docTypeCode, row)
    const account = accounts.get(mapped.customer.key) ?? { ...mapped.customer, turnover: 0 }
    account.turnover += mapped.totalIncVat
    accounts.set(mapped.customer.key, account)
  }

  // Карточки клиентов (B110), на которые ссылаются документы (C100 1225).
  // Документ Kassa закрывается сразу: חשבונית מס/קבלה — счёт и оплата
  // вместе, зикуй — кредит и выплата вместе. Поэтому дебет карточки равен
  // кредиту (сумма документов), а остаток на начало любого периода — ноль.
  for (const [key, account] of accounts) {
    body.push(
      b110({
        recordNumber: seq.record++,
        taxId: cfg.taxId,
        accountKey: key,
        accountName: account.name,
        trialBalanceCode: CUSTOMERS_TRIAL_BALANCE.code,
        trialBalanceName: CUSTOMERS_TRIAL_BALANCE.name,
        openingBalance: 0,
        totalDebit: account.turnover,
        totalCredit: account.turnover,
        counterpartyTaxId: account.taxId,
        branchId: cfg.branchId,
      }),
    )
    counts.B110 += 1
  }

  // Z900 занимает следующий номер; счётчик включает A100 и сам Z900.
  const totalRecords = seq.record // записей 1..seq.record, последняя — Z900
  const bkmvdata = concat([a100(1, identity), ...body, z900(seq.record, identity, totalRecords)])

  const processed = ilDateTime(cfg.processedAt)
  const outputDir = outputDirFor(cfg.taxId, processed)
  const iniHeader: IniHeader = {
    taxId: cfg.taxId,
    primaryId: cfg.primaryId,
    totalRecords,
    softwareRegistration: cfg.softwareRegistration,
    softwareName: cfg.softwareName,
    softwareVersion: cfg.softwareVersion,
    vendorTaxId: cfg.vendorTaxId,
    vendorName: cfg.vendorName,
    softwareType: 2, // רב-שנתי: Kassa хранит данные за несколько лет
    outputPath: outputDir,
    accountingType: 0, // кассовый модуль документов, не бухгалтерия
    batchLevel: 0, // обязателен только при двойной записи
    businessName: cfg.businessName,
    businessStreet: cfg.businessStreet ?? '',
    businessHouse: cfg.businessHouse ?? '',
    businessCity: cfg.businessCity ?? '',
    businessZip: cfg.businessZip ?? '',
    taxYear: cfg.taxYear,
    rangeStart: cfg.rangeStart,
    rangeEnd: cfg.rangeEnd,
    processDate: processed.date,
    processTime: processed.time,
    charset: 1, // ISO-8859-8-i
    archiverName: cfg.archiverName,
    currency: 'ILS',
    hasBranches: cfg.branchId ? 1 : 0,
  }

  const summaries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => iniSummary(code, count))
  const ini = concat([a000(iniHeader), ...summaries])

  return {
    bkmvdata,
    ini,
    totalRecords,
    recordCounts: counts,
    controlReport: UF_DOCUMENT_TYPES.map(({ code, name }) => ({
      docTypeCode: code,
      name,
      count: control.get(code)?.count ?? 0,
      totalIncVat: control.get(code)?.totalIncVat ?? 0,
    })),
    outputDir,
  }
}
