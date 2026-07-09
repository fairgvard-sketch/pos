import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type FirstPayMethod, type QuickAmountsMode } from '../../../store/deviceStore'
import { playPaymentChime } from '../../../lib/sound'
import { t } from '../../../lib/i18n'
import { Group, NavRow, SegmentRow, SoonRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'

/** Название режима быстрых сумм для значения на строке */
function quickAmountsLabel(mode: QuickAmountsMode): 'quickAmountsSmart' | 'quickAmountsManual' | 'settingOff' {
  return mode === 'smart' ? 'quickAmountsSmart' : mode === 'manual' ? 'quickAmountsManual' : 'settingOff'
}

/** Категория «Оплата»: способ по умолчанию, быстрые суммы, звук, чаевые (drill-down) */
export default function PaymentsSection({ openDetail }: { openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const firstPayMethod = useDeviceStore((s) => s.firstPayMethod)
  const quickAmountsMode = useDeviceStore((s) => s.quickAmountsMode)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const setFirstPayMethod = useDeviceStore((s) => s.setFirstPayMethod)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)

  const soon = () => toast(t(lang, 'featureSoon'))

  return (
    <div className="space-y-6">
      <Group>
        <SegmentRow<FirstPayMethod>
          label={t(lang, 'firstPayTitle')}
          hint={t(lang, 'firstPayHint')}
          device
          options={[
            { value: 'cash', label: t(lang, 'payCash') },
            { value: 'card', label: t(lang, 'payCard') },
          ]}
          value={firstPayMethod}
          onChange={setFirstPayMethod}
        />
        <NavRow
          label={t(lang, 'quickAmountsTitle')}
          hint={t(lang, 'quickAmountsHint')}
          device
          value={t(lang, quickAmountsLabel(quickAmountsMode))}
          onClick={() => openDetail('quick-amounts')}
        />
        <ToggleRow
          label={t(lang, 'paymentSoundTitle')}
          hint={t(lang, 'paymentSoundHint')}
          device
          checked={paymentSound}
          onChange={(v) => {
            setPaymentSound(v)
            if (v) playPaymentChime() // сразу дать послушать
          }}
        />
        <NavRow
          label={t(lang, 'tipTitle')}
          device
          value={
            collectTips
              ? `${t(lang, 'settingOn')} · ${tipPresets.filter(Boolean).join('/')}%`
              : t(lang, 'settingOff')
          }
          onClick={() => openDetail('tipping')}
        />
      </Group>

      {/* Запланировано (Square-паритет): пока заглушки со статусом «Скоро» */}
      <Group title={t(lang, 'groupPlanned')}>
        <SoonRow label={t(lang, 'serviceChargeTitle')} hint={t(lang, 'serviceChargeHint')} onTap={soon} />
        <SoonRow label={t(lang, 'offlinePayTitle')} hint={t(lang, 'offlinePayHint')} onTap={soon} />
        <SoonRow label={t(lang, 'customerMgmtTitle')} hint={t(lang, 'customerMgmtHint')} onTap={soon} />
      </Group>
    </div>
  )
}
