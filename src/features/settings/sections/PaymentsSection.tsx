import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type FirstPayMethod } from '../../../store/deviceStore'
import { playPaymentChime } from '../../../lib/sound'
import { t } from '../../../lib/i18n'
import { Group, NavRow, SegmentRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'

/** Категория «Оплата»: способ по умолчанию, звук, чаевые (drill-down) */
export default function PaymentsSection({ openDetail }: { openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const firstPayMethod = useDeviceStore((s) => s.firstPayMethod)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const setFirstPayMethod = useDeviceStore((s) => s.setFirstPayMethod)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)

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
    </div>
  )
}
