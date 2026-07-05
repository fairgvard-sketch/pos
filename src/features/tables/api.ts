import { supabase } from '../../lib/supabase'
import type { Table, TableStatus } from '../../types'

export async function fetchTables(): Promise<Table[]> {
  const { data, error } = await supabase
    .from('tables')
    .select('*, active_order:orders!orders_table_id_fkey(id, created_at, status, total, order_items(qty, menu_item:menu_items(name)))')
    .order('number')

  if (error) throw error

  return (data as any[]).map((t) => {
    const orders: any[] = t.active_order ?? []
    const active = orders.find((o) => ['new', 'cooking', 'ready'].includes(o.status))
    return { ...t, active_order: active ?? null }
  }) as Table[]
}

export async function updateTableStatus(id: string, status: TableStatus) {
  const { error } = await supabase
    .from('tables')
    .update({ status })
    .eq('id', id)

  if (error) throw error
}

export async function createTable(number: number, capacity: number, zone: string | null) {
  const { error } = await supabase
    .from('tables')
    .insert({ number, capacity, zone: zone || null })
  if (error) throw error
}

export async function updateTable(id: string, fields: { number?: number; capacity?: number; zone?: string | null }) {
  const { error } = await supabase
    .from('tables')
    .update(fields)
    .eq('id', id)
  if (error) throw error
}

export async function deleteTable(id: string) {
  const { error } = await supabase
    .from('tables')
    .delete()
    .eq('id', id)
  if (error) throw error
}
