import { supabase } from './supabase'

/**
 * Минимальная версия схемы БД, с которой работает этот фронтенд.
 * CI (scripts/check-schema-version.mjs) требует равенства с номером последней
 * миграции: порядок релиза «миграции → функции → фронт» гарантирует, что база
 * не отстаёт от выложенного фронта.
 */
export const MIN_SCHEMA_VERSION = 147

export type SchemaCheck =
  | { status: 'ok'; version: number }
  | { status: 'outdated'; version: number }
  /**
   * База УШЛА ВПЕРЁД: миграции применены, а этот бандл собран под более
   * раннюю схему. По порядку релиза «миграции → функции → фронт» так
   * выглядит терминал, который не забрал новую сборку.
   *
   * Не блокируем: между накаткой миграции и деплоем фронта проходят
   * минуты, и в это окно так выглядят ВСЕ кассы — блокирующий экран
   * останавливал бы торговлю на каждом релизе. Но и молчать нельзя:
   * именно в этом состоянии касса месяцами крутила старый бандл и
   * никто об этом не знал. Показываем обязательную плашку обновления.
   */
  | { status: 'stale'; version: number }
  /** Сеть/офлайн/неожиданный ответ — работу не блокируем, каталог отдаёт кэш */
  | { status: 'unknown' }

/** Коды PostgREST/PostgreSQL «функции не существует» — база старше 081 */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883'])

/** Чистая классификация ответа rpc — вынесена из fetch ради юнит-тестов */
export function interpretSchemaResponse(
  data: unknown,
  error: { code?: string } | null,
): SchemaCheck {
  if (error) {
    if (error.code && MISSING_FUNCTION_CODES.has(error.code)) {
      return { status: 'outdated', version: 0 }
    }
    return { status: 'unknown' }
  }
  if (data == null) return { status: 'unknown' }
  const version = typeof data === 'number' ? data : Number(data)
  if (!Number.isFinite(version)) return { status: 'unknown' }
  if (version < MIN_SCHEMA_VERSION) return { status: 'outdated', version }
  return version > MIN_SCHEMA_VERSION
    ? { status: 'stale', version }
    : { status: 'ok', version }
}

export async function checkSchemaVersion(): Promise<SchemaCheck> {
  try {
    const { data, error } = await supabase.rpc('get_schema_version')
    return interpretSchemaResponse(data, error)
  } catch {
    return { status: 'unknown' }
  }
}
