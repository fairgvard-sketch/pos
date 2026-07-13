import { supabase } from '../supabase'

/**
 * Изоляция локального состояния по устройству/организации (P3).
 *
 * Проблема: outbox, read-кэш и per-device настройки живут в localStorage
 * под ФИКСИРОВАННЫМИ ключами. Если на одном браузере/терминале сменить
 * аккаунт устройства (отвязать А, войти под Б другой организации/точки),
 * данные А смешаются с Б — и, что опаснее всего, неотправленные финансовые
 * операции А могли бы уйти на сервер под сессией Б (чужой org_id в JWT).
 *
 * Scope = org_id + location_id + auth user id. Каждая операция outbox
 * штампуется скоупом; дренаж отказывается отправлять операцию, чей скоуп
 * не совпадает с текущей сессией (карантин, см. drain.ts). При смене скоупа
 * чистим безопасные локальные данные (read-кэш, per-device настройки),
 * НЕ трогая чужой outbox — он карантинится и решается вручную.
 */

/** Ключи localStorage, безопасные для очистки при смене scope/отвязке.
 *  НЕ включает kassa-outbox (неотправленные деньги) и kassa-lang. */
export const SCOPED_STORAGE_KEYS = ['kassa-query-cache', 'kassa-device-settings'] as const

/** Ключ, под которым помним scope, которому принадлежит локальное состояние */
const SCOPE_MARKER_KEY = 'kassa-scope'

let cachedScope: string | null = null

/** Собрать scope-ключ из полей сессии; null — нет сессии/не онбордились */
function scopeFromSession(session: {
  user: { id: string; app_metadata?: Record<string, unknown> }
} | null): string | null {
  if (!session) return null
  const meta = (session.user.app_metadata ?? {}) as Record<string, string | undefined>
  const org = meta.org_id
  const loc = meta.location_id
  if (!org) return null // не завершён онбординг — скоупа ещё нет
  return `${org}:${loc ?? '-'}:${session.user.id}`
}

/** Синхронный scope для штампа операций. Валиден после initScope/refreshScope. */
export function currentScopeKey(): string | null {
  return cachedScope
}

/**
 * Новые финансовые операции нельзя ставить в persistent-очередь до того,
 * как устройство получило org/location scope из JWT. Иначе после смены
 * аккаунта невозможно доказать, какой организации принадлежит операция.
 */
export function requireCurrentScopeKey(): string {
  if (!cachedScope) {
    throw new Error('device scope unavailable')
  }
  return cachedScope
}

/** Перечитать scope из активной сессии Supabase (async) */
export async function refreshScope(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  cachedScope = scopeFromSession(data.session)
  return cachedScope
}

/**
 * Операция принадлежит текущему scope? Старые немаркированные записи нельзя
 * безопасно атрибутировать, поэтому они тоже отправляются в карантин.
 */
export function opInCurrentScope(opScope: string | null | undefined): boolean {
  return opScope != null && cachedScope != null && opScope === cachedScope
}

/**
 * Смена scope на терминале: чистим безопасные локальные данные предыдущего
 * scope (read-кэш чужого каталога, чужие per-device настройки). Outbox НЕ
 * трогаем — его операции карантинятся дренажом по несовпадению scope.
 * Возвращает true, если scope действительно сменился.
 */
function onScopeChanged(prev: string | null, next: string | null): boolean {
  if (prev === next) return false
  for (const key of SCOPED_STORAGE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
  return true
}

let inited = false

/**
 * Инициализация на старте приложения: считываем scope, сверяем с маркером
 * прошлой сессии. Если scope сменился (сменили аккаунт устройства между
 * запусками) — чистим scoped-данные. Подписываемся на смену auth-сессии.
 */
export async function initScope(): Promise<void> {
  if (inited) return
  inited = true

  const marker = (() => {
    try { return localStorage.getItem(SCOPE_MARKER_KEY) } catch { return null }
  })()

  await refreshScope()

  // Скоуп сменился между запусками (или впервые) — подчистим scoped-данные.
  // marker===null и cachedScope===null (свежий браузер) — не считаем сменой.
  if (marker !== cachedScope && !(marker === null && cachedScope === null)) {
    onScopeChanged(marker, cachedScope)
  }
  persistMarker()

  supabase.auth.onAuthStateChange((_event, session) => {
    const prev = cachedScope
    cachedScope = scopeFromSession(session)
    if (prev !== cachedScope) {
      onScopeChanged(prev, cachedScope)
      persistMarker()
    }
  })
}

function persistMarker(): void {
  try {
    if (cachedScope) localStorage.setItem(SCOPE_MARKER_KEY, cachedScope)
    else localStorage.removeItem(SCOPE_MARKER_KEY)
  } catch { /* ignore */ }
}
