/**
 * Схемы записей Единого формата 1.31 — ядро кассовой системы:
 * `INI.TXT` (A000 + summary) и документные записи `BKMVDATA.TXT`
 * (A100, C100, D110, D120, Z900).
 *
 * Позиции и длины полей сверены с официальным PDF спецификации
 * (Service_Pages_Income_tax_horaot-131.pdf, разделы 3–4); каждая схема
 * дополнительно проверена контрольной суммой длин полей против таблицы
 * длин записей (раздел 2.5). Бухгалтерские B100/B110 и складская M100
 * добавляются после решения о классификации ПО при регистрации.
 *
 * Кодовые списки (типы документов, способы оплаты, компании карт) —
 * из приложений спецификации; перед прогоном официального симулятора
 * сверить фактические значения по приложению ещё раз.
 */

import { alpha, amount15, composeRecord, date8, numeric, signedNumber, time4 } from './fields.ts'

/** Константа формата в служебных записях. */
const FORMAT_CONST = '&OF1.31'

/** Фиксированные длины записей (без CRLF) из раздела 2.5 спецификации. */
export const RECORD_LENGTHS = {
  A000: 466,
  INI_SUMMARY: 19,
  A100: 95,
  C100: 444,
  D110: 339,
  D120: 222,
  Z900: 110,
} as const

/** Общая шапка служебных записей BKMVDATA. */
export interface SetIdentity {
  /** Номер осек-морше бизнеса, 9 цифр. */
  taxId: number
  /** Постоянный уникальный идентификатор набора (генерируется на выгрузку). */
  primaryId: number
}

// ---------------------------------------------------------------- INI.TXT

export interface IniHeader extends SetIdentity {
  /** Всего записей в BKMVDATA.TXT, включая A100 и Z900 (= полю в Z900). */
  totalRecords: number
  /** Номер свидетельства регистрации ПО в налоговой (8 цифр). */
  softwareRegistration: number
  softwareName: string // X(20)
  softwareVersion: string // X(20)
  /** ח"פ производителя ПО. */
  vendorTaxId: number
  vendorName: string // X(20)
  /** Тип ПО: 1 = חד-שנתי, 2 = רב-שנתי. */
  softwareType: 1 | 2
  /** Путь сохранения набора файлов. */
  outputPath: string // X(50)
  /** Тип бухучёта: 0 = не релевантно, 1 = одинарная, 2 = двойная. */
  accountingType: 0 | 1 | 2
  /** Требуемая точность записей («רמת המנה»); обязательна при двойной. */
  batchLevel: string // X(1)
  businessName: string // X(50)
  businessStreet: string // X(50)
  businessHouse: string // X(10)
  businessCity: string // X(30)
  businessZip: string // X(8)
  /** Налоговый год (обязателен по типу ПО) либо период выгрузки. */
  taxYear: number // 9(4)
  rangeStart: string // YYYYMMDD
  rangeEnd: string // YYYYMMDD
  processDate: string // YYYYMMDD
  processTime: string // HHMM
  /** Кодировка: 1 = ISO-8859-8-i, 2 = CP-862. Kassa пишет 1. */
  charset: 1 | 2
  /** Название ПО, которым сжат BKMVDATA. */
  archiverName: string // X(20)
  /** Код валюты по умолчанию (ILS). */
  currency: string // X(3)
  /** Есть ли филиалы: 0/1. */
  hasBranches: 0 | 1
}

