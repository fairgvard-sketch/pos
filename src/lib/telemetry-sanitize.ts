/**
 * F6.1: приведение клиентской диагностики к безопасному виду.
 *
 * Модуль отвечает на один вопрос: что именно кассе разрешено положить в
 * localStorage и отправить в `report_client_errors`. Правила:
 *
 *  * **очистка идёт до сохранения**, до fingerprint и до отправки — на диск
 *    не должен попадать сырой текст ошибки;
 *  * набор полей — allowlist: очередь читается как недоверенный вход, даже
 *    если её писала прошлая версия кассы или посторонний код на устройстве;
 *  * регулярные выражения не объявляются достаточными для «любых
 *    персональных данных». Известные формы (токен, почта, телефон, URL,
 *    значение из detail Postgres) вычищаются точечно, а текст, который
 *    нельзя интерпретировать (сериализованный объект, нелатинское письмо),
 *    обрезается до безопасного префикса с меткой `[unsafe]`;
 *  * очистка идёт по **всей** строке, включая префиксы. Ни класс ошибки, ни
 *    «машинный код» не объявляются заранее безопасными: сначала строка
 *    вычищается целиком, и только потом из уже очищенного текста выделяется
 *    структура. Иначе `password: …` и `pin: …` в начале сообщения читались бы
 *    как код и уезжали дословно (F6.1-R1).
 *
 * Цена решения описана в docs/deployment.md → «Наблюдаемость парка»:
 * оператор гарантированно видит источник, версию и место сбоя, но не всегда
 * полный текст сообщения.
 */

import { sanitizeCtx } from './telemetry-context'

export const TELEMETRY_SOURCES = ['window', 'promise', 'react', 'outbox', 'print', 'shift'] as const

export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number]

/** Поля, которые принимает сервер (074/082). Ничего сверх них не уезжает. */
export interface WireError {
  fingerprint: string
  source: TelemetrySource
  message: string
  stack?: string
  route: string
  app_version: string
  user_agent: string
  count: number
}

/** Запись очереди = payload + метка поколения входа (см. telemetry-context). */
export interface QueuedError extends WireError {
  /** Поколение входа: диагностика одного аккаунта не уходит от имени другого. */
  ctx: string
}

export { UNVERIFIED_CTX, sanitizeCtx } from './telemetry-context'

export const LIMITS = {
  /** Вход регексов: длиннее обрезаем сразу, чтобы не грузить WebView T2. */
  rawMessage: 1_000,
  rawStack: 4_000,
  message: 300,
  stack: 1_600,
  frames: 8,
  frame: 200,
  route: 120,
  appVersion: 32,
  userAgent: 256,
  count: 1_000,
}

