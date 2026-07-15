import { useLangStore } from '../../../store/langStore'
import { t } from '../../../lib/i18n'
import { useLocationSettings } from '../useLocationSettings'
import { Group, ToggleRow } from '../ui'
import type { Location } from '../../../types'

/**
 * Категория «Интерфейс» (069): тумблеры видимости элементов POS под
 * конкретную точку/клиента (settings.interface). Касса тиражируется как
 * продукт — одним заведениям элемент нужен, другим нет, код един.
 * Новые тумблеры добавлять сюда же по образцу show_all_items_tab.
 */
export default function InterfaceSection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const { settings, update } = useLocationSettings(location)
  // Отсутствие ключа = показывать (обратная совместимость)
  const allItemsTab = settings.interface?.show_all_items_tab !== false
  const inventoryEnabled = settings.interface?.inventory_enabled !== false

  return (
    <Group>
      <ToggleRow
        label={t(lang, 'allItemsTabTitle')}
        hint={t(lang, 'allItemsTabHint')}
        checked={allItemsTab}
        onChange={(v) => update({ interface: { show_all_items_tab: v } })}
      />
      <ToggleRow
        label={t(lang, 'invEnabledTitle')}
        hint={t(lang, 'invEnabledHint')}
        checked={inventoryEnabled}
        onChange={(v) => update({ interface: { inventory_enabled: v } })}
      />
    </Group>
  )
}
