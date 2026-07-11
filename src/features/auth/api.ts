import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'
import type { Location, LocationSettings, ServiceMode, StaffSession } from '../../types'

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

/**
 * Запись полей точки — через RPC update_location_config (044): сервер
 * проверяет manager-сессию, прямой UPDATE locations закрывает 045.
 */
async function updateLocationConfig(patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('update_location_config', {
    p_patch: patch,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/** Сменить режим обслуживания точки */
export async function updateServiceMode(mode: ServiceMode): Promise<void> {
  await updateLocationConfig({ service_mode: mode })
}

/** Профиль заведения (052): имя точки, отображаемое имя (settings.display_name), логотип */
export async function updateLocationProfile(patch: {
  name?: string
  receipt_business_name?: string | null
  logo_url?: string | null
  settings?: LocationSettings
}): Promise<void> {
  await updateLocationConfig(patch)
}

/** Реквизиты для чека */
export interface ReceiptDetails {
  receipt_business_name: string | null
  receipt_address: string | null
  receipt_tax_id: string | null
  receipt_phone: string | null
  receipt_footer: string | null
}

/** Сохранить реквизиты заведения для чека */
export async function updateReceiptDetails(details: ReceiptDetails): Promise<void> {
  await updateLocationConfig({
    receipt_business_name: details.receipt_business_name || null,
    receipt_address: details.receipt_address || null,
    receipt_tax_id: details.receipt_tax_id || null,
    receipt_phone: details.receipt_phone || null,
    receipt_footer: details.receipt_footer || null,
  })
}

/**
 * Сохранить мелкие настройки точки (locations.settings, 036).
 * Пишем ЦЕЛИКОМ смерженный объект: вызывающий берёт текущие settings
 * из кеша current_location и накладывает свой раздел (perms/receipt/shift).
 */
export async function updateLocationSettings(settings: LocationSettings): Promise<void> {
  await updateLocationConfig({ settings })
}

/** Сменить ставку НДС точки. Снапшот в заказ делает сервер (place_order) —
 *  меняются только будущие заказы, пробитые не трогаем (аудит). */
export async function updateVatRate(rate: number): Promise<void> {
  await updateLocationConfig({ vat_rate: rate })
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
  ownerPin: string,
  businessAddress?: string
) {
  // Реквизиты чека (название/адрес) сеет сам bootstrap_org (044):
  // staff-сессии в онбординге ещё нет, а прямой UPDATE locations закрыт 045.
  const { error } = await supabase.rpc('bootstrap_org', {
    p_org_name: orgName,
    p_location_name: locationName,
    p_owner_name: ownerName,
    p_owner_pin: ownerPin,
    p_business_address: businessAddress?.trim() || null,
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

/**
 * Сменить пароль аккаунта устройства (email+пароль Supabase Auth).
 * Это пароль ВХОДА УСТРОЙСТВА, не PIN сотрудника. Supabase требует
 * активную сессию — меняем «на месте», без старого пароля.
 */
export async function updateDevicePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(error.message)
}