/** Ведущая запись INI.TXT (A000, 466 байт). */
export function a000(h: IniHeader): Uint8Array {
  return composeRecord(RECORD_LENGTHS.A000, [
    alpha('A000', 4), //                1–4    код записи
    alpha('', 5), //                    5–9    резерв
    numeric(h.totalRecords, 15), //     10–24  всего записей BKMVDATA (= Z900)
    numeric(h.taxId, 9), //             25–33  осек-морше
    numeric(h.primaryId, 15), //        34–48  уникальный ID набора
    alpha(FORMAT_CONST, 8), //          49–56  константа формата
    numeric(h.softwareRegistration, 8), // 57–64 свидетельство регистрации ПО
    alpha(h.softwareName, 20), //       65–84
    alpha(h.softwareVersion, 20), //    85–104
    numeric(h.vendorTaxId, 9), //       105–113
    alpha(h.vendorName, 20), //         114–133
    numeric(h.softwareType, 1), //      134
    alpha(h.outputPath, 50), //         135–184
    numeric(h.accountingType, 1), //    185
    alpha(h.batchLevel, 1), //          186
    alpha('', 9), //                    187–195 ח"פ компании (не заполняем)
    alpha('', 9), //                    196–204 ID представителя (не заполняем)
    alpha('', 10), //                   205–214 резервное поле
    alpha(h.businessName, 50), //       215–264
    alpha(h.businessStreet, 50), //     265–314
    alpha(h.businessHouse, 10), //      315–324
    alpha(h.businessCity, 30), //       325–354
    alpha(h.businessZip, 8), //         355–362
    numeric(h.taxYear, 4), //           363–366
    date8(h.rangeStart), //             367–374
    date8(h.rangeEnd), //               375–382
    date8(h.processDate), //            383–390
    time4(h.processTime), //            391–394
    numeric(0, 1), //                   395    язык: 0 = иврит
    numeric(h.charset, 1), //           396    кодировка
    alpha(h.archiverName, 20), //       397–416
    alpha(h.currency, 3), //            417–419
    numeric(h.hasBranches, 1), //       420
    alpha('', 46), //                   421–466 резерв
  ])
}

/** Summary-запись INI.TXT (19 байт): код записи + количество в BKMVDATA. */
export function iniSummary(recordCode: string, count: number): Uint8Array {
  return composeRecord(RECORD_LENGTHS.INI_SUMMARY, [
    alpha(recordCode, 4), //  1–4
    numeric(count, 15), //    5–19
  ])
}

// ------------------------------------------------------------ BKMVDATA.TXT

/** Открывающая запись BKMVDATA (A100, 95 байт). */
export function a100(recordNumber: number, id: SetIdentity): Uint8Array {
  return composeRecord(RECORD_LENGTHS.A100, [
    alpha('A100', 4), //           1–4
    numeric(recordNumber, 9), //   5–13
    numeric(id.taxId, 9), //       14–22
    numeric(id.primaryId, 15), //  23–37
    alpha(FORMAT_CONST, 8), //     38–45
    alpha('', 50), //              46–95 резерв
  ])
}

/** Закрывающая запись BKMVDATA (Z900, 110 байт). */
export function z900(recordNumber: number, id: SetIdentity, totalRecords: number): Uint8Array {
  return composeRecord(RECORD_LENGTHS.Z900, [
    alpha('Z900', 4), //           1–4
    numeric(recordNumber, 9), //   5–13
    numeric(id.taxId, 9), //       14–22
    numeric(id.primaryId, 15), //  23–37
    alpha(FORMAT_CONST, 8), //     38–45
    numeric(totalRecords, 15), //  46–60 все записи, включая A100 и Z900
    alpha('', 50), //              61–110 резерв
  ])
}

/** Заголовок документа (C100, 444 байта). Все суммы — целые агороты. */
export interface DocumentHeader {
  recordNumber: number
  taxId: number
  /** Тип документа по приложению спецификации (напр. 320 קבלה, 330 חשבונית מס קבלה). */
  docType: number // 9(3)
  docNumber: string // X(20)
  docDate: string // YYYYMMDD — дата создания документа
  docTime: string // HHMM
  customerName: string // X(50); обязательно для диапазона кодов документов
  customerStreet?: string
  customerHouse?: string
  customerCity?: string
  customerZip?: string
  customerCountry?: string
  customerCountryCode?: string // X(2) по таблице стран
  customerPhone?: string
  customerTaxId?: number // 9(9)
  /** Дата операции (תאריך ערך). */
  valueDate: string // YYYYMMDD
  /** Сумма в валюте — только для экспортных счетов. */
  foreignAmount?: number
  currencyCode?: string // X(3), только для экспортных счетов
  /** Сумма документа до скидки документа. */
  amountBeforeDiscount: number
  /** Скидка на документ. */
  documentDiscount: number
  /** После скидок, без НДС. */
  amountExVat: number
  vatAmount: number
  /** Итог с НДС (в קבלה — сумма без удержания у источника). */
  amountIncVat: number
  /** Удержание у источника (X9(9)V99, 12 байт). */
  withholdingAmount?: number
  /** Ключ клиента в системе продавца; обязателен для диапазона кодов. */
  customerKey: string // X(15)
  matchField?: string // X(10)
  /** Документ отменён. */
  isCanceled?: boolean // X(1): 1/пусто
  /** Дата печати документа. */
  printDate: string // YYYYMMDD
  branchId: string // X(7); обязателен при наличии филиалов
  username?: string // X(9)
  /** Внутренний номер связи заголовка со строками. */
  linkId: number // 9(7)
}

