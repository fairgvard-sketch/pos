/**
 * F6.1-R1: кому принадлежит очередь телеметрии.
 *
 * На терминале сменяются аккаунты: устройство перерегистрируют на другую
 * точку, владелец входит своим аккаунтом, касса уезжает в другую организацию.
 * Диагностика, собранная под одним входом, не должна уехать от имени другого,
 * поэтому запись помечается **поколением входа**, а поколение привязано к
 * тройке `user + org + location`, а не к одному user.
 *
 * Формат локальной записи (ключ `kassa-telemetry-ctx`, единственное, что
 * модуль пишет на диск):
 *
 * ```json
 * {"v":1,"g":"<16 hex>","s":"<16 hex>","d":"<32 hex>"}
 * ```
 *
 *  * `g` — поколение входа: случайный идентификатор, которым помечаются
 *    записи очереди. Новый вход — новое `g`, старые записи перестают
 *    совпадать и удаляются;
 *  * `s` — случайная соль этого устройства;
 *  * `d` — 128-битный отпечаток `s|user|org|location`.
 *
 * Ни токен, ни сам `user_id`/`org_id`/`location_id` на диск не пишутся: по
 * записи нельзя восстановить аккаунт, её хватает только чтобы ответить
 * «текущий вход тот же самый или уже другой». Отпечаток не является
 * криптографическим MAC: он защищает от случайного совпадения и от
 * присвоения очереди соседнему контексту, но не от подделки тем, кто уже
 * имеет доступ к localStorage устройства. При любом несовпадении очередь
 * удаляется — безопасная потеря телеметрии здесь дешевле чужой атрибуции.
 */

/** Поколение неизвестно: запись поймана до подтверждения контекста. */
export const UNVERIFIED_CTX = '?'

export const CTX_KEY = 'kassa-telemetry-ctx'

const GEN_RE = /^[0-9a-f]{16}$/
const DIGEST_RE = /^[0-9a-f]{32}$/

/** Владелец очереди: устройство одной организации и одной точки. */
export interface TelemetryIdentity {
  user: string
  org: string
  location: string
}

export interface TelemetryContext {
  /** Поколение входа (`g`) */
  gen: string
  /** Соль устройства (`s`) */
  salt: string
  /** Отпечаток identity (`d`) */
  digest: string
}

/** Метка поколения корректна ровно в одном формате; всё прочее — «неизвестно». */
export function sanitizeCtx(raw: unknown): string {
  return typeof raw === 'string' && GEN_RE.test(raw) ? raw : UNVERIFIED_CTX
}

function claim(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object') return ''
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.slice(0, 64) : ''
}

/**
 * Сессия Supabase → тройка владельца. `org_id`/`location_id` приходят из
 * JWT `app_metadata` (см. AGENTS.md «Модель авторизации»); у digital-аккаунта
 * точки может не быть — тогда её место в тройке пустое, но user остаётся.
 */
export function identityOf(session: unknown): TelemetryIdentity | null {
  if (!session || typeof session !== 'object') return null
  const user = (session as { user?: unknown }).user
  if (!user || typeof user !== 'object') return null
  const id = (user as { id?: unknown }).id
  if (typeof id !== 'string' || !id) return null
  const meta = (user as { app_metadata?: unknown }).app_metadata
  return { user: id.slice(0, 64), org: claim(meta, 'org_id'), location: claim(meta, 'location_id') }
}

/** Токен текущей сессии; им же привязывается отправка (на диск не попадает). */
export function accessTokenOf(session: unknown): string | null {
  if (!session || typeof session !== 'object') return null
  const token = (session as { access_token?: unknown }).access_token
  return typeof token === 'string' && token ? token : null
}

function hex8(n: number): string {
  // padStart в горячем модуле не используем: он тянет полифилл на Chrome 52
  return ((n >>> 0) + 0x1_0000_0000).toString(16).slice(1)
}

/** FNV-1a по обоим байтам кода символа: не-ASCII не схлопывается в один байт. */
function fnv1a(seed: number, text: string): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h = Math.imul(h ^ (c & 0xff), 16777619) >>> 0
    h = Math.imul(h ^ ((c >>> 8) & 0xff), 16777619) >>> 0
  }
  return h >>> 0
}

/** Четыре независимые полосы = 128 бит. 32-битного отпечатка здесь мало. */
const LANES = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]

export function contextDigest(salt: string, id: TelemetryIdentity): string {
  const text = `${salt}|${id.user}|${id.org}|${id.location}`
  let out = ''
  for (let i = 0; i < LANES.length; i++) out += hex8(fnv1a(LANES[i], `${i}|${text}`))
  return out
}

/** Случайные байты: getRandomValues есть с Chrome 11, фолбэк — на всякий случай. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  const source = typeof crypto !== 'undefined' ? crypto : undefined
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(buf)
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < bytes; i++) out += ((buf[i] | 0) + 0x100).toString(16).slice(1)
  return out
}

export function readContext(): TelemetryContext | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(CTX_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.v !== 1) return null
  const gen = typeof o.g === 'string' && GEN_RE.test(o.g) ? o.g : ''
  const salt = typeof o.s === 'string' && GEN_RE.test(o.s) ? o.s : ''
  const digest = typeof o.d === 'string' && DIGEST_RE.test(o.d) ? o.d : ''
  if (!gen || !salt || !digest) return null
  return { gen, salt, digest }
}

export function writeContext(ctx: TelemetryContext): void {
  try {
    localStorage.setItem(CTX_KEY, JSON.stringify({ v: 1, g: ctx.gen, s: ctx.salt, d: ctx.digest }))
  } catch { /* нет места/доступа — контекст не подтверждён, телеметрия подождёт */ }
}

/** Вход завершён: поколение уходит в прошлое, следующий вход получит новое. */
export function clearContext(): void {
  try { localStorage.removeItem(CTX_KEY) } catch { /* ignore */ }
}

export function newContext(id: TelemetryIdentity): TelemetryContext {
  const salt = randomHex(8)
  return { gen: randomHex(8), salt, digest: contextDigest(salt, id) }
}

export function matchesContext(ctx: TelemetryContext, id: TelemetryIdentity): boolean {
  return contextDigest(ctx.salt, id) === ctx.digest
}

/** Поколение, которым метятся новые записи прямо сейчас. */
export function currentGen(): string {
  const ctx = readContext()
  return ctx ? ctx.gen : UNVERIFIED_CTX
}
