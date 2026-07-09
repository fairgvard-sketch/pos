import type { LocationSettings, PermLevel, Role } from '../types'

/**
 * Права по ролям (настройки точки, locations.settings.perms).
 * Enforcement клиентский — модель авторизации доверяет устройству
 * (см. CLAUDE.md); ужесточение на staff-scoped токены — после MVP.
 */
export type PermKey = 'discount' | 'price_edit' | 'refund' | 'void_order' | 'close_shift'

export const PERM_KEYS: PermKey[] = ['discount', 'price_edit', 'refund', 'void_order', 'close_shift']

/**
 * Дефолты повторяют поведение до миграции 036: возврат и раньше был
 * только для менеджера (TransactionsPage), остальное было доступно всем.
 */
const DEFAULTS: Record<PermKey, PermLevel> = {
  discount: 'all',
  price_edit: 'all',
  refund: 'manager',
  void_order: 'all',
  close_shift: 'all',
}

/** Уровень права из настроек точки (с дефолтом) */
export function permLevel(settings: LocationSettings | undefined, key: PermKey): PermLevel {
  return settings?.perms?.[key] ?? DEFAULTS[key]
}

/** Может ли сотрудник с ролью выполнить действие на этой точке */
export function can(role: Role | undefined, key: PermKey, settings: LocationSettings | undefined): boolean {
  if (permLevel(settings, key) === 'all') return true
  return role === 'manager' || role === 'owner'
}
