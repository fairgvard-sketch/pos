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

/** Категория «Обслуживание»: режим точки и онлайн-заказы — каждый drill-down */
export default function ServiceSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const { settings } = useLocationSettings(location)
  const onlineOn = settings.online_orders?.enabled !== false

  return (
    <div className="space-y-6">
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
      </Group>
    </div>
  )
}
