import { supabase } from './supabase'

/**
 * Гейт активации ANGLE POS (Phase 5 product separation): касса — потребитель
 * capability `pos_operate`, а не неявный владелец всех продуктов. Организация
 * без активного продукта `pos` (новый онбординг 104 продукты не раздаёт,
 * приостановка 105) получает явный экран «POS не активирован», а не тихо
 * ломающиеся мутации module_disabled.
 *
 * Ответ 'unknown' (офлайн, сбой сети, база до 105) НЕ блокирует — POS живёт
 * по локальному кэшу; настоящая граница — серверные гейты RPC.
 */
export type PosEntitlementCheck = 'ok' | 'missing' | 'unknown'

/** Чистая классификация ответа rpc — вынесена из fetch ради юнит-тестов */
export function interpretPosEntitlement(
  data: unknown,
  error: { code?: string } | null,
): PosEntitlementCheck {
  if (error) return 'unknown'
  if (data === true) return 'ok'
  if (data === false) return 'missing'
  return 'unknown'
}

export async function checkPosEntitlement(): Promise<PosEntitlementCheck> {
  try {
    const { data: sess } = await supabase.auth.getSession()
    const meta = sess.session?.user?.app_metadata as { org_id?: string } | undefined
    if (!meta?.org_id) return 'unknown'
    const { data, error } = await supabase.rpc('org_has_capability', {
      p_org: meta.org_id,
      p_capability: 'pos_operate',
    })
    return interpretPosEntitlement(data, error)
  } catch {
    return 'unknown'
  }
}
