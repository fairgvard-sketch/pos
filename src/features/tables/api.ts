import { supabase } from '../../lib/supabase'
import { getDeviceContext } from '../auth/api'
import type { CartLine } from '../../store/cartStore'
import type { Table } from '../../types'

// ── Справочник столов ────────────────────────────────────

export async function fetchTables(): Promise<Table[]> {
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(error.message)
  return data as Table[]
}

export async function createTable(label: string, zone: string | null, sortOrder: number): Promise<void> {
  const ctx = await getDeviceContext()
  if (!ctx?.orgId || !ctx?.locationId) throw new Error('Device not bootstrapped')
  const { error } = await supabase
    .from('tables')
    .insert({ org_id: ctx.orgId, location_id: ctx.locationId, label, zone: zone || null, sort_order: sortOrder })
  if (error) throw new Error(error.message)
}

/** Мягкое удаление — is_active=false, чтобы не рвать ссылки заказов */
export async function deleteTable(id: string): Promise<void> {
  const { error } = await supabase.from('tables').update({ is_active: false }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Открытые счета столов ────────────────────────────────

export interface TableOrderResult {
  order_id: string
  daily_number: number
  total: number
  existing: boolean
}

/** Открыть (или получить существующий) счёт стола */
export async function openTableOrder(tableId: string, staffId: string): Promise<TableOrderResult> {
  const { data, error } = await supabase.rpc('open_or_get_table_order', {
    p_table_id: tableId,
    p_staff_id: staffId,
  })
  if (error) throw new Error(error.message)
  return data as TableOrderResult
}

/** Дозаказ: добавить позиции в открытый счёт, пересчитать итоги */
export async function appendToOrder(orderId: string, staffId: string, lines: CartLine[]): Promise<{ total: number }> {
  const { data, error } = await supabase.rpc('append_to_order', {
    p_order_id: orderId,
    p_staff_id: staffId,
    p_items: lines.map((l) => ({
      menu_item_id: l.itemId,
      variant_id: l.variantId,
      modifier_ids: l.mods.map((m) => m.id),
      qty: l.qty,
      notes: l.notes,
      custom_name: l.itemId === null ? l.name : null,
      unit_price_override: l.priceOverride,
    })),
  })
  if (error) throw new Error(error.message)
  return data as { total: number }
}

export async function voidTableOrder(orderId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('void_table_order', { p_order_id: orderId, p_reason: reason ?? null })
  if (error) throw new Error(error.message)
}

// ── Состояние зала: какие столы заняты ────────────────────

export interface TableOccupancy {
  table_id: string
  order_id: string
  total: number
  daily_number: number
  opened_at: string
}

/** Открытые счета всех столов точки — для раскраски карты зала */
export async function fetchOpenTableOrders(): Promise<TableOccupancy[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, table_id, total, daily_number, created_at')
    .eq('status', 'open')
    .not('table_id', 'is', null)
  if (error) throw new Error(error.message)
  return (data as { id: string; table_id: string; total: number; daily_number: number; created_at: string }[]).map((o) => ({
    table_id: o.table_id,
    order_id: o.id,
    total: o.total,
    daily_number: o.daily_number,
    opened_at: o.created_at,
  }))
}
