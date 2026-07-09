import type { QueryClient } from '@tanstack/react-query'
import type { Location } from '../../types'

/**
 * Куда попадает сотрудник сразу после входа по PIN — рабочий экран,
 * а не промежуточный хаб (разделы доступны из бокового меню AppSidebar).
 * В режиме открытых счетов точка входа — зал, иначе — экран продажи.
 */
export function landingRoute(serviceMode: Location['service_mode'] | undefined): string {
  return serviceMode === 'tables' ? '/hall' : '/sell'
}

/** Посадочный маршрут по кэшу current_location (быстрый, без нового запроса) */
export function landingRouteFromCache(qc: QueryClient): string {
  const loc = qc.getQueryData<Location>(['current_location'])
  return landingRoute(loc?.service_mode)
}
