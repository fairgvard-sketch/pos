import { supabase } from '../../lib/supabase'
import type { Role, Staff } from '../../types'

/**
 * Управление сотрудниками. БД-слой готов с фазы 1 (001_foundation.sql):
 * - создание/смена PIN — только через SECURITY DEFINER RPC (bcrypt в БД),
 *   pin_hash на клиент не приходит (колоночные гранты);
 * - UPDATE разрешён только по name/role/location_id/is_active;
 * - деактивация вместо удаления — верифицируется в verify_staff_pin().
 * Ролевое ограничение (кто кого может править) — на клиенте, в StaffTab
 * (известный компромисс модели авторизации: БД доверяет устройству).
 */

export async function fetchStaffList(): Promise<Staff[]> {
  const { data, error } = await supabase
    .from('staff')
    .select('id, org_id, location_id, name, role, is_active, created_at')
    .order('created_at')
  if (error) throw new Error(error.message)
  return data as Staff[]
}

/** PIN валиден: 4–8 цифр (то же правило, что в create_staff/set_staff_pin) */
export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin)
}

export async function createStaffMember(name: string, role: Role, pin: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_staff', {
    p_name: name,
    p_role: role,
    p_pin: pin,
  })
  if (error) throw new Error(error.message)
  return data as string
}

export async function setStaffPin(staffId: string, pin: string): Promise<void> {
  const { error } = await supabase.rpc('set_staff_pin', { p_staff_id: staffId, p_pin: pin })
  if (error) throw new Error(error.message)
}

export async function updateStaffMember(
  staffId: string,
  patch: Partial<Pick<Staff, 'name' | 'role' | 'is_active'>>
): Promise<void> {
  const { error } = await supabase.from('staff').update(patch).eq('id', staffId)
  if (error) throw new Error(error.message)
}

/**
 * Удалить сотрудника (умное удаление, 040): проходит только если он
 * никогда ничего не пробивал. Иначе сервер вернёт 'staff has records' —
 * тогда предлагаем деактивацию. Флаг hasRecords в ошибке для UI.
 */
export async function deleteStaffMember(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_staff', { p_staff_id: staffId })
  if (error) {
    if (error.message.includes('staff has records')) {
      const e = new Error('staff has records') as Error & { hasRecords?: boolean }
      e.hasRecords = true
      throw e
    }
    throw new Error(error.message)
  }
}
