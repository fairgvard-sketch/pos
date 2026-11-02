/**
 * Независимая проверка готового набора Единого формата 1.31.
 *
 * Читает БАЙТЫ `INI.TXT` и `BKMVDATA.TXT` и сверяет их со спецификацией,
 * не пользуясь кодом сборки: позиции и правила записаны здесь заново по
 * таблицам разделов 3–4 и разъяснениям приложения 5. Назначение — поймать
 * до официального симулятора всё, что он отверг бы, и держать это
 * регрессионным тестом.
 *
 * Помимо правил спецификации проверяются тождества, которые выгрузка
 * Kassa гарантирует (1219 = сумма строк, D120 = итог документа, возврат
 * ссылается на исходный чек) — их нарушение означает ошибку в маппинге.
 *
 * Правила, которых нет в тексте спецификации, но которые применяет
 * официальный симулятор (прогон 02.11.2026), записаны здесь же:
 * D120 привязывается только к квитанциям, ключ клиента документа обязан
 * иметь карточку счёта B110.
 */

import { UF_DOCUMENT_TYPES } from './document-types.ts'

const LENGTHS: Record<string, number> = {
  A000: 466,
  A100: 95,
  B100: 317,
  B110: 376,
  C100: 444,
  D110: 339,
  D120: 222,
  M100: 298,
  Z900: 110,
}
const SUMMARY_LENGTH = 19
const FORMAT_CONST = '&OF1.31&'
const DOC_TYPE_CODES = new Set(UF_DOCUMENT_TYPES.map((t) => t.code))
/**
 * Документы, к которым симулятор привязывает D120 («פרטי קבלה/הפקדה»):
 * квитанции и депозит. У прочих (в т.ч. зикуя 330) D120 — «без заголовка».
 */
const RECEIPT_DOC_TYPES = new Set([320, 400, 405, 420])

export interface ValidationResult {
  ok: boolean
  errors: string[]
  recordCounts: Record<string, number>
  documentCounts: Record<number, number>
}

interface Rec {
  code: string
  bytes: Uint8Array
  /** № строки в файле, 1-based — для сообщений. */
  line: number
}

/** Поле по позициям спецификации (1-based, включительно), байты как latin1. */
function f(rec: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from - 1; i < to; i++) s += String.fromCharCode(rec[i])
  return s
}

const isDigits = (s: string) => /^\d+$/.test(s)
const isSigned = (s: string) => /^[+-]\d+$/.test(s)
const signed = (s: string) => (s[0] === '-' ? -1 : 1) * Number(s.slice(1))

function isDate(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6))
  const d = Number(s.slice(6, 8))
  const date = new Date(Date.UTC(y, m - 1, d))
  return y >= 1900 && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

const isTime = (s: string) =>
  /^\d{4}$/.test(s) && Number(s.slice(0, 2)) < 24 && Number(s.slice(2, 4)) < 60

/** Разбор файла на записи по CRLF с проверкой длины по коду записи. */
function split(
  file: Uint8Array,
  name: string,
  lengthOf: (code: string, index: number) => number | undefined,
  errors: string[],
): Rec[] {
  const out: Rec[] = []
  let offset = 0
  let line = 1
  while (offset < file.length) {
    const code = f(file.subarray(offset, offset + 4), 1, 4)
    const length = lengthOf(code, out.length)
    if (length === undefined) {
      errors.push(`${name}:${line}: неизвестный код записи «${code}»`)
      return out
    }
    if (file[offset + length] !== 0x0d || file[offset + length + 1] !== 0x0a) {
      errors.push(`${name}:${line}: ${code} — нет CRLF сразу после ${length} байт`)
      return out
    }
    const bytes = file.subarray(offset, offset + length)
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      const allowed = (b >= 0x20 && b <= 0x7e) || (b >= 0xe0 && b <= 0xfa)
      if (!allowed) {
        errors.push(`${name}:${line}: ${code} — байт 0x${b.toString(16)} в позиции ${i + 1} вне ISO-8859-8`)
        break
      }
    }
    out.push({ code, bytes, line })
    offset += length + 2
    line += 1
  }
  return out
}

