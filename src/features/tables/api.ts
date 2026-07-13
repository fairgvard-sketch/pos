import { supabase } from '../../lib/supabase'
import { getDeviceContext } from '../auth/api'
import { currentStaffToken } from '../../store/authStore'
import type { CartLine } from '../../store/cartStore'
import type { Table, TableStatus, TableShape } from '../../types'

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

export async function createTable(
  label: string, zone: string | null, sortOrder: number,
  seats = 2, combinable = false,
): Promise<void> {
  const ctx = await getDeviceContext()
  if (!ctx?.orgId || !ctx?.locationId) throw new Error('Device not bootstrapped')
  const { error } = await supabase
    .from('tables')
    .insert({ org_id: ctx.orgId, location_id: ctx.locationId, label, zone: zone || null,
              sort_order: sortOrder, seats, combinable })
  if (error) throw new Error(error.message)
}

/** Переименовать стол / сменить зону / вместимость (063) */
export async function updateTable(
  id: string, label: string, zone: string | null,
  seats?: number, combinable?: boolean,
): Promise<void> {
  const patch: { label: string; zone: string | null; seats?: number; combinable?: boolean } = {
    label, zone: zone || null,
  }
  if (seats !== undefined) patch.seats = seats
  if (combinable !== undefined) patch.combinable = combinable
  const { error } = await supabase.from('tables').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Мягкое удаление — is_active=false, чтобы не рвать ссылки заказов */
export async function deleteTable(id: string): Promise<void> {
  const { error } = await supabase.from('tables').update({ is_active: false }).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Ручной статус стола: free / reserved / disabled */
export async function setTableStatus(id: string, status: TableStatus): Promise<void> {
  const { error } = await supabase.rpc('set_table_status', { p_table_id: id, p_status: status })
  if (error) throw new Error(error.message)
}

/**
 * Сохранить раскладку стола на плане: позиция (%), размер (%), форма.
 * Прямой UPDATE (не RPC): координаты клампятся на клиенте при drag,
 * RLS-политика tables_all скоупит по org. Так же, как updateTable/deleteTable.
 */
export async function setTableLayout(
  id: string,
  x: number,
  y: number,
  width?: number,
  shape?: TableShape,
  height?: number,
): Promise<void> {
  const patch: { pos_x: number; pos_y: number; width?: number; height?: number; shape?: TableShape } = {
    pos_x: Math.round(x * 100) / 100,
    pos_y: Math.round(y * 100) / 100,
  }
  if (width !== undefined) patch.width = Math.round(width * 100) / 100
  if (height !== undefined) patch.height = Math.round(height * 100) / 100
  if (shape !== undefined) patch.shape = shape
  const { error } = await supabase.from('tables').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Открытые счета столов ────────────────────────────────

export interface TableOrderResult {
  order_id: string
  daily_number: number
  total: number
  existing: boolean
}

/**
 * Открыть (или получить существующий) счёт стола.
 * clientUuid/openedAt — для offline-replay (042): заказ с этим client_uuid
 * уже существует → вернётся он же, повтор не создаст второй счёт.
 */
export async function openTableOrder(
  tableId: string,
  staffId: string,
  clientUuid: string | null = null,
  openedAt: string | null = null
): Promise<TableOrderResult> {
  const { data, error } = await supabase.rpc('open_or_get_table_order', {
    p_table_id: tableId,
    p_staff_id: staffId,
    ...(clientUuid ? { p_client_uuid: clientUuid } : {}),
    ...(openedAt ? { p_opened_at: openedAt } : {}),
  })
  if (error) throw new Error(error.message)
  return data as TableOrderResult
}

/**
 * Дозаказ: добавить позиции в открытый счёт, пересчитать итоги.
 * opUuid — ключ идемпотентности (042): replay не дублирует строки.
 */
export async function appendToOrder(
  orderId: string,
  staffId: string,
  lines: CartLine[],
  opUuid: string | null = null
): Promise<{ total: number }> {
  const { data, error } = await supabase.rpc('append_to_order', {
    p_order_id: orderId,
    p_staff_id: staffId,
    ...(opUuid ? { p_op_uuid: opUuid } : {}),
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
  const { error } = await supabase.rpc('void_table_order', {
    p_order_id: orderId,
    p_reason: reason ?? null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/** Перенести открытый счёт на другой (свободный) стол */
export async function moveTableOrder(orderId: string, toTableId: string): Promise<void> {
  const { error } = await supabase.rpc('move_table_order', { p_order_id: orderId, p_to_table_id: toTableId })
  if (error) throw new Error(error.message)
}

/** Слить счёт-источник в счёт-приёмник (source void, позиции переезжают) */
export async function mergeTableOrders(sourceId: string, targetId: string): Promise<{ target_id: string; total: number }> {
  const { data, error } = await supabase.rpc('merge_table_orders', { p_source_id: sourceId, p_target_id: targetId })
  if (error) throw new Error(error.message)
  return data as { target_id: string; total: number }
}

// ── Позиции счёта (для быстрого просмотра из зала) ────────

export interface BillLine {
  id: string
  name: string
  variant_name: string | null
  qty: number
  line_total: number
  modifiers: string[]
}

/** Активные позиции открытого счёта (voided исключены) */
export async function fetchOrderLines(orderId: string): Promise<BillLine[]> {
  const { data, error } = await supabase
    .from('order_items')
    .select('id, name, variant_name, qty, line_total, order_item_modifiers(name)')
    .eq('order_id', orderId)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
  return (data as { id: string; name: string; variant_name: string | null; qty: number; line_total: number; order_item_modifiers: { name: string }[] }[]).map((r) => ({
    id: r.id,
    name: r.name,
    variant_name: r.variant_name,
    qty: r.qty,
    line_total: r.line_total,
    modifiers: (r.order_item_modifiers ?? []).map((m) => m.name),
  }))
}

/** Скидка на существующий открытый счёт (стол). type=null — снять скидку. */
export async function setOrderDiscount(
  orderId: string,
  type: 'percent' | 'fixed' | null,
  value?: number,
  reason?: string,
): Promise<{ total: number; discount_amount: number; subtotal: number }> {
  const { data, error } = await supabase.rpc('set_order_discount', {
    p_order_id: orderId,
    p_type: type,
    p_value: value ?? null,
    p_reason: reason ?? null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return data as { total: number; discount_amount: number; subtotal: number }
}

/** Снять позицию с открытого счёта (мягкий void, аудируемо) */
export async function voidOrderItem(itemId: string, staffId: string, reason?: string): Promise<{ total: number }> {
  const { data, error } = await supabase.rpc('void_order_item', {
    p_item_id: itemId,
    p_staff_id: staffId,
    p_reason: reason ?? null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return data as { total: number }
}

// ── Состояние зала: какие столы заняты ────────────────────

export interface TableOccupancy {
  table_id: string
  order_id: string
  total: number
  daily_number: number
  opened_at: string
  staff_name: string | null
  item_count: number   // сумма qty активных позиций
}

interface OpenOrderRow {
  id: string
  table_id: string
  total: number
  daily_number: number
  created_at: string
  staff: { name: string } | null
  order_items: { qty: number; voided_at: string | null }[]
}

/** Открытые счета всех столов точки — для раскраски карты зала и инфо на карточке */
export async function fetchOpenTableOrders(): Promise<TableOccupancy[]> {
  const { data, error } = await supabase
    .from('orders')
    // staff через явный FK: после 025 у orders два FK на staff (staff_id, refunded_by)
    .select('id, table_id, total, daily_number, created_at, staff:staff!orders_staff_id_fkey(name), order_items(qty, voided_at)')
    .eq('status', 'open')
    .not('table_id', 'is', null)
  if (error) throw new Error(error.message)
  return (data as unknown as OpenOrderRow[]).map((o) => ({
    table_id: o.table_id,
    order_id: o.id,
    total: o.total,
    daily_number: o.daily_number,
    opened_at: o.created_at,
    staff_name: o.staff?.name ?? null,
    item_count: (o.order_items ?? [])
      .filter((i) => i.voided_at === null)
      .reduce((s, i) => s + i.qty, 0),
  }))
}
