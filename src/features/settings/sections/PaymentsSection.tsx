import { useState } from 'react'
import toast from 'react-hot-toast'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type QuickAmountsMode } from '../../../store/deviceStore'
import { playPaymentChime } from '../../../lib/sound'
import { t } from '../../../lib/i18n'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from '../../../lib/offline/outboxStore'
import OfflineOpsSheet from '../../offline/OfflineOpsSheet'
import { Group, NavRow, SoonRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'

/** Название режима быстрых сумм для значения на строке */
function quickAmountsLabel(mode: QuickAmountsMode): 'quickAmountsSmart' | 'quickAmountsManual' | 'settingOff' {
  return mode === 'smart' ? 'quickAmountsSmart' : mode === 'manual' ? 'quickAmountsManual' : 'settingOff'
}

/** Категория «Оплата»: способы оплаты, быстрые суммы, звук, чаевые (drill-down) */
export default function PaymentsSection({ openDetail }: { openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const quickAmountsMode = useDeviceStore((s) => s.quickAmountsMode)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)

  const soon = () => toast(t(lang, 'featureSoon'))
  const methodsLabel = payMethodOrder.map((m) => t(lang, m === 'cash' ? 'payCash' : 'payCard')).join(' · ')

  // Офлайн-очередь (фаза 7) — живой статус вместо заглушки «Скоро»
  const ops = useOutboxStore((s) => s.ops)
  const [showOps, setShowOps] = useState(false)
  const pending = pendingOpsCount({ ops })
  const failed = hasFailedOps({ ops })
  const offlineValue = failed
    ? t(lang, 'offlineAttention')
    : pending > 0
      ? `${t(lang, 'offlineSyncing')} · ${pending}`
      : t(lang, 'settingOn')

  return (
    <div className="space-y-6">
      <Group>
        <NavRow
          label={t(lang, 'payMethodsTitle')}
          hint={t(lang, 'payMethodsHint')}
          device
          value={methodsLabel}
          onClick={() => openDetail('pay-methods')}
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

      {/* Офлайн-очередь (фаза 7): работает, тап открывает журнал операций */}
      <Group>
        <NavRow
          label={t(lang, 'offlinePayTitle')}
          hint={t(lang, 'offlinePayHint')}
          value={offlineValue}
          onClick={() => setShowOps(true)}
        />
      </Group>

      {/* Запланировано (Square-паритет): пока заглушки со статусом «Скоро» */}
      <Group title={t(lang, 'groupPlanned')}>
        <SoonRow label={t(lang, 'serviceChargeTitle')} hint={t(lang, 'serviceChargeHint')} onTap={soon} />
        <SoonRow label={t(lang, 'customerMgmtTitle')} hint={t(lang, 'customerMgmtHint')} onTap={soon} />
      </Group>

      {showOps && <OfflineOpsSheet onClose={() => setShowOps(false)} />}
    </div>
  )
}
