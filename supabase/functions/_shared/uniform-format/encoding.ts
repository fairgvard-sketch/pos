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
 *
 * До кодирования текст приводится к тому, что таблица умеет передать:
 * герэш/гершаим/макаф иврита — их ASCII-двойниками (קפוצ׳ינו → קפוצ'ינו),
 * огласовки и знаки кантилляции убираются, типографские кавычки и тире
 * становятся прямыми, кириллица транслитерируется латиницей — иначе
 * русское название позиции ушло бы в налоговую строкой «?????».
 */

const REPLACEMENT_BYTE = 0x3f // '?'

// א (U+05D0) … ת (U+05EA) → 0xE0 … 0xFA — единственный нелатинский блок,
// который нужен фискальному экспорту.
const HEBREW_FIRST = 0x05d0
const HEBREW_LAST = 0x05ea
const ISO_HEBREW_FIRST = 0xe0

/** Знаки, у которых в ISO-8859-8 нет места, но есть однозначный двойник. */
const SUBSTITUTES: Record<string, string> = {
  '׳': "'", // ׳ герэш
  '״': '"', // ״ гершаим
  '־': '-', // ־ макаф
  ' ': ' ', // неразрывный пробел
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '₪': 'ש"ח', // ₪
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Огласовки и кантилляция иврита (U+0591–U+05C7, кроме макафа). */
const HEBREW_MARKS = /[֑-ֽֿ-ׇ]/g

function transliterate(ch: string): string | undefined {
  const lower = ch.toLowerCase()
  const latin = CYRILLIC[lower]
  if (latin === undefined) return undefined
  return ch === lower || latin === '' ? latin : latin[0].toUpperCase() + latin.slice(1)
}

/** Приводит текст к символам, которые ISO-8859-8 передаёт без потерь. */
export function normalizeForIso8859_8(text: string): string {
  let out = ''
  for (const ch of text.replace(HEBREW_MARKS, '')) {
    out += SUBSTITUTES[ch] ?? transliterate(ch) ?? ch
  }
  return out
}

/** Один code point → один байт ISO-8859-8 (или замена). */
function byteFor(codePoint: number): number {
  if (codePoint <= 0x7f) return codePoint // ASCII как есть
  if (codePoint >= HEBREW_FIRST && codePoint <= HEBREW_LAST) {
    return ISO_HEBREW_FIRST + (codePoint - HEBREW_FIRST)
  }
  return REPLACEMENT_BYTE
}

/**
 * Кодирует строку в ISO-8859-8. Каждый code point нормализованного текста
 * даёт ровно один байт (эмодзи и прочие non-BMP символы — один `?`).
 */
export function encodeIso8859_8(text: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of normalizeForIso8859_8(text)) bytes.push(byteFor(ch.codePointAt(0) as number))
  return Uint8Array.from(bytes)
}