export function c100(d: DocumentHeader): Uint8Array {
  return composeRecord(RECORD_LENGTHS.C100, [
    alpha('C100', 4), //                          1–4
    numeric(d.recordNumber, 9), //                5–13
    numeric(d.taxId, 9), //                       14–22
    numeric(d.docType, 3), //                     23–25
    alpha(d.docNumber, 20), //                    26–45
    date8(d.docDate), //                          46–53
    time4(d.docTime), //                          54–57
    alpha(d.customerName, 50), //                 58–107
    alpha(d.customerStreet ?? '', 50), //         108–157
    alpha(d.customerHouse ?? '', 10), //          158–167
    alpha(d.customerCity ?? '', 30), //           168–197
    alpha(d.customerZip ?? '', 8), //             198–205
    alpha(d.customerCountry ?? '', 30), //        206–235
    alpha(d.customerCountryCode ?? '', 2), //     236–237
    alpha(d.customerPhone ?? '', 15), //          238–252
    numeric(d.customerTaxId ?? 0, 9), //          253–261
    date8(d.valueDate), //                        262–269
    amount15(d.foreignAmount ?? 0), //            270–284 только экспорт
    alpha(d.currencyCode ?? '', 3), //            285–287
    amount15(d.amountBeforeDiscount), //          288–302
    amount15(d.documentDiscount), //              303–317
    amount15(d.amountExVat), //                   318–332
    amount15(d.vatAmount), //                     333–347
    amount15(d.amountIncVat), //                  348–362
    signedNumber(d.withholdingAmount ?? 0, 9, 2), // 363–374
    alpha(d.customerKey, 15), //                  375–389
    alpha(d.matchField ?? '', 10), //             390–399
    alpha(d.isCanceled ? '1' : '', 1), //         400
    date8(d.printDate), //                        401–408
    alpha(d.branchId, 7), //                      409–415
    alpha(d.username ?? '', 9), //                416–424
    numeric(d.linkId, 7), //                      425–431
    alpha('', 13), //                             432–444 резерв
  ])
}

/** Строка документа (D110, 339 байт). */
export interface DocumentLine {
  recordNumber: number
  taxId: number
  docType: number
  docNumber: string
  lineNumber: number // 9(4)
  /** Базовый документ (если строка основана на другом документе). */
  baseDocType?: number // 9(3)
  baseDocNumber?: string // X(20)
  /** Признак операции (9(1), по приложению). */
  transactionType?: number
  /** Внутренний артикул (מק"ט). */
  catalogId?: string // X(20)
  description: string // X(30) — товар или услуга
  manufacturerName?: string // X(50), для товаров из приложения ג
  serialNumber?: string // X(30), для товаров из приложения ג
  /** Единица измерения; для штук пишется слово «יחידה». */
  unitDescription: string // X(20)
  /** Количество в десятитысячных (X9(12)V9999): 1 шт = 10000. */
  quantity: number
  /** Цена единицы без НДС, агороты. */
  unitPriceExVat: number
  /** Скидка строки, агороты. */
  lineDiscount: number
  /** Итог строки: количество × цена − скидка, без НДС, агороты. */
  lineTotal: number
  /** Ставка НДС в сотых долях процента (18% = 1800). */
  vatPercent: number // 9(2)V99, 4 байта
  branchId: string // X(7)
  docDate: string // YYYYMMDD
  linkId: number // 9(7)
  /** Филиал базового документа (обязателен при наличии филиалов и базы). */
  baseBranchId?: string // X(7)
}

