/**
 * Проверка подписи webhook'а платёжного провайдера.
 *
 * Webhook — единственный источник истины об оплате (возврат пользователя
 * на success-страницу оплатой НЕ является: этот URL открывается руками).
 * Значит подпись — единственное, что отличает настоящее уведомление
 * провайдера от подделки, и проверять её надо до любого обращения к БД.
 *
 * Вынесено из index.ts ради юнит-тестов: криптографию нельзя проверять
 * «на глаз», а Edge Function целиком в тестах не поднять.
 */

/** Хекс-строка → байты; невалидный вход даёт null, а не исключение */
function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase()
  if (clean.length === 0 || clean.length % 2 !== 0) return null
  if (!/^[0-9a-f]+$/.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Сравнение за постоянное время. Обычное === выходит на первом
 * несовпавшем байте, и по времени ответа подпись можно подобрать.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = hexToBytes(a)
  const bb = hexToBytes(b)
  if (!ab || !bb) return false
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

/** HMAC-SHA256 сырого тела запроса; ключ — секрет провайдера */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return bytesToHex(new Uint8Array(sig))
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_secret' | 'missing_signature' | 'bad_signature' | 'stale' }

/**
 * Проверка подписи и свежести уведомления.
 *
 * `maxAgeSeconds` защищает от replay: перехваченный когда-то валидный
 * webhook нельзя переиграть спустя сутки. Провайдер обычно кладёт метку
 * времени в заголовок; если её нет — передавайте null, и проверка
 * возраста пропускается (подпись при этом обязательна всегда).
 */
export async function verifyWebhookSignature(params: {
  secret: string | undefined
  rawBody: string
  signatureHeader: string | null
  timestamp?: number | null
  maxAgeSeconds?: number
  now?: number
}): Promise<SignatureCheck> {
  const { secret, rawBody, signatureHeader, timestamp = null } = params
  const maxAge = params.maxAgeSeconds ?? 300
  const now = params.now ?? Date.now()

  // Нет секрета — функция не настроена. Fail closed: молча пропускать
  // неподписанные уведомления нельзя ни при каких обстоятельствах.
  if (!secret) return { ok: false, reason: 'missing_secret' }
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' }

  if (timestamp !== null) {
    const ageMs = Math.abs(now - timestamp * 1000)
    if (ageMs > maxAge * 1000) return { ok: false, reason: 'stale' }
  }

  // Подписывается СЫРОЕ тело: пересериализованный JSON даёт другие
  // байты (порядок ключей, пробелы) и подпись не сойдётся.
  const signed = timestamp !== null ? `${timestamp}.${rawBody}` : rawBody
  const expected = await hmacSha256Hex(secret, signed)

  return timingSafeEqual(expected, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' }
}
