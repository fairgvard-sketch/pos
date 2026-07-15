/**
 * Примитивы полей Единого формата 1.31.
 *
 * Правила спецификации (см. docs/israel-compliance.md):
 * - буквенно-цифровые поля дополняются пробелами СПРАВА до ширины поля;
 * - числовые поля дополняются нулями СЛЕВА;
 * - каждая запись имеет фиксированную байтовую длину и завершается CRLF.
 *
 * Деньги приходят в целых агоротах (src/lib/money.ts); формат конкретных
 * денежных полей (знак, десятичные позиции) задаётся схемами записей на
 * следующем слое — здесь только базовые alpha/numeric и сборка записи.
 */

import { encodeIso8859_8 } from './encoding.ts'

const SPACE = 0x20
const CR = 0x0d
const LF = 0x0a

/**
 * Буквенно-цифровое поле: ISO-8859-8, обрезка до `width` БАЙТ,
 * дополнение пробелами справа.
 */
export function alpha(value: string, width: number): Uint8Array {
  if (!Number.isInteger(width) || width <= 0) throw new Error('uf_bad_width')
  const out = new Uint8Array(width).fill(SPACE)
  out.set(encodeIso8859_8(value).subarray(0, width))
  return out
}

/**
 * Числовое поле: целое неотрицательное, нули слева.
 * Переполнение ширины — ошибка: фискальное число нельзя молча обрезать.
 */
export function numeric(value: number, width: number): Uint8Array {
  if (!Number.isInteger(width) || width <= 0) throw new Error('uf_bad_width')
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('uf_bad_numeric')
  const digits = String(value)
  if (digits.length > width) throw new Error('uf_numeric_overflow')
  return encodeIso8859_8(digits.padStart(width, '0'))
}

/**
 * Знаковое число формата X9(n)V99…: символ знака `+`/`-`, затем цифры
 * с подразумеваемой десятичной точкой. Значение передаётся в минимальных
 * единицах (для денег V99 — агороты, для количества V9999 — десятитысячные).
 * Ширина поля = 1 + intDigits + decDigits.
 */
export function signedNumber(value: number, intDigits: number, decDigits: number): Uint8Array {
  if (!Number.isSafeInteger(value)) throw new Error('uf_bad_signed')
  const digits = String(Math.abs(value))
  if (digits.length > intDigits + decDigits) throw new Error('uf_signed_overflow')
  return encodeIso8859_8((value < 0 ? '-' : '+') + digits.padStart(intDigits + decDigits, '0'))
}

/** Денежное поле X9(12)V99 (15 байт). Сумма — в целых агоротах. */
export function amount15(agorot: number): Uint8Array {
  return signedNumber(agorot, 12, 2)
}

/** Дата YYYYMMDD (8 байт). Пустая — нули, как принято для числовых полей. */
export function date8(value: string | null): Uint8Array {
  if (value === null || value === '') return encodeIso8859_8('00000000')
  if (!/^\d{8}$/.test(value)) throw new Error('uf_bad_date')
  return encodeIso8859_8(value)
}

/** Время HHMM (4 байта). Пустое — нули. */
export function time4(value: string | null): Uint8Array {
  if (value === null || value === '') return encodeIso8859_8('0000')
  if (!/^\d{4}$/.test(value)) throw new Error('uf_bad_time')
  return encodeIso8859_8(value)
}

/**
 * Сборка записи: конкатенация полей, проверка фиксированной длины
 * (без CRLF, как в таблице спецификации) и добавление CRLF.
 */
export function composeRecord(expectedLength: number, fields: readonly Uint8Array[]): Uint8Array {
  const payloadLength = fields.reduce((sum, f) => sum + f.length, 0)
  if (payloadLength !== expectedLength) {
    throw new Error(`uf_record_length: ожидалось ${expectedLength}, получилось ${payloadLength}`)
  }
  const out = new Uint8Array(payloadLength + 2)
  let offset = 0
  for (const f of fields) {
    out.set(f, offset)
    offset += f.length
  }
  out[offset] = CR
  out[offset + 1] = LF
  return out
}