export function d110(l: DocumentLine): Uint8Array {
  return composeRecord(RECORD_LENGTHS.D110, [
    alpha('D110', 4), //                        1–4
    numeric(l.recordNumber, 9), //              5–13
    numeric(l.taxId, 9), //                     14–22
    numeric(l.docType, 3), //                   23–25
    alpha(l.docNumber, 20), //                  26–45
    numeric(l.lineNumber, 4), //                46–49
    numeric(l.baseDocType ?? 0, 3), //          50–52
    alpha(l.baseDocNumber ?? '', 20), //        53–72
    numeric(l.transactionType ?? 0, 1), //      73
    alpha(l.catalogId ?? '', 20), //            74–93
    alpha(l.description, 30), //                94–123
    alpha(l.manufacturerName ?? '', 50), //     124–173
    alpha(l.serialNumber ?? '', 30), //         174–203
    alpha(l.unitDescription, 20), //            204–223
    signedNumber(l.quantity, 12, 4), //         224–240 X9(12)V9999
    amount15(l.unitPriceExVat), //              241–255
    amount15(l.lineDiscount), //                256–270
    amount15(l.lineTotal), //                   271–285
    numeric(l.vatPercent, 4), //                286–289
    alpha(l.branchId, 7), //                    290–296
    date8(l.docDate), //                        297–304
    numeric(l.linkId, 7), //                    305–311
    alpha(l.baseBranchId ?? '', 7), //          312–318
    alpha('', 21), //                           319–339 резерв
  ])
}

/** Строка оплаты в квитанции/депозите (D120, 222 байта). */
export interface PaymentLine {
  recordNumber: number
  taxId: number
  docType: number
  docNumber: string
  lineNumber: number // 9(4)
  /** Способ оплаты по приложению: 1 מזומן, 2 המחאה, 3 כרטיס אשראי, 4 העברה בנקאית… */
  paymentMethod: number // 9(1)
  /** Реквизиты чека (המחאה) — только для способа 2. */
  bankId?: number // 9(10)
  bankBranchId?: number // 9(10)
  bankAccount?: number // 9(15)
  checkNumber?: number // 9(10)
  checkDueDate?: string // YYYYMMDD
  /** Сумма строки оплаты, агороты. */
  amount: number
  /** Компания карты (9(1) по приложению) — только для способа 3. */
  cardCompany?: number
  cardName?: string // X(20)
  /** Тип карточной операции (9(1) по приложению). */
  cardTransactionType?: number
  branchId: string // X(7)
  docDate: string // YYYYMMDD
  linkId: number // 9(7)
}

export function d120(p: PaymentLine): Uint8Array {
  return composeRecord(RECORD_LENGTHS.D120, [
    alpha('D120', 4), //                        1–4
    numeric(p.recordNumber, 9), //              5–13
    numeric(p.taxId, 9), //                     14–22
    numeric(p.docType, 3), //                   23–25
    alpha(p.docNumber, 20), //                  26–45
    numeric(p.lineNumber, 4), //                46–49
    numeric(p.paymentMethod, 1), //             50
    numeric(p.bankId ?? 0, 10), //              51–60
    numeric(p.bankBranchId ?? 0, 10), //        61–70
    numeric(p.bankAccount ?? 0, 15), //         71–85
    numeric(p.checkNumber ?? 0, 10), //         86–95
    date8(p.checkDueDate ?? null), //           96–103
    amount15(p.amount), //                      104–118
    numeric(p.cardCompany ?? 0, 1), //          119
    alpha(p.cardName ?? '', 20), //             120–139
    numeric(p.cardTransactionType ?? 0, 1), //  140
    alpha(p.branchId, 7), //                    141–147
    date8(p.docDate), //                        148–155
    numeric(p.linkId, 7), //                    156–162
    alpha('', 60), //                           163–222 резерв
  ])
}
