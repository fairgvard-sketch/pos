import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { updateVatRate } from '../../auth/api'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type QuickAmountsMode } from '../../../store/deviceStore'
import { playPaymentChime } from '../../../lib/sound'
import { t } from '../../../lib/i18n'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from '../../../lib/offline/outboxStore'
import OfflineOpsSheet from '../../offline/OfflineOpsSheet'
import { Group, InputRow, NavRow, SoonRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location } from '../../../types'

/** Название режима быстрых сумм для значения на строке */
function quickAmountsLabel(mode: QuickAmountsMode): 'quickAmountsSmart' | 'quickAmountsManual' | 'settingOff' {
  return mode === 'smart' ? 'quickAmountsSmart' : mode === 'manual' ? 'quickAmountsManual' : 'settingOff'
}

/** Категория «Оплата»: способы оплаты, быстрые суммы, звук, чаевые (drill-down), НДС */
export default function PaymentsSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const quickAmountsMode = useDeviceStore((s) => s.quickAmountsMode)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const setPaymentSound = useDeviceStore((s) => s.setPaymentSound)

  const soon = () => toast(t(lang, 'featureSoon'))
  const methodsLabel = payMethodOrder.map((m) => t(lang, m === 'cash' ? 'payCash' : 'payCard')).join(' · ')
  const loyaltyMode = location?.loyalty_mode ?? 'off'

  // НДС точки — настройка уровня заведения (не устройства). Синхронизация
  // с точкой при её появлении/смене — сравнением с прошлым location в рендере:
  const [vat, setVat] = useState('')
  const [prevLoc, setPrevLoc] = useState(location)
  if (location && location !== prevLoc) {
    setPrevLoc(location)
    setVat(String(Number(location.vat_rate)))
  }

  const vatNum = Number(vat.replace(',', '.'))
  const vatValid = vat.trim() !== '' && Number.isFinite(vatNum) && vatNum >= 0 && vatNum <= 50

  const saveVat = useMutation({
    mutationFn: () => updateVatRate(vatNum),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['current_location'] }); toast.success(t(lang, 'saved')) },
    onError: (e) => toast.error(e.message),
  })

  function commitVat() {
    if (!vatValid) {
      setVat(location ? String(Number(location.vat_rate)) : '')
      return
    }
    if (Number(location?.vat_rate) !== vatNum) saveVat.mutate()
  }

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
        <NavRow
          label={t(lang, 'loyaltyTitle')}
          hint={t(lang, 'loyaltyHint')}
          value={t(
            lang,
            loyaltyMode === 'stamps' ? 'loyaltyModeStamps' : loyaltyMode === 'points' ? 'loyaltyModePoints' : 'loyaltyModeOff',
          )}
          onClick={() => openDetail('loyalty')}
        />
      </Group>

      {/* НДС — уровень заведения, применяется к новым заказам */}
      <Group>
        <InputRow label={t(lang, 'vatRateTitle')} hint={t(lang, 'vatRateHint')}>
          <div className="relative">
            <input
              className="input !w-24 text-center tabular-nums pe-6"
              inputMode="decimal"
              value={vat}
              onChange={(e) => setVat(e.target.value)}
              onBlur={commitVat}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">%</span>
          </div>
        </InputRow>
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
