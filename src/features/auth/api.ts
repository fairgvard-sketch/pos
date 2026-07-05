import { supabase } from '../../lib/supabase'
import type { Staff } from '../../types'

export async function loginByPin(pin: string): Promise<Staff> {
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('pin_code', pin)
    .single()

  if (error || !data) {
    throw new Error('Неверный PIN-код')
  }

  // Set session variables for RLS
  await supabase.rpc('set_staff_context', {
    p_staff_id: data.id,
    p_staff_role: data.role,
  })

  return data as Staff
}
