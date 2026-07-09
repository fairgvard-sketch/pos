import { useLangStore } from '../../../store/langStore'
import { t, type TranslationKey } from '../../../lib/i18n'
import { permLevel, type PermKey } from '../../../lib/perms'
import { Group, SegmentRow } from '../ui'
import { useLocationSettings } from '../useLocationSettings'
import type { Location, PermLevel } from '../../../types'

const PERM_ROWS: { key: PermKey; label: TranslationKey; hint: TranslationKey }[] = [
  { key: 'discount', label: 'permDiscount', hint: 'permDiscountHint' },
  { key: 'price_edit', label: 'permPriceEdit', hint: 'permPriceEditHint' },
  { key: 'refund', label: 'permRefund', hint: 'permRefundHint' },
  { key: 'void_order', label: 'permVoid', hint: 'permVoidHint' },
  { key: 'close_shift', label: 'permCloseShift', hint: 'permCloseShiftHint' },
]

/**
 * Деталь «Права доступа»: какие действия доступны бариста, а какие —
 * только менеджеру/владельцу. Настройка точки (036), enforcement на
 * клиенте — модель авторизации доверяет устройству.
 */
export default function PermsDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const { settings, update } = useLocationSettings(location)

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">{t(lang, 'permsPageHint')}</p>
      <Group>
        {PERM_ROWS.map((row) => (
          <SegmentRow<PermLevel>
            key={row.key}
            label={t(lang, row.label)}
            hint={t(lang, row.hint)}
            options={[
              { value: 'all', label: t(lang, 'permAll') },
              { value: 'manager', label: t(lang, 'permManager') },
            ]}
            value={permLevel(settings, row.key)}
            onChange={(v) => update({ perms: { [row.key]: v } })}
          />
        ))}
      </Group>
    </div>
  )
}
