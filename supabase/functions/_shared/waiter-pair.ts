/**
 * Чистые помощники Edge Function waiter-pair (180): разбор кода допуска,
 * подпись телефона и коды ошибок. Без Deno API — тестируются vitest.
 */

/** Алфавит кода — как в create_waiter_pairing_code: без 0/O, 1/I/L */
export const PAIR_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/

/** Код из QR или с клавиатуры: регистр, пробелы и дефисы не важны */
export function normalizePairCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return PAIR_CODE_RE.test(code) ? code : null
}

/** Подпись телефона для списка в кабинете: одна строка, до 60 символов */
export function cleanDeviceLabel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

const KNOWN_ERRORS = ['invalid_code', 'module_disabled'] as const

/** Ошибка RPC → код для клиента; всё прочее — unknown (детали только в логе) */
export function pairErrorCode(message: string): string {
  for (const code of KNOWN_ERRORS) if (message.includes(code)) return code
  return 'unknown'
}

/** Пароль аккаунта телефона: нигде не хранится, телефон живёт refresh-токеном */
export function randomPassword(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}
