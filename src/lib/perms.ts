import type { LocationSettings, PermLevel, Role } from '../types'

/**
 * Права по ролям (настройки точки, locations.settings.perms).
 * Enforcement клиентский — модель авторизации доверяет устройству
 * (см. CLAUDE.md); ужесточение на staff-scoped токены — после MVP.
 */
export type PermKey = 'discount' | 'price_edit' | 'refund' | 'void_order' | 'close_shift' | 'cash_movement' | 'online_pause' | 'stock_receive' | 'stock_take'

export const PERM_KEYS: PermKey[] = ['discount', 'price_edit', 'refund', 'void_order', 'close_shift', 'cash_movement', 'online_pause', 'stock_receive', 'stock_take']

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
  cash_movement: 'all',
  online_pause: 'all',
  stock_receive: 'all',
  stock_take: 'manager',
}

/** Уровень права из настроек точки (с дефолтом) */
export function permLevel(settings: LocationSettings | undefined, key: PermKey): PermLevel {
  return settings?.perms?.[key] ?? DEFAULTS[key]
}

/**
 * Может ли сотрудник выполнить действие на этой точке.
 *
 * Зеркалит серверный require_staff_perm (094) — порядок веток обязан
 * совпадать, иначе UI покажет кнопку, на которой сервер откажет:
 *   1) владелец может всё (роль его не ограничивает);
 *   2) есть кастомная роль → решает её набор прав ('manage' в него не входит);
 *   3) иначе прежняя логика: уровень права из настроек точки + база.
 *
 * Клиентская проверка только прячет недоступное; отказ выносит сервер.
 */
export function can(
  role: Role | undefined,
  key: PermKey,
  settings: LocationSettings | undefined,
  rolePerms?: string[] | null,
): boolean {
  if (role === 'owner') return true
  if (rolePerms) return rolePerms.includes(key)
  if (permLevel(settings, key) === 'all') return true
  return role === 'manager'
}