function requireDigits(errors: string[], where: string, rec: Uint8Array, fields: [number, number, string][]) {
  for (const [from, to, label] of fields) {
    if (!isDigits(f(rec, from, to))) errors.push(`${where}: поле ${label} (${from}–${to}) не числовое`)
  }
}

function requireText(errors: string[], where: string, rec: Uint8Array, fields: [number, number, string][]) {
  for (const [from, to, label] of fields) {
    if (f(rec, from, to).trim() === '') errors.push(`${where}: обязательное поле ${label} (${from}–${to}) пустое`)
  }
}

function requireSigned(errors: string[], where: string, rec: Uint8Array, fields: [number, number, string][]) {
  for (const [from, to, label] of fields) {
    if (!isSigned(f(rec, from, to))) errors.push(`${where}: поле ${label} (${from}–${to}) не в формате ±цифры`)
  }
}

interface DocState {
  type: number
  number: string
  date: string
  link: string
  where: string
  c100: Uint8Array
  lines: number
  d120: number
  linesTotal: number
  paymentsTotal: number
  hasBase: boolean
}

export function validateExport(ini: Uint8Array, bkmvdata: Uint8Array): ValidationResult {
  const errors: string[] = []

  // ── INI.TXT ───────────────────────────────────────────────────
  const iniRecs = split(ini, 'INI.TXT', (code, i) => (i === 0 ? LENGTHS[code] : SUMMARY_LENGTH), errors)
  const a000 = iniRecs[0]
  if (!a000 || a000.code !== 'A000') {
    errors.push('INI.TXT: первая запись должна быть A000')
    return { ok: false, errors, recordCounts: {}, documentCounts: {} }
  }
  const h = a000.bytes
  const W = 'INI.TXT:A000'
  requireDigits(errors, W, h, [
    [10, 24, '1002 всего записей'], [25, 33, '1003 עוסק'], [34, 48, '1004 ID набора'],
    [57, 64, '1006 свидетельство ПО'], [105, 113, '1009 производитель'], [134, 134, '1011 тип ПО'],
    [185, 185, '1013 тип бухучёта'], [186, 186, '1014 баланс'], [187, 195, '1015 ח"פ'],
    [196, 204, '1016 תיק ניכויים'], [363, 366, '1023 налоговый год'], [367, 374, '1024 начало'],
    [375, 382, '1025 конец'], [383, 390, '1026 дата выгрузки'], [391, 394, '1027 время'],
    [395, 395, '1028 язык'], [396, 396, '1029 кодировка'], [420, 420, '1034 филиалы'],
  ])
  requireText(errors, W, h, [
    [65, 84, '1007 название ПО'], [85, 104, '1008 версия ПО'], [114, 133, '1010 производитель'],
    [135, 184, '1012 путь'], [215, 264, '1018 название бизнеса'], [397, 416, '1030 архиватор'],
    [417, 419, '1032 валюта'],
  ])
  if (f(h, 49, 56) !== FORMAT_CONST) errors.push(`${W}: поле 1005 должно быть «${FORMAT_CONST}», а не «${f(h, 49, 56)}»`)
  if (Number(f(h, 25, 33)) === 0) errors.push(`${W}: номер עוסק (1003) нулевой`)
  if (Number(f(h, 57, 64)) === 0) errors.push(`${W}: номер свидетельства ПО (1006) нулевой`)
  if (Number(f(h, 105, 113)) === 0) errors.push(`${W}: номер производителя ПО (1009) нулевой`)
  const softwareType = f(h, 134, 134)
  if (softwareType === '2') {
    if (!isDate(f(h, 367, 374)) || !isDate(f(h, 375, 382))) errors.push(`${W}: многолетнее ПО — нужен диапазон дат 1024/1025`)
    else if (f(h, 367, 374) > f(h, 375, 382)) errors.push(`${W}: начало диапазона позже конца`)
  } else if (softwareType === '1') {
    if (Number(f(h, 363, 366)) < 1900) errors.push(`${W}: однолетнее ПО — нужен налоговый год 1023`)
  } else errors.push(`${W}: тип ПО (1011) должен быть 1 или 2`)
  const accounting = f(h, 185, 185)
  if (!['0', '1', '2'].includes(accounting)) errors.push(`${W}: тип бухучёта (1013) должен быть 0/1/2`)
  if (accounting === '2' && !['1', '2'].includes(f(h, 186, 186))) errors.push(`${W}: при двойной записи 1014 обязателен`)
  if (!isDate(f(h, 383, 390)) || !isTime(f(h, 391, 394))) errors.push(`${W}: дата/время выгрузки (1026/1027) некорректны`)
  if (!['0', '1', '2'].includes(f(h, 395, 395))) errors.push(`${W}: код языка (1028) должен быть 0/1/2`)
  if (!['1', '2'].includes(f(h, 396, 396))) errors.push(`${W}: кодировка (1029) должна быть 1/2`)
  const hasBranches = f(h, 420, 420) === '1'
  if (!['0', '1'].includes(f(h, 420, 420))) errors.push(`${W}: признак филиалов (1034) должен быть 0/1`)

  const taxId = f(h, 25, 33)
  const primaryId = f(h, 34, 48)
  const rangeStart = f(h, 367, 374)
  const rangeEnd = f(h, 375, 382)

  const summaries = new Map<string, number>()
  for (const r of iniRecs.slice(1)) {
    const code = f(r.bytes, 1, 4)
    const count = f(r.bytes, 5, 19)
    if (!(code in LENGTHS) || code === 'A000') errors.push(`INI.TXT:${r.line}: summary для неизвестного кода «${code}»`)
    if (!isDigits(count)) errors.push(`INI.TXT:${r.line}: количество в summary ${code} не числовое`)
    if (summaries.has(code)) errors.push(`INI.TXT:${r.line}: повтор summary ${code}`)
    summaries.set(code, Number(count))
  }

  // ── BKMVDATA.TXT ─────────────────────────────────────────────
  const recs = split(bkmvdata, 'BKMVDATA.TXT', (code) => (code === 'A000' ? undefined : LENGTHS[code]), errors)
  const recordCounts: Record<string, number> = {}
  for (const r of recs) recordCounts[r.code] = (recordCounts[r.code] ?? 0) + 1

  if (recs[0]?.code !== 'A100') errors.push('BKMVDATA.TXT: первая запись должна быть A100')
  if (recs[recs.length - 1]?.code !== 'Z900') errors.push('BKMVDATA.TXT: последняя запись должна быть Z900')
  if ((recordCounts.A100 ?? 0) !== 1 || (recordCounts.Z900 ?? 0) !== 1) errors.push('BKMVDATA.TXT: ровно одна A100 и одна Z900')

  recs.forEach((r, i) => {
    const where = `BKMVDATA.TXT:${r.line}:${r.code}`
    if (f(r.bytes, 5, 13) !== String(i + 1).padStart(9, '0')) errors.push(`${where}: номер записи ${f(r.bytes, 5, 13)} вместо ${i + 1}`)
    if (f(r.bytes, 14, 22) !== taxId) errors.push(`${where}: номер עוסק не совпадает с INI`)
  })

  for (const r of recs.filter((x) => x.code === 'A100' || x.code === 'Z900')) {
    const where = `BKMVDATA.TXT:${r.line}:${r.code}`
    if (f(r.bytes, 23, 37) !== primaryId) errors.push(`${where}: ID набора не совпадает с INI (1004)`)
    if (f(r.bytes, 38, 45) !== FORMAT_CONST) errors.push(`${where}: константа формата «${f(r.bytes, 38, 45)}» вместо «${FORMAT_CONST}»`)
    if (r.code === 'Z900' && Number(f(r.bytes, 46, 60)) !== recs.length) errors.push(`${where}: всего записей ${Number(f(r.bytes, 46, 60))}, а в файле ${recs.length}`)
  }
  if (Number(f(h, 10, 24)) !== recs.length) errors.push(`${W}: всего записей ${Number(f(h, 10, 24))}, а в BKMVDATA ${recs.length}`)

  for (const [code, count] of Object.entries(recordCounts)) {
    if (summaries.get(code) !== count) errors.push(`INI.TXT: summary ${code} = ${summaries.get(code) ?? 'нет'}, в BKMVDATA ${count}`)
  }
  for (const code of summaries.keys()) {
    if (!(code in recordCounts)) errors.push(`INI.TXT: summary ${code} есть, а записей такого типа нет`)
  }

  // ── Документы ────────────────────────────────────────────────
  const documentCounts: Record<number, number> = {}
  const seen = new Set<string>()
  const customerKeys = new Map<string, string>() // ключ → где впервые встречен
  const accountKeys = new Set<string>()
  let doc: DocState | null = null

  const closeDoc = () => {
    if (!doc) return
    const c = doc.c100
    const beforeDiscount = signed(f(c, 288, 302))
    const total = signed(f(c, 348, 362))
    if (doc.lines > 0 && doc.linesTotal !== beforeDiscount) {
      errors.push(`${doc.where}: сумма строк D110 ${doc.linesTotal} ≠ 1219 «до скидки» ${beforeDiscount}`)
    }
    if (RECEIPT_DOC_TYPES.has(doc.type)) {
      if (total > 0 && doc.d120 === 0) errors.push(`${doc.where}: документ ${doc.type} без строк оплаты D120`)
      if (doc.d120 > 0 && doc.paymentsTotal !== total) errors.push(`${doc.where}: оплаты D120 ${doc.paymentsTotal} ≠ итог 1223 ${total}`)
    } else if (doc.d120 > 0) {
      errors.push(`${doc.where}: строки D120 у документа ${doc.type} — симулятор привязывает их только к квитанциям`)
    }
    if (doc.type === 330 && !doc.hasBase) errors.push(`${doc.where}: возврат без документа-основания (D110 1256/1257)`)
    doc = null
  }

  const belongs = (r: Rec, where: string): DocState | null => {
    if (!doc) {
      errors.push(`${where}: строка без предшествующего C100`)
      return null
    }
    if (Number(f(r.bytes, 23, 25)) !== doc.type || f(r.bytes, 26, 45) !== doc.number) {
      errors.push(`${where}: тип/номер документа не совпадают с заголовком ${doc.type}/${doc.number.trim()}`)
    }
    return doc
  }

  for (const r of recs) {
    const b = r.bytes
    const where = `BKMVDATA.TXT:${r.line}:${r.code}`
    if (r.code === 'C100') {
      closeDoc()
      requireDigits(errors, where, b, [[23, 25, '1203 тип'], [253, 261, '1215 ח.פ клиента'], [425, 431, '1234 связь']])
      requireSigned(errors, where, b, [
        [270, 284, '1217'], [288, 302, '1219'], [303, 317, '1220'], [318, 332, '1221'],
        [333, 347, '1222'], [348, 362, '1223'], [363, 374, '1224'],
      ])
      requireText(errors, where, b, [[26, 45, '1204 номер документа']])
      const type = Number(f(b, 23, 25))
      if (!DOC_TYPE_CODES.has(type)) errors.push(`${where}: тип документа ${f(b, 23, 25)} вне приложения 1`)
      if (type >= 100 && type <= 710) requireText(errors, where, b, [[58, 107, '1207 имя клиента'], [375, 389, '1225 ключ клиента']])
      if (!isDate(f(b, 46, 53))) errors.push(`${where}: дата выпуска (1205) некорректна`)
      if (f(b, 54, 57) !== '0000' && !isTime(f(b, 54, 57))) errors.push(`${where}: время выпуска (1206) некорректно`)
      if (f(b, 262, 269) !== '00000000' && !isDate(f(b, 262, 269))) errors.push(`${where}: дата ערך (1216) некорректна`)
      if (!isDate(f(b, 401, 408))) errors.push(`${where}: дата документа (1230) некорректна`)
      else if (softwareType === '2' && (f(b, 401, 408) < rangeStart || f(b, 401, 408) > rangeEnd)) {
        errors.push(`${where}: дата документа ${f(b, 401, 408)} вне диапазона выгрузки`)
      }
      if (hasBranches && f(b, 409, 415).trim() === '') errors.push(`${where}: при филиалах нужен идентификатор (1231)`)
      if ([288, 303, 318, 333, 348].every((p) => isSigned(f(b, p, p + 14)))) {
        const a1219 = signed(f(b, 288, 302))
        const a1220 = signed(f(b, 303, 317))
        const a1221 = signed(f(b, 318, 332))
        const a1222 = signed(f(b, 333, 347))
        const a1223 = signed(f(b, 348, 362))
        if (a1220 > 0) errors.push(`${where}: скидка документа (1220) положительна — по разъяснению 5 она со знаком «−»`)
        if (a1219 < 0 || a1221 < 0 || a1222 < 0 || a1223 < 0) errors.push(`${where}: суммы документа должны быть положительны (2.4.יב)`)
        if (a1219 + a1220 !== a1221) errors.push(`${where}: 1219 ${a1219} + 1220 ${a1220} ≠ 1221 ${a1221}`)
        if (a1221 + a1222 !== a1223) errors.push(`${where}: 1221 ${a1221} + 1222 ${a1222} ≠ 1223 ${a1223}`)
      }
      if (type >= 100 && type <= 710 && f(b, 375, 389).trim() !== '' && !customerKeys.has(f(b, 375, 389))) {
        customerKeys.set(f(b, 375, 389), where)
      }
      const key = `${type}/${f(b, 26, 45)}`
      if (seen.has(key)) errors.push(`${where}: документ ${type}/${f(b, 26, 45).trim()} повторяется`)
      seen.add(key)
      documentCounts[type] = (documentCounts[type] ?? 0) + 1
      doc = {
        type, number: f(b, 26, 45), date: f(b, 401, 408), link: f(b, 425, 431), where, c100: b,
        lines: 0, d120: 0, linesTotal: 0, paymentsTotal: 0, hasBase: false,
      }
    } else if (r.code === 'D110') {
      requireDigits(errors, where, b, [[46, 49, '1255 строка'], [50, 52, '1256 тип основания'], [73, 73, '1258'], [286, 289, '1268 НДС'], [305, 311, '1273 связь']])
      requireSigned(errors, where, b, [[224, 240, '1264 количество'], [241, 255, '1265 цена'], [256, 270, '1266 скидка'], [271, 285, '1267 итог']])
      requireText(errors, where, b, [[94, 123, '1260 описание']])
      const d = belongs(r, where)
      if (!d) continue
      d.lines += 1
      if (Number(f(b, 46, 49)) !== d.lines) errors.push(`${where}: номер строки ${Number(f(b, 46, 49))} вместо ${d.lines}`)
      if (f(b, 297, 304) !== d.date) errors.push(`${where}: дата строки (1272) ≠ дата документа (1230)`)
      if (Number(f(b, 305, 311)) !== Number(d.link)) errors.push(`${where}: связь с заголовком (1273) ≠ 1234`)
      const baseType = Number(f(b, 50, 52))
      const baseNumber = f(b, 53, 72).trim()
      if ((baseType === 0) !== (baseNumber === '')) errors.push(`${where}: документ-основание заполнен наполовину (1256/1257)`)
      if (baseType !== 0) {
        if (!DOC_TYPE_CODES.has(baseType)) errors.push(`${where}: тип основания ${baseType} вне приложения 1`)
        d.hasBase = true
      }
      if ([224, 241, 256, 271].every((p) => isSigned(f(b, p, p + (p === 224 ? 16 : 14))))) {
        const qty = BigInt(signed(f(b, 224, 240)))
        const price = BigInt(signed(f(b, 241, 255)))
        const discount = BigInt(signed(f(b, 256, 270)))
        const total = signed(f(b, 271, 285))
        // количество V9999 × цена V99 + скидка V99 = итог V99
        if (qty * price + discount * 10_000n !== BigInt(total) * 10_000n) {
          errors.push(`${where}: количество × цена + скидка ≠ итог строки (1267)`)
        }
        if (discount > 0n) errors.push(`${where}: скидка строки (1266) положительна — она со знаком «−»`)
        d.linesTotal += total
      }
    } else if (r.code === 'D120') {
      requireDigits(errors, where, b, [[46, 49, '1305 строка'], [50, 50, '1306 способ'], [51, 60, '1307'], [61, 70, '1308'], [71, 85, '1309'], [86, 95, '1310'], [96, 103, '1311'], [119, 119, '1313'], [140, 140, '1315'], [156, 162, '1323 связь']])
      requireSigned(errors, where, b, [[104, 118, '1312 сумма']])
      const d = belongs(r, where)
      if (!d) continue
      d.d120 += 1
      if (Number(f(b, 46, 49)) !== d.d120) errors.push(`${where}: номер строки оплаты ${Number(f(b, 46, 49))} вместо ${d.d120}`)
      const method = Number(f(b, 50, 50))
      if (method < 1 || method > 9) errors.push(`${where}: способ оплаты (1306) вне 1–9`)
      if (method === 2 && [51, 61, 71, 86].some((p) => Number(f(b, p, p + 9)) === 0)) errors.push(`${where}: чек (המחאה) без реквизитов банка`)
      if (f(b, 148, 155) !== d.date) errors.push(`${where}: дата строки (1322) ≠ дата документа (1230)`)
      if (Number(f(b, 156, 162)) !== Number(d.link)) errors.push(`${where}: связь с заголовком (1323) ≠ 1234`)
      if (isSigned(f(b, 104, 118))) d.paymentsTotal += signed(f(b, 104, 118))
    } else if (r.code === 'B110') {
      closeDoc()
      requireDigits(errors, where, b, [[323, 326, '1417'], [327, 335, '1419 ח.פ клиента']])
      requireText(errors, where, b, [[23, 37, '1403 ключ счёта'], [38, 87, '1404 название'], [88, 102, '1405 код מאזן בוחן'], [103, 132, '1406 описание кода']])
      requireSigned(errors, where, b, [[278, 292, '1414 остаток'], [293, 307, '1415 дебет'], [308, 322, '1416 кредит'], [343, 357, '1422']])
      if (accountKeys.has(f(b, 23, 37))) errors.push(`${where}: ключ счёта «${f(b, 23, 37).trim()}» повторяется (1403 уникален)`)
      accountKeys.add(f(b, 23, 37))
      if (hasBranches && f(b, 336, 342).trim() === '') errors.push(`${where}: при филиалах нужен идентификатор (1421)`)
    } else if (r.code !== 'A100' && r.code !== 'Z900') {
      closeDoc()
    }
  }
  closeDoc()

  if (customerKeys.size > 0 && accountKeys.size === 0) {
    errors.push('BKMVDATA.TXT: нет ни одной карточки счёта B110 — симулятор требует их для ключей клиентов (C100 1225)')
  }
  for (const [key, where] of customerKeys) {
    if (accountKeys.size > 0 && !accountKeys.has(key)) errors.push(`${where}: ключ клиента «${key.trim()}» без карточки B110`)
  }

  return { ok: errors.length === 0, errors, recordCounts, documentCounts }
}
