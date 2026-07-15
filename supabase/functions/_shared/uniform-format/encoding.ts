/**
 * Кодировка ISO-8859-8 (Windows logical Hebrew) для файлов Единого формата
 * (מבנה אחיד) 1.31 — `INI.TXT` и `BKMVDATA.TXT`.
 *
 * Спецификация допускает ISO-8859-8-i либо DOS CP862; выбран ISO-8859-8-i:
 * логический порядок символов совпадает с порядком хранения строк в JS,
 * перестановка байтов не нужна.
 *
 * Поля формата — фиксированные БАЙТОВЫЕ длины, поэтому все операции ниже
 * работают с байтами, а не с code points. Символ вне таблицы заменяется
 * на `?` — замена видима в контрольной распечатке и не ломает длину записи.
 */

const REPLACEMENT_BYTE = 0x3f // '?'

// א (U+05D0) … ת (U+05EA) → 0xE0 … 0xFA — единственный нелатинский блок,
// который нужен фискальному экспорту.
const HEBREW_FIRST = 0x05d0
const HEBREW_LAST = 0x05ea
const ISO_HEBREW_FIRST = 0xe0

/** Один code point → один байт ISO-8859-8 (или замена). */
function byteFor(codePoint: number): number {
  if (codePoint <= 0x7f) return codePoint // ASCII как есть
  if (codePoint >= HEBREW_FIRST && codePoint <= HEBREW_LAST) {
    return ISO_HEBREW_FIRST + (codePoint - HEBREW_FIRST)
  }
  return REPLACEMENT_BYTE
}

/**
 * Кодирует строку в ISO-8859-8. Каждый code point даёт ровно один байт
 * (эмодзи и прочие non-BMP символы — один `?`, а не два).
 */
export function encodeIso8859_8(text: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of text) bytes.push(byteFor(ch.codePointAt(0) as number))
  return Uint8Array.from(bytes)
}
