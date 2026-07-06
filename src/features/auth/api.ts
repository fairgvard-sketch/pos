import { supabase } from '../../lib/supabase'
import type { Location, ServiceMode, StaffSession } from '../../types'

export interface DeviceContext {
  orgId: string | null
  locationId: string | null
}

/** org_id/location_id из app_metadata текущей сессии (null = нет сессии / не онбордились) */
export async function getDeviceContext(): Promise<DeviceContext | null> {
  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (!session) return null
  const meta = session.user.app_metadata as Record<string, string | undefined>
  return {
    orgId: meta.org_id ?? null,
    locationId: meta.location_id ?? null,
  }
}

/** Текущая точка устройства (service_mode, ставка НДС и пр.). RLS скоупит по org. */
export async function fetchCurrentLocation(): Promise<Location> {
  const ctx = await getDeviceContext()
  if (!ctx?.locationId) throw new Error('Device not bootstrapped')
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('id', ctx.locationId)
    .single()
  if (error) throw new Error(error.message)
  return data as Location
}

/** Сменить режим обслуживания точки. RLS (locations_all) допускает UPDATE в своей org. */
export async function updateServiceMode(mode: ServiceMode): Promise<void> {
  const ctx = await getDeviceContext()
  if (!ctx?.locationId) throw new Error('Device not bootstrapped')
  const { error } = await supabase
    .from('locations')
    .update({ service_mode: mode })
    .eq('id', ctx.locationId)
  if (error) throw new Error(error.message)
}

export async function signInDevice(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
}

export async function signUpDevice(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw new Error(error.message)
  // Если в Supabase включено подтверждение email — сессии ещё нет
  if (!data.session) {
    throw new Error('confirm-email')
  }
}

export async function bootstrapOrg(
  orgName: string,
  locationName: string,
  ownerName: string,
  ownerPin: string
) {
  const { error } = await supabase.rpc('bootstrap_org', {
    p_org_name: orgName,
    p_location_name: locationName,
    p_owner_name: ownerName,
    p_owner_pin: ownerPin,
  })
  if (error) throw new Error(error.message)
  // app_metadata изменилась на сервере — перевыпускаем JWT,
  // иначе RLS не увидит org_id до истечения старого токена
  const { error: refreshError } = await supabase.auth.refreshSession()
  if (refreshError) throw new Error(refreshError.message)
}

export async function verifyStaffPin(pin: string): Promise<StaffSession> {
  const { data, error } = await supabase.rpc('verify_staff_pin', { p_pin: pin })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('wrong-pin')
  return row as StaffSession
}

export async function signOutDevice() {
  await supabase.auth.signOut()
}
