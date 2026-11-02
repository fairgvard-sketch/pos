/**
 * Кто выпустил программу — поля A000 1006–1010, одинаковые для всех
 * бизнесов: это реквизиты производителя Kassa, а не кафе-клиента
 * (до 02.11.2026 сюда по ошибке писались ח.פ и название самого бизнеса).
 *
 * Номер производителя — личный/регистрационный номер владельца ANGLE,
 * поэтому в репозиторий он не попадает: приходит из секрета Edge Function
 * `UF_VENDOR_TAX_ID`. Номер свидетельства регистрации — секрет
 * `UF_SOFTWARE_REGISTRATION`; пока свидетельства нет, пишется
 * `NO_REGISTRATION_CERTIFICATE` (99999999).
 */

import { NO_REGISTRATION_CERTIFICATE } from './build.ts'

export const SOFTWARE_NAME = 'Kassa'
/** Версия модуля выгрузки (поле 1008); поднимается при изменении формата. */
export const SOFTWARE_VERSION = '1.2.1'
export const VENDOR_NAME = 'ANGLE'

export interface SoftwareIdentity {
  softwareRegistration: number
  softwareName: string
  softwareVersion: string
  vendorTaxId: number
  vendorName: string
}

/** Реквизиты производителя из окружения; без номера производителя — ошибка. */
export function softwareIdentity(getEnv: (key: string) => string | undefined): SoftwareIdentity {
  const vendor = (getEnv('UF_VENDOR_TAX_ID') ?? '').replace(/\D/g, '')
  if (vendor.length === 0 || vendor.length > 9 || Number(vendor) === 0) {
    throw new Error('uf_missing_vendor_tax_id')
  }
  const registration = (getEnv('UF_SOFTWARE_REGISTRATION') ?? '').replace(/\D/g, '')
  if (registration.length > 8) throw new Error('uf_bad_software_registration')
  return {
    softwareRegistration: Number(registration) || NO_REGISTRATION_CERTIFICATE,
    softwareName: SOFTWARE_NAME,
    softwareVersion: SOFTWARE_VERSION,
    vendorTaxId: Number(vendor),
    vendorName: VENDOR_NAME,
  }
}
