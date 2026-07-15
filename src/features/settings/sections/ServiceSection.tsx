import { useLangStore } from '../../../store/langStore'
import { t, type TranslationKey } from '../../../lib/i18n'
import { useLocationSettings } from '../useLocationSettings'
import { Group, NavRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location, ServiceMode } from '../../../types'

/** Название текущего режима обслуживания — для значения на строке */
function modeLabel(mode: ServiceMode | undefined): TranslationKey {
  return mode === 'tables' ? 'modeTables' : mode === 'counter_tables' ? 'modeCounterTables' : 'modeCounter'
}

/**
 * Категория «Обслуживание»: режим точки, онлайн-заказы и брони — каждый
 * drill-down (ServiceModeDetail / OnlineOrdersDetail / ReservationsDetail).
 * Строка «Брони» (053) — только в режиме столов (там они осмысленны).
 * План зала (070) переехал в «Интерфейс».
 */
export default function ServiceSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const { settings } = useLocationSettings(location)
  const onlineOn = settings.online_orders?.enabled !== false
  // Отсутствие ключа = ВЫКЛЮЧЕНО (в отличие от online_orders)
  const reserveOn = settings.reservations?.enabled === true
  const tablesMode = location?.service_mode === 'tables'

  return (
    <Group>
      <NavRow
        label={t(lang, 'serviceModeTitle')}
        hint={t(lang, 'serviceModeHint')}
        value={t(lang, modeLabel(location?.service_mode))}
        onClick={() => openDetail('service-mode')}
      />
      <NavRow
        label={t(lang, 'onlineOrders')}
        hint={t(lang, 'onlineSettingsToggleHint')}
        value={t(lang, onlineOn ? 'settingOn' : 'settingOff')}
        onClick={() => openDetail('online-orders')}
      />
      {tablesMode && (
        <NavRow
          label={t(lang, 'reservationsTitle')}
          hint={t(lang, 'reservationsToggleHint')}
          value={t(lang, reserveOn ? 'settingOn' : 'settingOff')}
          onClick={() => openDetail('reservations')}
        />
      )}
    </Group>
  )
}
