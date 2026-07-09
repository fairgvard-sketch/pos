import { useLangStore } from '../../../store/langStore'
import { useDeviceStore, type QuickAmountsMode } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { Group, SegmentRow } from '../ui'

/**
 * Деталь «Быстрые суммы» (Square: Quick amounts) — настройки этой кассы:
 * при оплате наличными касса предлагает кнопки-номиналы для расчёта сдачи.
 *  smart  — авто по сумме заказа (округления вверх)
 *  manual — свои фиксированные суммы (до 3)
 *  off    — только «Без сдачи»
 */
export default function QuickAmountsDetail() {
  const lang = useLangStore((s) => s.lang)
  const mode = useDeviceStore((s) => s.quickAmountsMode)
  const manual = useDeviceStore((s) => s.quickAmountsManual)
  const setMode = useDeviceStore((s) => s.setQuickAmountsMode)
  const setManual = useDeviceStore((s) => s.setQuickAmountsManual)

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">{t(lang, 'quickAmountsPageHint')}</p>

      <Group>
        <SegmentRow<QuickAmountsMode>
          label={t(lang, 'quickAmountsTitle')}
          device
          options={[
            { value: 'smart', label: t(lang, 'quickAmountsSmart') },
            { value: 'manual', label: t(lang, 'quickAmountsManual') },
            { value: 'off', label: t(lang, 'settingOff') },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Group>

      {mode === 'smart' && (
        <p className="text-sm text-gray-500 px-1">{t(lang, 'quickAmountsSmartHint')}</p>
      )}

      {mode === 'manual' && (
        <Group title={t(lang, 'quickAmountsManualLabel')}>
          <div className="px-4 py-3 flex items-center gap-2">
            {manual.map((a, i) => (
              <div key={i} className="relative">
                <input
                  className="input !w-24 text-center tabular-nums pe-6"
                  inputMode="numeric"
                  value={a / 100 || ''}
                  onChange={(e) => {
                    const v = Math.max(0, parseInt(e.target.value, 10) || 0)
                    setManual(manual.map((x, j) => (j === i ? v * 100 : x)))
                  }}
                />
                <span className="absolute end-2.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₪</span>
              </div>
            ))}
          </div>
        </Group>
      )}
    </div>
  )
}
