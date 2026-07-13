import type { QueryClient } from '@tanstack/react-query'
import type { Location } from '../../types'
import { useDeviceStore } from '../../store/deviceStore'

const SCREEN_ROUTE = { sell: '/sell', hall: '/hall', queue: '/queue' } as const

/**
 * Куда попадает сотрудник сразу после входа по PIN — рабочий экран,
 * а не промежуточный хаб (разделы доступны из бокового меню AppSidebar).
 *
 * Приоритет: per-device стартовый экран (P5), если он валиден для режима
 * точки; иначе — по режиму (открытые счета → зал, иначе продажа). Зал как
 * стартовый доступен только когда точка работает со столами.
 */
export function landingRoute(serviceMode: Location['service_mode'] | undefined): string {
  const start = useDeviceStore.getState().startScreen
  // Дефолт по режиму — как было: открытые счета → зал, иначе продажа
  const byMode = serviceMode === 'tables' ? '/hall' : '/sell'
  // 'hall' как стартовый доступен только когда точка со столами
  if (start === 'hall' && serviceMode !== 'tables') return byMode
  if (start && SCREEN_ROUTE[start]) return SCREEN_ROUTE[start]
  return byMode
}

/** Посадочный маршрут по кэшу current_location (быстрый, без нового запроса) */
export function landingRouteFromCache(qc: QueryClient): string {
  const loc = qc.getQueryData<Location>(['current_location'])
  return landingRoute(loc?.service_mode)
}