/** Печатный ASCII; всё остальное считаем невосстановимым текстом. */
const UNSAFE_RE = /[^ -~]|[{}]/
const WHITESPACE_RE = /\s+/g
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>\\|]+/gi
const OPAQUE_URL_RE = /\b(?:data|blob|filesystem|javascript):[^\s'"<>\\|]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g
const AUTH_SCHEME_RE = /\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi
/** Ключи, значение которых не показывают оператору ни в каком виде. */
const SECRET_KEY_SRC =
  'passwords?|passwd|pwd|pin|secret|api[_-]?key|apikey|anon[_-]?key|service[_-]?role|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|auth|session|cookie|signature|credential'
const SECRET_KEY_ONLY_RE = new RegExp(`^(?:${SECRET_KEY_SRC})$`, 'i')
/**
 * `token=…`, `password: …`, `password='…'`, `password=[…]`. Значение берём во
 * всех четырёх формах: кавычки и скобки раньше проносили секрет мимо очистки.
 * Кавычка внутри значения может быть экранирована. Конец ограниченного
 * входа тоже завершает значение: обрезанный лог не должен отменять очистку.
 */
const SECRET_VALUE_SRC = String.raw`"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|\[[^\]]*(?:\]|$)|[^\s,;&"'()\[\]{}]+`
const SECRET_KV_RE = new RegExp(
  `\\b(${SECRET_KEY_SRC})\\b\\s*[=:]\\s*(${SECRET_VALUE_SRC})`,
  'gi',
)
/**
 * Собственный канонический плейсхолдер. Его нельзя путать с произвольным
 * значением в скобках: иначе повторная очистка либо «съедала» бы свою метку,
 * либо оставляла бы чужое `[…]` нетронутым.
 */
const PLACEHOLDER_RE = /^\[(?:redacted|jwt|email|phone|uuid|token|n|url|inline-url|unsafe)\]$/
/** `Key (phone)=(+972...) already exists` — detail Postgres несёт значение строки. */
const PG_DETAIL_RE = /=\([^)]{0,200}\)/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(?:\+\d[\d\s().-]{6,}\d)|(?:\b0\d{1,2}[\s.-]?\d{3}[\s.-]?\d{4}\b)/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g
const LONG_DIGITS_RE = /\b\d{6,}\b/g
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,40}$/
/** Уже замаскированный сегмент: повторная очистка не должна его портить. */
const MASKED_SEGMENT_RE = /^:(id|n|x|skip)$/
const DIGIT_RUN_RE = /\d{4,}/
const ERROR_NAME_RE = /^([A-Za-z_][A-Za-z0-9_.]{0,40})\s*:\s*([\s\S]*)$/
/** Класс ошибки — только узнаваемая форма, а не «любое слово до двоеточия». */
const ERROR_CLASS_RE = /^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Rejection|Warning|Fault)$/
const MACHINE_CODE_RE = /^([a-z][a-z0-9_.-]{1,40})\s*:\s*([\s\S]*)$/
/** Машинный код — код сервера/домена, но никогда имя секретного поля. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/
const FRAME_POS_RE = /:(\d+):(\d+)\)?$/
const FRAME_LINE_RE = /^at\s/i
const FRAME_AT_RE = /@.+:\d+:\d+\)?$/
const IDENT_RE = /[^A-Za-z0-9_$. <>[\]:/-]+/g
const VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/

/** Сегмент пути: идентификаторы и номера не нужны оператору и могут быть данными. */
function maskSegment(seg: string): string {
  if (!seg) return ''
  if (MASKED_SEGMENT_RE.test(seg)) return seg
  if (UUID_ONLY_RE.test(seg)) return ':id'
  if (/^\d+$/.test(seg)) return ':n'
  if (!SEGMENT_RE.test(seg)) return ':x'
  if (DIGIT_RUN_RE.test(seg)) return ':x'
  return seg
}

/**
 * Путь → обезличенные сегменты. У длинного пути сохраняем начало и последний
 * сегмент: в кадре стека это имя файла, то есть само «место сбоя».
 */
function maskPath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 10) return parts.map(maskSegment).join('/')
  return parts.slice(0, 9).map(maskSegment)
    .concat([':skip', maskSegment(parts[parts.length - 1])])
    .join('/')
}

/** Путь → маршрут без идентификаторов; он же используется для URL в тексте. */
export function sanitizeRoute(raw: unknown): string {
  const path = typeof raw === 'string' ? raw : ''
  if (!path) return '/'
  return (maskPath(path) || '/').slice(0, LIMITS.route)
}

