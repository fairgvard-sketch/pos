import { supabase } from '../../lib/supabase'
import type { Staff } from '../../types'

/**
 * Чтение списка сотрудников — для фильтров (Транзакции) и чек-листа
 * запуска. Управление сотрудниками (создание, PIN, роли, права)
 * переехало в веб-кабинет ANGLE; pin_hash на клиент не приходит
 * (колоночные гранты).
 */
export async function fetchStaffList(): Promise<Staff[]> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, org_id, location_id, name, role, is_active, created_at')
    .order('created_at')
  if (error) throw new Error(error.message)
  return data as Staff[]
}
