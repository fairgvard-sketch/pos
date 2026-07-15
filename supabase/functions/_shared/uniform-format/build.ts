/**
 * Сборка набора Единого формата 1.31: `BKMVDATA.TXT` + `INI.TXT`
 * из уже отобранных снапшотов Kassa за период.
 *
 * Модуль чистый: случайность (`primaryId`) и момент формирования
 * (`processedAt`) передаёт вызывающий — Edge Function экспорта.
 *
 * Структура BKMVDATA: A100 (запись №1) → документы (C100/D110/D120)
 * → Z900 (последняя). Счётчик Z900 и поле A000 «всего записей»
 * включают открывающую и закрывающую записи (примечание в разделе 3).
 * INI.TXT: A000 + summary-запись на КАЖДЫЙ тип записи, встречающийся
 * в BKMVDATA (включая A100 и Z900) — раздел 2.5.б.
 *
 * Документы кладутся в порядке, переданном вызывающим (экспорт отдаёт
 * их хронологически: продажи и возвраты одной лентой по времени).
 */

import { mapRefund, mapSaleOrder, ilDateTime } from './map.ts'
import type { ExportSequence, KassaOrderRow, KassaRefundRow } from './map.ts'
import { a000, a100, iniSummary, z900 } from './records.ts'
import type { IniHeader } from './records.ts'

export interface ExportConfig {
  taxId: number
  /** Уникальный ID набора (15 цифр) — генерирует вызывающий на выгрузку. */
  primaryId: number
  /** Идентификатор филиала; '' если филиалов нет. */
  branchId: string
  /** Номер свидетельства регистрации ПО (0 до получения). */
  softwareRegistration: number
  softwareName: string
  softwareVersion: string
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
  /** Путь сохранения, который бизнес выбрал при выгрузке. */
  outputPath: string
  /** Чем будет сжат BKMVDATA (например 'zip'). */
  archiverName: string
}

/** Хронологическая лента документов периода. */
export type ExportDocument =
  | { kind: 'order'; row: KassaOrderRow }
  | { kind: 'refund'; row: KassaRefundRow }

/** Строка контрольного отчёта (раздел 2.6): тип документа → кол-во и сумма. */
export interface ControlReportRow {
  docTypeCode: number
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
  /** Данные контрольной распечатки по типам документов. */
  controlReport: ControlReportRow[]
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
  const counts: Record<string, number> = { A100: 1, C100: 0, D110: 0, D120: 0, Z900: 1 }
  const control = new Map<number, ControlReportRow>()

  for (const doc of documents) {
    const mapped =
      doc.kind === 'order' ? mapSaleOrder(doc.row, ctx, seq) : mapRefund(doc.row, ctx, seq)
    body.push(...mapped.records)
    counts.C100 += mapped.counts.C100
    counts.D110 += mapped.counts.D110
    counts.D120 += mapped.counts.D120
    const row = control.get(mapped.docTypeCode) ?? {
      docTypeCode: mapped.docTypeCode,
      count: 0,
      totalIncVat: 0,
    }
    row.count += 1
    row.totalIncVat += mapped.totalIncVat
    control.set(mapped.docTypeCode, row)
  }

  // Z900 занимает следующий номер; счётчик включает A100 и сам Z900.
  const totalRecords = seq.record // записей 1..seq.record, последняя — Z900
  const bkmvdata = concat([a100(1, identity), ...body, z900(seq.record, identity, totalRecords)])

  const processed = ilDateTime(cfg.processedAt)
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
    outputPath: cfg.outputPath,
    accountingType: 0, // кассовый модуль документов, не бухгалтерия
    batchLevel: '',
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
    controlReport: [...control.values()].sort((a, b) => a.docTypeCode - b.docTypeCode),
  }
}