/** URL → схема, хост и обезличенный путь. Userinfo, query и fragment теряем. */
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${maskPath(u.pathname) || '/'}`
  } catch {
    return '[url]'
  }
}

/** Вычистить известные формы секретов и персональных данных. */
function redact(text: string): string {
  return text
    .replace(OPAQUE_URL_RE, '[inline-url]')
    .replace(URL_RE, safeUrl)
    .replace(JWT_RE, '[jwt]')
    .replace(AUTH_SCHEME_RE, '$1 [redacted]')
    .replace(SECRET_KV_RE, (_m, key: string, value: string) =>
      `${key}=${PLACEHOLDER_RE.test(value) ? value : '[redacted]'}`)
    .replace(PG_DETAIL_RE, '=([redacted])')
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[phone]')
    .replace(UUID_RE, '[uuid]')
    .replace(LONG_TOKEN_RE, '[token]')
    .replace(LONG_DIGITS_RE, '[n]')
}

/**
 * Оставить префикс, который прошёл проверку, и честно пометить остаток.
 * Нелатинский текст и сериализованный объект интерпретировать нечем: там
 * может быть имя гостя, состав заказа или чужой payload целиком.
 */
function cutAtUnsafe(text: string): string {
  const i = text.search(UNSAFE_RE)
  if (i < 0) return text
  const head = text.slice(0, i).trim()
  return head ? `${head} [unsafe]` : '[unsafe]'
}

/**
 * Сообщение → `<класс ошибки>: <машинный код>: <очищенный текст>`.
 *
 * Порядок принципиален (F6.1-R1): сначала `redact` по всей строке, и только
 * потом разбор структуры уже очищенного текста. Класс и код при этом остаются
 * опорами дедупликации, но ни один префикс не считается безопасным заранее:
 * `password: …` и `pin: …` вычищаются до того, как кто-то попробует прочитать
 * их как код, а имя секретного поля кодом не признаётся вовсе.
 */
export function sanitizeMessage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const flat = raw.slice(0, LIMITS.rawMessage).replace(WHITESPACE_RE, ' ').trim()
  if (!flat) return ''

  let rest = redact(flat)
  let head = ''
  const named = ERROR_NAME_RE.exec(rest)
  if (named && ERROR_CLASS_RE.test(named[1])) {
    head = named[1]
    rest = named[2]
  }
  let code = ''
  const coded = MACHINE_CODE_RE.exec(rest)
  if (coded && !SECRET_KEY_ONLY_RE.test(coded[1])) {
    code = coded[1]
    rest = coded[2]
  } else {
    const state = SQLSTATE_RE.exec(rest.split(':')[0] ?? '')
    if (state) {
      code = state[0]
      rest = rest.slice(code.length + 1)
    }
  }

  const tail = cutAtUnsafe(rest).trim()
  const parts: string[] = []
  if (head) parts.push(head)
  if (code) parts.push(code)
  if (tail) parts.push(tail)
  return parts.join(': ').slice(0, LIMITS.message)
}

function safeIdent(raw: string, max: number): string {
  return raw.replace(IDENT_RE, ' ').replace(WHITESPACE_RE, ' ').trim().slice(0, max)
}

function looksLikeFrame(line: string): boolean {
  return FRAME_LINE_RE.test(line) || FRAME_AT_RE.test(line)
}

/**
 * Кадр стека: функция + файл + позиция. Позицию снимаем до очистки — иначе
 * её съедает нормализация URL, а это и есть «место сбоя».
 */
function sanitizeFrame(raw: string): string {
  let t = raw.trim().slice(0, 400)
  const pos = FRAME_POS_RE.exec(t)
  const at = pos ? `:${pos[1]}:${pos[2]}` : ''
  if (pos) t = t.slice(0, pos.index)
  // позиция дороже длинного пути: режем тело, а не `:строка:колонка`
  const room = Math.max(24, LIMITS.frame - at.length - 3)
  const body = safeIdent(cutAtUnsafe(redact(t.replace(FRAME_LINE_RE, ''))), room)
  return `at ${body}${at}`
}

/**
 * Стек → только кадры. Заголовок стека дублирует сообщение и уже сохранён
 * очищенным, поэтому его не переносим.
 */
export function sanitizeStack(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const frames: string[] = []
  for (const line of raw.slice(0, LIMITS.rawStack).split('\n')) {
    const t = line.trim()
    if (!t || !looksLikeFrame(t)) continue
    frames.push(sanitizeFrame(t))
    if (frames.length >= LIMITS.frames) break
  }
  if (frames.length === 0) return undefined
  return frames.join('\n').slice(0, LIMITS.stack)
}

export function sanitizeSource(raw: unknown): TelemetrySource {
  return (TELEMETRY_SOURCES as readonly unknown[]).indexOf(raw) >= 0
    ? (raw as TelemetrySource)
    : 'window'
}

/** Счётчик повторов: конечное целое в [1, 1000]. Сервер приводит так же. */
export function sanitizeCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.floor(n), 1), LIMITS.count)
}

export function sanitizeVersion(raw: unknown): string {
  return typeof raw === 'string' && VERSION_RE.test(raw) ? raw : ''
}

/** Комментарий UA: `(Linux; Android 7.1.2; …)` — платформа, а не свободный текст. */
const UA_COMMENT_PART_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/
/** Продуктовый токен `Chrome/120.0`; версия обязательна. */
const UA_PRODUCT_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}\/[A-Za-z0-9._+-]{1,24}$/
/** Одиночное слово вида `Mobile`: без цифр и знаков — там нечему прятаться. */
const UA_WORD_RE = /^[A-Za-z]{1,20}$/

/**
 * User-Agent → только полезные данные браузера и платформы (F6.1-R1).
 *
 * Строку собирает система, но на терминале её подменяет APK-обёртка, а в
 * поле уже встречались посторонние приписки. Поэтому UA не «обрезается», а
 * пересобирается из узнаваемых частей: продукт с версией, слово без цифр и
 * скобочный комментарий платформы. Всё остальное (пары `key=value`, URL,
 * нелатинский текст) отбрасывается целиком, а не маскируется.
 */
export function sanitizeUserAgent(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const flat = redact(raw.slice(0, LIMITS.rawMessage).replace(WHITESPACE_RE, ' ')).trim()
  const out: string[] = []
  // скобочные комментарии и остальной текст разбираем по отдельности
  for (const chunk of flat.split(/(\([^)]*\))/)) {
    if (!chunk) continue
    if (chunk.charAt(0) === '(') {
      const parts = chunk.slice(1, -1).split(';').map((p) => p.trim())
        .filter((p) => UA_COMMENT_PART_RE.test(p))
      if (parts.length > 0) out.push(`(${parts.join('; ')})`)
      continue
    }
    for (const token of chunk.trim().split(' ')) {
      if (UA_PRODUCT_RE.test(token) || UA_WORD_RE.test(token)) out.push(token)
    }
  }
  return out.join(' ').slice(0, LIMITS.userAgent)
}

/** djb2 — стабильный дешёвый хеш для fingerprint (Chrome 52-safe) */
export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Fingerprint считается по уже очищенным значениям: одинаковый сбой с разным
 * телефоном или идентификатором в тексте схлопывается в одну запись.
 */
export function fingerprintOf(source: TelemetrySource, message: string, stack?: string): string {
  const frame = (stack ?? '').split('\n')[0] ?? ''
  return hash(`${source}|${message.slice(0, 200)}|${frame.trim().slice(0, 120)}`)
}

/**
 * Элемент очереди → безопасная запись или `null`. Принимаем что угодно:
 * повреждённый JSON, чужие поля, числа и массивы вместо объектов.
 */
export function sanitizeEntry(raw: unknown): QueuedError | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const message = sanitizeMessage(o.message)
  if (!message) return null
  const source = sanitizeSource(o.source)
  const stack = sanitizeStack(o.stack)
  return {
    fingerprint: fingerprintOf(source, message, stack),
    source,
    message,
    stack,
    route: sanitizeRoute(o.route),
    app_version: sanitizeVersion(o.app_version),
    user_agent: sanitizeUserAgent(o.user_agent),
    count: sanitizeCount(o.count),
    ctx: sanitizeCtx(o.ctx),
  }
}

/** Payload RPC: ровно поля сервера, без клиентской метки контекста. */
export function toWireError(e: QueuedError): WireError {
  const wire: WireError = {
    fingerprint: e.fingerprint,
    source: e.source,
    message: e.message,
    route: e.route,
    app_version: e.app_version,
    user_agent: e.user_agent,
    count: e.count,
  }
  if (e.stack) wire.stack = e.stack
  return wire
}
