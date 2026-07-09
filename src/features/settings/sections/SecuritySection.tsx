import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { Group, SegmentRow, ToggleRow } from '../ui'

/** Варианты автоблокировки (сек); 0 = выключена */
const AUTOLOCK_OPTIONS = [0, 30, 60, 300, 900]

function lockLabel(sec: number, lang: 'ru' | 'he'): string {
  if (sec === 0) return t(lang, 'autoLockOff')
  if (sec < 60) return `${sec} ${t(lang, 'secShort')}`
  return `${sec / 60} ${t(lang, 'minShort')}`
}

/** Категория «Безопасность»: автоблокировка + PIN после продажи (эта касса) */
export default function SecuritySection() {
  const lang = useLangStore((s) => s.lang)
  const autoLockSec = useDeviceStore((s) => s.autoLockSec)
  const lockAfterSale = useDeviceStore((s) => s.lockAfterSale)
  const setAutoLockSec = useDeviceStore((s) => s.setAutoLockSec)
  const setLockAfterSale = useDeviceStore((s) => s.setLockAfterSale)

  return (
    <div className="space-y-6">
      <Group>
        <SegmentRow<number>
          label={t(lang, 'autoLock')}
          hint={t(lang, 'autoLockHint')}
          device
          options={AUTOLOCK_OPTIONS.map((sec) => ({ value: sec, label: lockLabel(sec, lang) }))}
          value={autoLockSec}
          onChange={setAutoLockSec}
        />
        <ToggleRow
          label={t(lang, 'lockAfterSale')}
          hint={t(lang, 'lockAfterSaleHint')}
          device
          checked={lockAfterSale}
          onChange={setLockAfterSale}
        />
      </Group>
    </div>
  )
}
