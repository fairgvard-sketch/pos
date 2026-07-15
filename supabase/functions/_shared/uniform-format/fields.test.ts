import { describe, expect, it } from 'vitest'
import { encodeIso8859_8 } from './encoding.ts'
import { alpha, composeRecord, numeric } from './fields.ts'

const bytes = (arr: Uint8Array) => Array.from(arr)

describe('encodeIso8859_8', () => {
  it('ASCII проходит как есть', () => {
    expect(bytes(encodeIso8859_8('A9 z'))).toEqual([0x41, 0x39, 0x20, 0x7a])
  })

  it('иврит попадает в 0xE0–0xFA (א=E0, ת=FA)', () => {
    expect(bytes(encodeIso8859_8('אבת'))).toEqual([0xe0, 0xe1, 0xfa])
  })

  it('символ вне таблицы — один байт «?», включая эмодзи и ₪', () => {
    expect(bytes(encodeIso8859_8('₪'))).toEqual([0x3f])
    expect(bytes(encodeIso8859_8('☕'))).toEqual([0x3f]) // non-BMP → один байт, не два
    expect(encodeIso8859_8('a☕b')).toHaveLength(3)
  })
})

describe('alpha', () => {
  it('дополняет пробелами справа до ширины', () => {
    expect(bytes(alpha('אב', 4))).toEqual([0xe0, 0xe1, 0x20, 0x20])
  })

  it('обрезает по байтам, длина всегда равна ширине', () => {
    expect(alpha('אבגדה', 3)).toHaveLength(3)
    expect(bytes(alpha('אבגדה', 3))).toEqual([0xe0, 0xe1, 0xe2])
  })

  it('пустая строка — поле из пробелов', () => {
    expect(bytes(alpha('', 2))).toEqual([0x20, 0x20])
  })
})

describe('numeric', () => {
  it('дополняет нулями слева', () => {
    expect(bytes(numeric(42, 5))).toEqual([0x30, 0x30, 0x30, 0x34, 0x32])
  })

  it('переполнение ширины — ошибка, а не обрезка', () => {
    expect(() => numeric(123456, 5)).toThrow('uf_numeric_overflow')
  })

  it('отрицательные и нецелые — ошибка', () => {
    expect(() => numeric(-1, 5)).toThrow('uf_bad_numeric')
    expect(() => numeric(1.5, 5)).toThrow('uf_bad_numeric')
  })

  it('ноль занимает всю ширину нулями', () => {
    expect(bytes(numeric(0, 3))).toEqual([0x30, 0x30, 0x30])
  })
})

describe('composeRecord', () => {
  it('склеивает поля и добавляет CRLF после фиксированной длины', () => {
    const rec = composeRecord(5, [alpha('אב', 3), numeric(7, 2)])
    expect(rec).toHaveLength(7) // 5 + CRLF
    expect(bytes(rec)).toEqual([0xe0, 0xe1, 0x20, 0x30, 0x37, 0x0d, 0x0a])
  })

  it('несовпадение суммарной длины полей — ошибка', () => {
    expect(() => composeRecord(4, [alpha('x', 3), numeric(1, 2)])).toThrow('uf_record_length')
  })
})
