/**
 * Код допуска телефона (180): QR ведёт на /waiter/pair#K7M2P9QR. Код в
 * фрагменте URL не уходит на сервер и не оседает в логах хостинга.
 * Алфавит — как в create_waiter_pairing_code: без 0/O, 1/I/L.
 */
const PAIR_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/

export function normalizePairCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return PAIR_CODE_RE.test(code) ? code : null
}

/** Код из location.hash ("#K7M2-P9QR" → "K7M2P9QR") */
export function codeFromHash(hash: string): string | null {
  return normalizePairCode(hash.replace(/^#/, ''))
}

/** Подпись телефона для списка в кабинете: «iPhone · Safari» */
export function phoneLabel(ua: string): string {
  const device = /iPad/.test(ua) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : 'Browser'
  const browser = /CriOS|Chrome\//.test(ua) && !/Edg/.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
        : ''
  return browser ? `${device} · ${browser}` : device
}
